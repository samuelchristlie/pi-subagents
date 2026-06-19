import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  rehydrateAgent: vi.fn(),
  readSubagentMetadata: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete is not called for foreground agents", async () => {
    let onCompleteCalled = false;
    manager = new AgentManager(() => {
      onCompleteCalled = true;
    });
    resolvedRun();

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(onCompleteCalled).toBe(false);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return "second";
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd + isolation: worktree — worktree created FROM cwd, session runs at the copy's workPath, cleanup targets cwd's repo", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/packages/api",
    });
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    expect(createWorktree).toHaveBeenCalledWith("/", id);
    // Worktree wins for the working dir — at workPath, so subdirectory scoping
    // survives isolation. Config still anchored to the parent.
    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/wt/copy/packages/api", configCwd: "/tmp" }),
    );
    expect(cleanupWorktree).toHaveBeenCalledWith("/", expect.anything(), "test");
  });

  it("plain worktree (no cwd) keeps the historical root working dir even when workPath differs", async () => {
    // Parent session sitting in a repo subdirectory: workPath would point at
    // the copied subdir. Without SpawnOptions.cwd the agent must stay at the
    // copy's root — moving it would also move .pi config discovery.
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({
      path: "/wt/copy", branch: "pi-agent-x", baseSha: "abc", workPath: "/wt/copy/sub/dir",
    });
    vi.mocked(runAgent).mockClear();
    resolvedRun();

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBe("/wt/copy");
    expect(opts.configCwd).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
      isBackground: true,
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // aborted:false, as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    // The agent loop ends and the promise settles "normally".
    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");        // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
  });
});

// Regression for #44: ESC during a foreground Agent call must propagate to
// the child. Pi delivers parent abort via AbortSignal; the manager wires the
// signal's "abort" event to this.abort(id).
describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
      isBackground: true,
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

// ─── persistence: sessionFilePath + configSnapshot capture ───────────
// When a session is created with a sessionDir, runAgent produces a persisted
// JSONL. The manager captures the resulting session.sessionFile onto the
// record (for later rehydration) and snapshots the spawn config (model,
// thinking, cwd, etc.) so rehydrate can rebuild the session without the
// caller's original options.
describe("AgentManager — persistence capture at spawn", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("captures sessionFilePath from session.sessionFile on creation", async () => {
    const sess = { ...mockSession(), sessionFile: "/path/to/session.jsonl" };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: sess as any, aborted: false, steered: false,
    });
    manager = new AgentManager();

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
      sessionDir: "/some/dir",
    });
    // Drive onSessionCreated by awaiting the run — the manager's callback
    // runs synchronously inside runAgent's invocation.
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.sessionFilePath).toBe("/path/to/session.jsonl");
  });

  it("snapshots spawn config (model, thinkingLevel, isolated, cwd, configCwd) on the record", async () => {
    const sess = { ...mockSession(), sessionFile: "/p.jsonl" };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: sess as any, aborted: false, steered: false,
    });
    manager = new AgentManager();

    const model = { provider: "anthropic", id: "claude-haiku-4-5" } as any;
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
      model,
      thinkingLevel: "high",
      isolated: true,
    });
    await manager.getRecord(id)!.promise;

    const snap = manager.getRecord(id)!.configSnapshot;
    expect(snap).toBeDefined();
    expect(snap!.resolvedModelKey).toBe("anthropic/claude-haiku-4-5");
    expect(snap!.thinkingLevel).toBe("high");
    expect(snap!.isolated).toBe(true);
    // No worktree or custom cwd → cwd is undefined, configCwd is undefined
    expect(snap!.cwd).toBeUndefined();
    expect(snap!.configCwd).toBeUndefined();
  });

  it("snapshots caller-supplied cwd and derives configCwd from the parent", async () => {
    const sess = { ...mockSession(), sessionFile: "/p.jsonl" };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: sess as any, aborted: false, steered: false,
    });
    manager = new AgentManager();

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    const snap = manager.getRecord(id)!.configSnapshot;
    expect(snap!.cwd).toBe("/");
    expect(snap!.configCwd).toBe("/tmp"); // parent cwd
  });
});

