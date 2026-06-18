/**
 * agent-runner-e2e.test.ts — End-to-end test against the REAL pi-mono runtime.
 *
 * Every other agent-runner test mocks `@earendil-works/pi-coding-agent`: it
 * asserts that `runAgent` hands the right `tools:` allowlist to a *simulated*
 * `createAgentSession`. That proves our allowlist math, but not the assumption
 * the math rests on — that real pi-mono actually gates a session to that
 * allowlist, admitting extension-registered tools (the #47 fix) and dropping
 * the rest.
 *
 * This test closes that loop with NO pi-mono mock:
 *   - a real extension fixture (`fixtures/e2e-probe-ext.mjs`) registers a tool,
 *   - the real `DefaultResourceLoader` loads it via `additionalExtensionPaths`,
 *   - the real `createAgentSession` builds the session,
 *   - we read the real `session.getActiveToolNames()` at `onSessionCreated`
 *     (fires after construction, before any prompt) and assert what the LLM
 *     would actually be allowed to call.
 *
 * No network/LLM: a faux Model object satisfies `createAgentSession`'s `model`
 * param, and we never depend on a turn completing — the assertion is on the
 * gated tool set, which is fixed at construction. (Driving a live faux model
 * through `session.prompt()` is intentionally avoided: under Vite the faux
 * provider registers in a different `pi-ai` module instance than the one
 * pi-coding-agent streams through, which is brittle and orthogonal to gating.)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionCanonicalName, rehydrateAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom —
// a genuine hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("agent-runner end-to-end (real pi-mono session + real extension)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    // Only used as a valid Model object for createAgentSession; we never rely
    // on it actually streaming (we assert on the pre-prompt gated tool set).
    faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Register `cfg` as agent type "e2e", run it through the REAL runAgent, and
   * return the real session's active tool names captured at construction time.
   */
  async function activeToolsFor(cfg: Partial<AgentConfig>): Promise<string[]> {
    registerAgents(
      new Map([
        [
          "e2e",
          {
            name: "e2e",
            description: "e2e",
            builtinToolNames: BUILTINS,
            skills: false,
            systemPrompt: "You are e2e.",
            promptMode: "replace",
            inheritContext: false,
            runInBackground: false,
            isolated: false,
            ...cfg,
          } as AgentConfig,
        ],
      ]),
    );
    const model = faux.getModel();
    const modelRegistry: any = {
      find: () => model,
      getAll: () => [model],
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }),
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };

    let active: string[] = [];
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(),
        model,
        onSessionCreated: (s) => {
          active = s.getActiveToolNames();
        },
      });
    } catch {
      // A no-op/erroring prompt turn is fine — the gated tool set is fixed at
      // construction, which `onSessionCreated` already captured.
    }
    return active;
  }

  it("real pi-mono admits an extension-registered tool when it's in the allowlist (#47)", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE] });
    // The extension actually loaded and its tool reached the live session.
    expect(active).toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an extension tool is absent when extensions are disabled (not loaded)", async () => {
    const active = await activeToolsFor({ extensions: false });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("disallowedTools removes a real extension tool from the live session", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE], disallowedTools: [EXT_TOOL] });
    expect(active).not.toContain(EXT_TOOL); // loaded, then denied at construction
    expect(active).toContain("read");
  });

  it("the ext: allowlist flip mutes a loaded-but-unselected extension in real pi-mono", async () => {
    // Extension loads (extensions: [FIXTURE]), but a single ext: selector for a
    // *different* name flips extension tools to an allowlist — the unselected
    // fixture contributes nothing, even though it loaded and ran its handlers.
    const active = await activeToolsFor({ extensions: [FIXTURE], extSelectors: ["ext:not-the-fixture"] });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an ext: selector surfaces the loaded extension's tool through the flip", async () => {
    // Derive the canonical name the loader/selector matcher uses, so the test
    // tracks `extensionCanonicalName` rather than hard-coding a filename form.
    const canon = extensionCanonicalName(FIXTURE);
    const active = await activeToolsFor({
      extensions: [FIXTURE],
      builtinToolNames: ["read"],
      extSelectors: [`ext:${canon}`],
    });
    expect(active).toContain(EXT_TOOL); // selected → surfaces despite the flip
    expect(active).toContain("read");
    expect(active).not.toContain("bash"); // builtinToolNames: ["read"] only
  });

  // ─── persistence: runAgent writes a real pi-format JSONL when sessionDir is set ─
  // Closing the loop on the persistence work: when runAgent is called with a
  // sessionDir, the resulting AgentSession has a real sessionFile on disk in
  // pi's standard format — and that file is loadable via rehydrateAgent, which
  // produces a new session with the original messages and the same tool set.
  it("runAgent writes a real pi-format JSONL when sessionDir is supplied", async () => {
    registerAgents(new Map([
      ["e2e", {
        name: "e2e", description: "e2e",
        builtinToolNames: BUILTINS, extensions: false, skills: false,
        systemPrompt: "You are e2e.", promptMode: "replace",
        inheritContext: false, runInBackground: false, isolated: false,
      } as AgentConfig],
    ]));
    const model = faux.getModel();
    const modelRegistry: any = { find: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingOAuth: () => false, getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }) };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };
    const sessionDir = join(cwd, "subagents-sessiondir");

    let createdSession: any;
    try {
      await runAgent(ctx, "e2e", "hello", {
        pi: makePi(), model, sessionDir,
        onSessionCreated: (s) => { createdSession = s; },
      });
    } catch { /* faux model may error on prompt — session creation is what matters */ }

    expect(createdSession).toBeDefined();
    const filePath = createdSession.sessionFile;
    expect(typeof filePath).toBe("string");
    expect(filePath.startsWith(sessionDir)).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    // File starts with the pi session header (type=session, version=3)
    const firstLine = JSON.parse(readFileSync(filePath, "utf-8").split("\n")[0]);
    expect(firstLine.type).toBe("session");
    expect(firstLine.version).toBe(3);
    expect(firstLine.cwd).toBe(cwd);
  });

  it("rehydrateAgent reloads the persisted JSONL and produces an equivalent session", async () => {
    registerAgents(new Map([
      ["e2e", {
        name: "e2e", description: "e2e",
        builtinToolNames: BUILTINS, extensions: false, skills: false,
        systemPrompt: "You are e2e.", promptMode: "replace",
        inheritContext: false, runInBackground: false, isolated: false,
      } as AgentConfig],
    ]));
    const model = faux.getModel();
    const modelRegistry: any = { find: () => model, getAvailable: () => [model], hasConfiguredAuth: () => true, isUsingOAuth: () => false, getApiKeyAndHeaders: async () => ({ apiKey: "faux", headers: {} }) };
    const ctx: any = { cwd, getSystemPrompt: () => "PARENT", model, modelRegistry };
    const sessionDir = join(cwd, "subagents-rehydrate");

    // Phase 1: spawn, capture the file path, dispose the in-memory session.
    let filePath: string | undefined;
    let originalActiveTools: string[] = [];
    try {
      await runAgent(ctx, "e2e", "hello", {
        pi: makePi(), model, sessionDir,
        onSessionCreated: (s) => {
          filePath = s.sessionFile;
          originalActiveTools = s.getActiveToolNames();
        },
      });
    } catch { /* faux model errors are fine */ }
    expect(filePath).toBeDefined();

    // Phase 2: rehydrate from disk — same agent type, same cwd.
    const rehydrated = await rehydrateAgent(ctx, "e2e", filePath!, { pi: makePi(), model });
    expect(rehydrated).toBeDefined();
    expect(rehydrated.sessionFile).toBe(filePath);
    expect(rehydrated.getActiveToolNames().sort()).toEqual(originalActiveTools.sort());
  });
});
