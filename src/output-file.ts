/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

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

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
  const entry = {
    isSidechain: true,
    agentId,
    type: "user",
    message: { role: "user", content: prompt },
    timestamp: new Date().toISOString(),
    cwd,
  };
  writeFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
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
): () => void {
  let writtenCount = 1; // initial user prompt already written

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
