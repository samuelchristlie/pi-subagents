/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Encode a cwd path as a filesystem-safe directory name. Handles:
 *   - POSIX:   "/home/user/project"        → "home-user-project"
 *   - Windows: "C:\Users\foo\project"      → "Users-foo-project"
 *   - UNC:     "\\\\server\\share\\project"  → "server-share-project"
 */
export function encodeCwd(cwd: string): string {
  return cwd
    .replace(/[/\\]/g, "-")        // both separators → dash
    .replace(/^[A-Za-z]:-/, "")    // strip Windows drive prefix ("C:-")
    .replace(/^-+/, "");           // strip leading dashes (POSIX root, UNC)
}

/** Create the output file path, ensuring the directory exists.
 *  Stores subagent transcripts alongside the parent session:
 *  ~/.pi/agent/sessions/--<encoded-cwd>--/subagents/<sessionId>/<agentId>.jsonl */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string): string {
  const encoded = encodeCwd(cwd);
  const home = process.env.HOME || process.env.USERPROFILE || tmpdir();
  const dir = join(home, ".pi", "agent", "sessions", `--${encoded}--`, "subagents", sessionId);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${agentId}.jsonl`);
}

/** Minimal tool definition shape for serialization. */
export interface ToolDefSnapshot {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  promptSnippet?: string;
}

/** Compute a stable hash over the system prompt and serialized tool definitions. */
function computeHash(systemPrompt: string, toolDefs: ToolDefSnapshot[]): string {
  const payload = JSON.stringify({ systemPrompt, toolDefs });
  return createHash("sha256").update(payload).digest("hex");
}

/** Shape of the system_snapshot entry stored in subagent JSONL. */
export interface SystemSnapshotData {
  hash: string;
  systemPrompt: string;
  toolDefinitions: ToolDefSnapshot[];
  timestamp: string;
}

/** Write the initial user prompt entry. Optionally prepend a system snapshot. */
export function writeInitialEntry(
  path: string,
  agentId: string,
  prompt: string,
  cwd: string,
  snapshot?: SystemSnapshotData,
): void {
  const lines: string[] = [];

  // Write system snapshot first if provided
  if (snapshot) {
    lines.push(JSON.stringify({
      isSidechain: true,
      agentId,
      type: "system_snapshot",
      data: snapshot,
      timestamp: snapshot.timestamp,
      cwd,
    }));
  }

  // Write the user prompt entry
  lines.push(JSON.stringify({
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  }));

  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
}

/** Append a system snapshot entry to an existing output file. */
export function appendSystemSnapshot(
  path: string,
  agentId: string,
  cwd: string,
  session: { systemPrompt: string; getAllTools(): Array<{ name: string; description: string; parameters: unknown; promptGuidelines?: string[]; promptSnippet?: string }> },
): void {
  const tools = session.getAllTools();
  const toolDefs: ToolDefSnapshot[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    promptGuidelines: t.promptGuidelines,
    promptSnippet: t.promptSnippet,
  }));
  const hash = computeHash(session.systemPrompt, toolDefs);
  const snapshot: SystemSnapshotData = {
    hash,
    systemPrompt: session.systemPrompt,
    toolDefinitions: toolDefs,
    timestamp: new Date().toISOString(),
  };
  const entry = {
    isSidechain: true,
    agentId,
    type: "system_snapshot",
    data: snapshot,
    timestamp: snapshot.timestamp,
    cwd,
  };
  try {
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch { /* ignore write errors */ }
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  agentId: string,
  cwd: string,
  extraWrittenCount = 0,
): () => void {
  let writtenCount = 1 + extraWrittenCount; // initial user prompt + any extra entries (e.g., system_snapshot)

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      const entry = {
        isSidechain: true,
        agentId,
        type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
        message: msg,
        timestamp: new Date().toISOString(),
        cwd,
      };
      try {
        appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
      } catch { /* ignore write errors */ }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") flush();
  });

  return () => {
    flush();
    unsubscribe();
  };
}