// ─── resume() rehydration: rebuild a session from disk ───────────────
// Fast path: live session in memory. Slow path: session gone but JSONL on
// disk → rehydrateAgent rebuilds it from the agent type + configSnapshot.
describe("AgentManager — resume rehydration", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("fast path: uses the live session when it is still in memory", async () => {
    const sess = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first", session: sess as any, aborted: false, steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x", isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue("second");

    await manager.resume(id, "more", { ctx: mockCtx as any, pi: mockPi });

    const { rehydrateAgent: rehydrateMock } = await import("../src/agent-runner.js");
    expect(rehydrateMock).not.toHaveBeenCalled();
    expect(resumeMock).toHaveBeenCalledWith(sess, "more", expect.anything());
  });

  it("slow path: rehydrates from sessionFilePath when session is gone", async () => {
    const sess = { ...mockSession(), sessionFile: "/persisted/session.jsonl" };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first", session: sess as any, aborted: false, steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "p", {
      description: "x",
      isBackground: true,
      sessionDir: "/some/dir",
      model: { provider: "anthropic", id: "claude-haiku-4-5" } as any,
      thinkingLevel: "high",
    });
    await manager.getRecord(id)!.promise;

    const record = manager.getRecord(id)!;
    expect(record.sessionFilePath).toBe("/persisted/session.jsonl");

    // Simulate cleanup: drop the in-memory session, keep the file path + snapshot.
    record.session = undefined;

    const { rehydrateAgent: rehydrateMock } = await import("../src/agent-runner.js");
    const rehydrated = { ...mockSession() };
    vi.mocked(rehydrateMock).mockResolvedValue(rehydrated as any);

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue("rehydrated-result");

    await manager.resume(id, "continue", { ctx: mockCtx as any, pi: mockPi });

    // rehydrateAgent was called with the persisted path + snapshot-derived config
    expect(rehydrateMock).toHaveBeenCalledTimes(1);
    // lastCall — mock.calls persists across tests in the same file
    const [calledCtx, calledType, calledPath, calledOpts] = vi.mocked(rehydrateMock).mock.lastCall!;
    expect(calledCtx).toBe(mockCtx);
    expect(calledType).toBe("general-purpose");
    expect(calledPath).toBe("/persisted/session.jsonl");
    expect(calledOpts).toMatchObject({
      agentId: id,
      thinkingLevel: "high",
    });

    // The rehydrated session is now live on the record and resumeAgent was driven against it
    expect(record.session).toBe(rehydrated);
    expect(resumeMock).toHaveBeenCalledWith(rehydrated, "continue", expect.anything());
    expect(record.status).toBe("completed");
    expect(record.result).toBe("rehydrated-result");
  });

  it("slow path: resolves the model from configSnapshot via the registry", async () => {
    const sess = { ...mockSession(), sessionFile: "/p.jsonl" };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first", session: sess as any, aborted: false, steered: false,
    });
    const ctxWithRegistry = {
      ...mockCtx,
      modelRegistry: { find: vi.fn(() => ({ provider: "anthropic", id: "claude-haiku-4-5" })) },
    } as any;
    manager = new AgentManager();
    const id = manager.spawn(mockPi, ctxWithRegistry, "general-purpose", "p", {
      description: "x",
      isBackground: true,
      model: { provider: "anthropic", id: "claude-haiku-4-5" } as any,
    });
    await manager.getRecord(id)!.promise;
    manager.getRecord(id)!.session = undefined;

    const { rehydrateAgent: rehydrateMock } = await import("../src/agent-runner.js");
    vi.mocked(rehydrateMock).mockResolvedValue({ ...mockSession() } as any);
    vi.mocked(await import("../src/agent-runner.js")).resumeAgent.mockResolvedValue("ok");

    await manager.resume(id, "go", { ctx: ctxWithRegistry, pi: mockPi });

    expect(ctxWithRegistry.modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
    const calledOpts = vi.mocked(rehydrateMock).mock.lastCall![3];
    expect(calledOpts.model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("returns undefined when neither session nor sessionFilePath is available", async () => {
    manager = new AgentManager();
    const id = "never-spawned";
    const result = await manager.resume(id, "p", { ctx: mockCtx as any, pi: mockPi });
    expect(result).toBeUndefined();
  });

  it("returns undefined when sessionFilePath exists but no ctx/pi for rehydration", async () => {
    manager = new AgentManager();
    // Inject a synthetic record with a sessionFilePath but no live session.
    const record: AgentRecord = {
      id: "synthetic",
      type: "general-purpose",
      description: "x",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      sessionFilePath: "/persisted/session.jsonl",
    };
    (manager as any).agents.set("synthetic", record);

    const result = await manager.resume("synthetic", "p");
    expect(result).toBeUndefined();
  });

  it("slow path: surfaces rehydration failures as status='error' on the record", async () => {
    manager = new AgentManager();
    const record: AgentRecord = {
      id: "broken",
      type: "general-purpose",
      description: "x",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      sessionFilePath: "/persisted/missing.jsonl",
    };
    (manager as any).agents.set("broken", record);

    const { rehydrateAgent: rehydrateMock } = await import("../src/agent-runner.js");
    vi.mocked(rehydrateMock).mockRejectedValue(new Error("file not found"));

    const result = await manager.resume("broken", "p", { ctx: mockCtx as any, pi: mockPi });

    expect(result).toBeDefined();
    expect(result!.status).toBe("error");
    expect(result!.error).toContain("file not found");
  });
});

