/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readSubagentMetadata, rehydrateAgent, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import type { AgentInvocation, AgentRecord, IsolationMode, SubagentSessionConfig, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Resolve a Model from a snapshot's `resolvedModelKey` ("provider/modelId")
 * using the parent session's model registry. Returns undefined when the model
 * is no longer available (or the registry is missing) — `runAgent` then falls
 * back to the agent config / parent model via `resolveDefaultModel`, same as
 * a fresh spawn.
 */
function resolveModelFromSnapshot(
  ctx: ExtensionContext,
  snapshot: { resolvedModelKey?: string } | undefined,
): Model<any> | undefined {
  const key = snapshot?.resolvedModelKey;
  if (!key) return undefined;
  const slash = key.indexOf("/");
  if (slash === -1) return undefined;
  const provider = key.slice(0, slash);
  const modelId = key.slice(slash + 1);
  const registry = (ctx as { modelRegistry?: { find?: (provider: string, modelId: string) => Model<any> | undefined } }).modelRegistry;
  return registry?.find?.(provider, modelId);
}

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /**
   * Directory for the persisted pi-format session JSONL. When set, the session
   * is written to disk and can be rehydrated later by `resume()`. The
   * directory is created if missing. When omitted, the session is in-memory.
   */
  sessionDir?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
}

/**
 * A disk-persisted subagent session available for resume without a live
 * `AgentRecord`. Populated by `loadResumable` from a `discoverSubagentSessions`
 * scan on session_start, surfaced in the `/agents` menu and the widget's
 * "stopped" section, and promoted to a live record (then removed from the
 * registry) by `resumeFromDisk`.
 */
export interface ResumableEntry {
  /** Filesystem path of the JSONL — unique registry key (can't collide with
   *  in-memory agent ids, which are UUID prefixes). */
  sessionFilePath: string;
  /** Persisted agent id if the JSONL carried one (new files); undefined for
   *  JSONLs predating id persistence. */
  id?: string;
  metadata: SubagentSessionConfig;
  /** Truncated original prompt, same shape as `AgentRecord.description`. */
  description: string;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  /** Disk-persisted sessions available for resume, keyed by JSONL path.
   *  Populated by `loadResumable` on session_start; drained by `resumeFromDisk`. */
  private resumable = new Map<string, ResumableEntry>();
  /** JSONL paths with an in-flight `resumeFromDisk` — guards against concurrent
   *  resumes of the same file racing past the `agents.has()` check. */
  private resumingFiles = new Set<string>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      originalPrompt: prompt,
      invocation: options.invocation,
    };
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    if (options.isolation === "worktree") {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
    }

    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;

    // Capture the spawn-time config so resume() can rehydrate the session later
    // after the in-memory reference is cleaned up. `cwd` and `configCwd` are
    // resolved post-worktree (worktreeCwd / customCwd) to match exactly what
    // runAgent receives.
    record.configSnapshot = {
      resolvedModelKey: options.model ? `${options.model.provider}/${options.model.id}` : undefined,
      thinkingLevel: options.thinkingLevel,
      isolated: options.isolated,
      cwd: worktreeCwd ?? customCwd,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
    };
    this.onStart?.(record);

    // Wire parent abort signal to stop the subagent when the parent is interrupted
    let detachParentSignal: (() => void) | undefined;
    if (options.signal) {
      const onParentAbort = () => this.abort(id);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
    }
    const detach = () => { detachParentSignal?.(); detachParentSignal = undefined; };

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
      sessionDir: options.sessionDir,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Capture the persisted session file path for rehydration. Only set
        // when the session is persisted (sessionDir was supplied via runAgent
        // options); in-memory sessions return undefined here.
        record.sessionFilePath = session.sessionFile;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
        }
        record.result = responseText;
        record.session = session;
        // Fallback capture of sessionFilePath for callers (e.g. mocked tests,
        // or any future code path) that don't fire onSessionCreated. The
        // primary capture happens in the onSessionCreated callback below —
        // this `??=` is a no-op when that already ran. Important for resume()
        // rehydration, which keys off sessionFilePath.
        record.sessionFilePath ??= session?.sessionFile;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            // With a caller-supplied cwd the branch lives in THAT repo, not the
            // parent session's — say so, or the orchestrator merges in the wrong repo.
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }

        if (options.isBackground) {
          this.runningBackground--;
          try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        if (options.isBackground) {
          this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        this.startAgent(next.id, record, next.args);
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        this.onComplete?.(record);
      }
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   *
   * Two paths:
   *   1. Fast: the live `AgentSession` is still in memory — prompt it directly.
   *   2. Slow: the in-memory session was cleaned up (10-min timer or
   *      clearCompleted), but the persisted JSONL is still on disk. Rehydrate
   *      via `rehydrateAgent()` — needs `ctx` + `pi` so the agent config can be
   *      reconstructed (loader, tools, prompt, model). If neither path applies,
   *      returns undefined.
   */
  async resume(
    id: string,
    prompt: string,
    options: {
      ctx?: ExtensionContext;
      pi?: ExtensionAPI;
      signal?: AbortSignal;
    } = {},
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record) return undefined;

    // Slow path: rehydrate from disk before resuming.
    if (!record.session && record.sessionFilePath && record.type) {
      const { ctx, pi } = options;
      if (!ctx || !pi) {
        // Caller didn't pass rehydration context — can't rebuild the session.
        return undefined;
      }
      try {
        const model = resolveModelFromSnapshot(ctx, record.configSnapshot);
        const session = await rehydrateAgent(ctx, record.type, record.sessionFilePath, {
          pi,
          agentId: id,
          model,
          thinkingLevel: record.configSnapshot?.thinkingLevel,
          isolated: record.configSnapshot?.isolated,
          cwd: record.configSnapshot?.cwd,
          configCwd: record.configSnapshot?.configCwd,
        });
        record.session = session;
      } catch (err) {
        record.status = "error";
        record.error = `Failed to resume from disk: ${err instanceof Error ? err.message : String(err)}`;
        record.completedAt = Date.now();
        return record;
      }
    }

    if (!record.session) return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    try {
      const responseText = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
        },
        signal: options.signal,
        originalPrompt: record.originalPrompt,
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  /**
   * Resume a subagent session purely from its persisted JSONL — no live
   * `AgentRecord` required. This is the disk-only counterpart to `resume()`,
   * usable after the in-memory map was cleared (cleanup timer, `clearCompleted()`,
   * or a fresh process) as long as the session file is still on disk.
   *
   * Rehydration metadata (`type`, `originalPrompt`, `configSnapshot`, and —
   * since id persistence — `id`) is read from the `subagent:config` entry
   * embedded in the JSONL, so no sidecar map file is needed. Returns
   * `undefined` when the file has no such entry (old JSONL or non-subagent
   * file) or when `ctx`/`pi` are missing.
   *
   * Id continuity keeps a disk-resumed agent "one and the same" as the
   * original rather than a parallel row:
   *   - If `meta.id` matches a record still live in the map (cleanup hasn't
   *     evicted it yet), delegate to `resume()` — that mutates the existing
   *     record in place and preserves its accumulated history (toolUses,
   *     lifetimeUsage, compactionCount, prior result).
   *   - Otherwise rebuild a fresh record, but registered under `meta.id`
   *     (falling back to a minted id only for JSONLs predating id
   *     persistence). The id is re-written to disk via `persistConfig`, so
   *     subsequent cold resumes land on this same record.
   */
  async resumeFromDisk(
    sessionFilePath: string,
    prompt: string,
    options: { ctx: ExtensionContext; pi: ExtensionAPI; signal?: AbortSignal },
  ): Promise<AgentRecord | undefined> {
    // Concurrent resumes of the same file would race past the agents.has()
    // check in the inner method and mint two records. Reject the second
    // caller outright (design choice: reject beats queue for a user-driven
    // resume action).
    if (this.resumingFiles.has(sessionFilePath)) {
      throw new Error("Already resuming this session; wait for the in-flight resume to finish.");
    }
    this.resumingFiles.add(sessionFilePath);
    // Promote out of the resumable registry now — the file is being adopted
    // into a live record (or delegated to an existing one), so it must not
    // also show up as "stopped/resumable" in the widget or /agents menu.
    this.resumable.delete(sessionFilePath);
    try {
      return await this.resumeFromDiskInner(sessionFilePath, prompt, options);
    } finally {
      this.resumingFiles.delete(sessionFilePath);
    }
  }

  /** Disk-resume implementation. Guarded by the public `resumeFromDisk`
   *  wrapper above (in-flight dedup + registry eviction). */
  private async resumeFromDiskInner(
    sessionFilePath: string,
    prompt: string,
    options: { ctx: ExtensionContext; pi: ExtensionAPI; signal?: AbortSignal },
  ): Promise<AgentRecord | undefined> {
    const { ctx, pi } = options;

    const meta = await readSubagentMetadata(sessionFilePath);
    if (!meta) return undefined;

    // Fast path: the persisted id matches a record still in the map (cleanup
    // hasn't evicted it). Delegate to resume() so the existing record is
    // mutated in place and its history is preserved — no parallel row.
    // `resume()` handles both the live-session and rehydrate-from-disk cases.
    if (meta.id && this.agents.has(meta.id)) {
      return this.resume(meta.id, prompt, options);
    }

    // Reuse the persisted id when present so future resume(id) /
    // resumeFromDisk() calls target this same record. Only mint a fresh id
    // for JSONLs predating id persistence (old files have no `id` field).
    const id = meta.id ?? randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type: meta.type,
      description: meta.originalPrompt.slice(0, 80),
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      originalPrompt: meta.originalPrompt,
      configSnapshot: meta.configSnapshot,
      sessionFilePath,
    };
    this.agents.set(id, record);

    let session: AgentSession;
    try {
      const model = resolveModelFromSnapshot(ctx, meta.configSnapshot);
      // Re-write the `subagent:config` entry so metadata stays current on
      // disk (latest-wins on read). Carries `id` forward — and for the
      // fallback-minted case, persists it so the next cold resume reuses it.
      const persistConfig = { ...meta, id };
      session = await rehydrateAgent(ctx, meta.type, sessionFilePath, {
        pi,
        agentId: id,
        model,
        thinkingLevel: meta.configSnapshot?.thinkingLevel,
        isolated: meta.configSnapshot?.isolated,
        cwd: meta.configSnapshot?.cwd,
        configCwd: meta.configSnapshot?.configCwd,
        persistConfig,
      });
      record.session = session;
    } catch (err) {
      record.status = "error";
      record.error = `Failed to resume from disk: ${err instanceof Error ? err.message : String(err)}`;
      record.completedAt = Date.now();
      return record;
    }

    try {
      const responseText = await resumeAgent(session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
        },
        signal: options.signal,
        originalPrompt: record.originalPrompt,
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  /**
   * Rebuild the resumable-session registry from a disk scan (typically
   * `discoverSubagentSessions` on session_start). Replaces the registry
   * wholesale. Entries whose `metadata.id` is already live in memory are
   * skipped — they surface via `listAgents()`, not here, so a running agent
   * can't also appear as "stopped/resumable".
   */
  loadResumable(entries: Array<{ sessionFilePath: string; metadata: SubagentSessionConfig }>): void {
    this.resumable.clear();
    for (const { sessionFilePath, metadata } of entries) {
      if (metadata.id && this.agents.has(metadata.id)) continue;
      this.resumable.set(sessionFilePath, {
        sessionFilePath,
        id: metadata.id,
        metadata,
        description: metadata.originalPrompt.slice(0, 80),
      });
    }
  }

  /** Empty the resumable registry (e.g. on session teardown). */
  clearResumable(): void {
    this.resumable.clear();
  }

  /** All disk-persisted sessions currently available for resume. */
  listResumable(): ResumableEntry[] {
    return [...this.resumable.values()];
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /**
   * Dispose a record's in-memory session and remove the record from the map.
   *
   * IMPORTANT: this does NOT delete the persisted JSONL on disk. `dispose()` is
   * purely in-memory cleanup (aborts, unsubscribes, invalidates extension ctx).
   * The session file at `record.sessionFilePath` stays behind so a later
   * `resume()` can rehydrate from it. This is the key behavior change vs. the
   * pre-persistence era: cleanup used to be destructive because there was no
   * on-disk state to preserve.
   */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist
   * *in memory* — but persisted JSONLs stay on disk for later rehydration.
   */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