// ─── cleanup preserves persisted JSONLs on disk ──────────────────────
// removeRecord / clearCompleted dispose the in-memory session but never touch
// the file at sessionFilePath — so resume() can rehydrate later. dispose()
// (pi's API) is purely in-memory cleanup; it does not unlink files.
describe("AgentManager — cleanup preserves persisted session files", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("removeRecord disposes the in-memory session but keeps sessionFilePath on the record", async () => {
    const disposeSpy = vi.fn();
    const sess = { ...mockSession(), dispose: disposeSpy, sessionFile: "/keep.jsonl" };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done", session: sess as any, aborted: false, steered: false,
    });
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x", isBackground: true, sessionDir: "/d",
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.sessionFilePath).toBe("/keep.jsonl");

    // clearCompleted triggers removeRecord for the completed record
    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
    expect(manager.getRecord(id)).toBeUndefined();
    // The record object still holds sessionFilePath — the manager dropped its
    // map entry, but anything that captured the record (e.g. a history log)
    // still sees where the JSONL lives.
    expect(record.sessionFilePath).toBe("/keep.jsonl");
    expect(record.session).toBeUndefined();
  });
});

// ─── resumeFromDisk: rebuild an agent purely from a persisted JSONL ───
// The disk-only counterpart to resume() — usable after the in-memory map is
// gone (cleanup timer, clearCompleted, fresh process). Reads the
// subagent:config metadata, rebuilds a record, rehydrates the session, and
// drives the prompt. The rebuilt record is registered so later resume(id)
// calls take the fast path.
describe("AgentManager — resumeFromDisk", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  async function importMocks() {
    const mod = await import("../src/agent-runner.js");
    return {
      readSubagentMetadata: vi.mocked(mod.readSubagentMetadata),
      rehydrateAgent: vi.mocked(mod.rehydrateAgent),
      resumeAgent: vi.mocked(mod.resumeAgent),
    };
  }

  beforeEach(async () => {
    // Mocks accumulate calls across describe blocks in this file — clear so
    // per-test call-count and lastCall assertions are isolated.
    const m = await importMocks();
    m.readSubagentMetadata.mockClear();
    m.readSubagentMetadata.mockReset();
    m.rehydrateAgent.mockClear();
    m.rehydrateAgent.mockReset();
    m.resumeAgent.mockClear();
    m.resumeAgent.mockReset();
  });

  it("reads metadata, rebuilds a record, rehydrates, and drives the prompt", async () => {
    const { readSubagentMetadata, rehydrateAgent, resumeAgent } = await importMocks();
    readSubagentMetadata.mockResolvedValue({
      type: "Explore",
      originalPrompt: "the original task",
      configSnapshot: { resolvedModelKey: "anthropic/claude-haiku-4-5", thinkingLevel: "high" },
    });
    const rehydrated = { ...mockSession() };
    rehydrateAgent.mockResolvedValue(rehydrated as any);
    resumeAgent.mockResolvedValue("rehydrated-result");

    manager = new AgentManager();
    const result = await manager.resumeFromDisk("/persisted/session.jsonl", "continue", {
      ctx: mockCtx, pi: mockPi,
    });

    expect(result).toBeDefined();
    expect(result!.status).toBe("completed");
    expect(result!.result).toBe("rehydrated-result");
    expect(result!.type).toBe("Explore");
    expect(result!.originalPrompt).toBe("the original task");
    expect(result!.description).toBe("the original task".slice(0, 80));
    expect(result!.sessionFilePath).toBe("/persisted/session.jsonl");

    // Metadata was read from the right file.
    expect(readSubagentMetadata).toHaveBeenCalledWith("/persisted/session.jsonl");
    // rehydrateAgent received the path + persistConfig (so on-disk metadata stays current).
    expect(rehydrateAgent).toHaveBeenCalledTimes(1);
    const [, , , opts] = rehydrateAgent.mock.lastCall! as any[];
    expect(opts).toMatchObject({
      agentId: result!.id,
      thinkingLevel: "high",
      persistConfig: { type: "Explore", originalPrompt: "the original task" },
    });
    // resumeAgent was driven against the rehydrated session.
    expect(resumeAgent).toHaveBeenCalledWith(rehydrated, "continue", expect.anything());

    // The rebuilt record is registered in the map — a subsequent resume() takes the fast path.
    expect(manager.getRecord(result!.id)).toBe(result);
  });

  it("returns undefined when the JSONL has no subagent:config entry", async () => {
    const { readSubagentMetadata, rehydrateAgent } = await importMocks();
    readSubagentMetadata.mockResolvedValue(undefined);

    manager = new AgentManager();
    const result = await manager.resumeFromDisk("/persisted/old.jsonl", "go", {
      ctx: mockCtx, pi: mockPi,
    });

    expect(result).toBeUndefined();
    expect(rehydrateAgent).not.toHaveBeenCalled();
    // No record registered.
    expect(manager.listAgents()).toEqual([]);
  });

  it("resolves the model from configSnapshot via the registry and passes it to rehydrate", async () => {
    const { readSubagentMetadata, rehydrateAgent, resumeAgent } = await importMocks();
    readSubagentMetadata.mockResolvedValue({
      type: "general-purpose",
      originalPrompt: "task",
      configSnapshot: { resolvedModelKey: "anthropic/claude-haiku-4-5" },
    });
    rehydrateAgent.mockResolvedValue({ ...mockSession() } as any);
    resumeAgent.mockResolvedValue("ok");

    const ctxWithRegistry = {
      ...mockCtx,
      modelRegistry: { find: vi.fn(() => ({ provider: "anthropic", id: "claude-haiku-4-5" })) },
    } as any;
    manager = new AgentManager();
    await manager.resumeFromDisk("/p.jsonl", "go", { ctx: ctxWithRegistry, pi: mockPi });

    expect(ctxWithRegistry.modelRegistry.find).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
    const opts = rehydrateAgent.mock.lastCall![3] as any;
    expect(opts.model).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("surfaces rehydration failures as status='error' on the record", async () => {
    const { readSubagentMetadata, rehydrateAgent } = await importMocks();
    readSubagentMetadata.mockResolvedValue({
      type: "Explore", originalPrompt: "task", configSnapshot: {},
    });
    rehydrateAgent.mockRejectedValue(new Error("corrupt jsonl"));

    manager = new AgentManager();
    const result = await manager.resumeFromDisk("/p.jsonl", "go", { ctx: mockCtx, pi: mockPi });

    expect(result).toBeDefined();
    expect(result!.status).toBe("error");
    expect(result!.error).toContain("corrupt jsonl");
    expect(result!.completedAt).toBeGreaterThan(0);
    // The errored record stays in the map so the caller can inspect it.
    expect(manager.getRecord(result!.id)).toBe(result);
  });

  it("surfaces prompt failures as status='error' (session already rehydrated)", async () => {
    const { readSubagentMetadata, rehydrateAgent, resumeAgent } = await importMocks();
    readSubagentMetadata.mockResolvedValue({
      type: "Explore", originalPrompt: "task", configSnapshot: {},
    });
    rehydrateAgent.mockResolvedValue({ ...mockSession() } as any);
    resumeAgent.mockRejectedValue(new Error("model overloaded"));

    manager = new AgentManager();
    const result = await manager.resumeFromDisk("/p.jsonl", "go", { ctx: mockCtx, pi: mockPi });

    expect(result!.status).toBe("error");
    expect(result!.error).toContain("model overloaded");
  });

  it("description is truncated to 80 chars from the original prompt", async () => {
    const { readSubagentMetadata, rehydrateAgent, resumeAgent } = await importMocks();
    const longPrompt = "x".repeat(200);
    readSubagentMetadata.mockResolvedValue({
      type: "Explore", originalPrompt: longPrompt, configSnapshot: {},
    });
    rehydrateAgent.mockResolvedValue({ ...mockSession() } as any);
    resumeAgent.mockResolvedValue("ok");

    manager = new AgentManager();
    const result = await manager.resumeFromDisk("/p.jsonl", "go", { ctx: mockCtx, pi: mockPi });

    expect(result!.description).toHaveLength(80);
    expect(result!.description).toBe("x".repeat(80));
    // originalPrompt is preserved untruncated.
    expect(result!.originalPrompt).toBe(longPrompt);
  });
});
