import { describe, expect, it, vi } from "vitest";

// agent-widget.ts -> agent-types.ts does a *value* import from
// @earendil-works/pi-coding-agent, whose installed build transitively imports
// the `./base` subpath of @earendil-works/pi-ai — a subpath the installed
// pi-ai no longer exports. That breaks module loading in this env (a
// pre-existing failure shared by 16 test files). The widget logic under test
// never touches these symbols at load time, so stub the package to keep the
// module graph resolvable.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createCodingTools: () => [],
  createReadOnlyTools: () => [],
  getAgentDir: () => undefined,
  parseFrontmatter: () => ({}),
  getSettingsListTheme: () => ({}),
}));

import { AgentWidget, formatSessionTokens, type Theme } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});

// ---- finished-linger behavior on resume ----
// The widget tracks how long a finished agent lingers in `finishedTurnAge`.
// Two bugs previously made resumed agents mis-render:
//   1. `markFinished` had a `has()` guard, so a second completion was a no-op
//      and inherited a stale age.
//   2. Nothing cleared the entry when a record flipped back to `running`, so a
//      turn that aged it during the running phase left it permanently stale.

type FakeRec = {
  id: string;
  type: string;
  status: string;
  description: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
};

const passthroughTheme: Theme = {
  fg: (_c, s) => s,
  bold: (s) => s,
};

/** Minimal harness: a fake manager backed by a mutable `list`, and a UICtx
 *  that captures the widget's render() so tests can read the live lines. */
function makeWidget(list: FakeRec[], resumable: { description?: string }[] = []) {
  const manager = { listAgents: () => list, listResumable: () => resumable } as any;
  const widget = new AgentWidget(manager, new Map());

  let renderFn: (() => string[]) | undefined;
  const uiCtx = {
    setStatus: () => {},
    setWidget: (_key: string, content: any) => {
      // Unregister (content === undefined) leaves the stale renderFn in place;
      // it still reads live state, returning [] when nothing is showable.
      if (content) renderFn = content({ terminal: { columns: 200 }, requestRender: () => {} }, passthroughTheme).render;
    },
  } as any;
  widget.setUICtx(uiCtx);

  return { widget, getLines: () => renderFn?.() ?? [] };
}

/** A finished completed agent renders with the ✓ icon plus its description. */
function hasFreshFinishedLine(lines: string[], desc: string): boolean {
  return lines.some((l) => l.includes("✓") && l.includes(desc));
}

describe("AgentWidget finished-linger on resume", () => {
  it("re-shows a fresh finished line after resume + re-completion (regression)", () => {
    const rec: FakeRec = {
      id: "a1",
      type: "general-purpose",
      status: "completed",
      description: "review auth",
      toolUses: 2,
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
    };
    const { widget, getLines } = makeWidget([rec]);

    // First completion → finished line visible.
    widget.markFinished("a1");
    widget.update();
    expect(hasFreshFinishedLine(getLines(), "review auth")).toBe(true);

    // Resumed (running) while a parent turn advances. `onTurnStart` ages the
    // finishedTurnAge entry; the clear-on-active fix must drop it so it can't
    // leak into the next completion.
    rec.status = "running";
    rec.completedAt = undefined;
    widget.onTurnStart();
    widget.update();

    // Re-completes. markFinished must reset the age so the line reappears.
    rec.status = "completed";
    rec.completedAt = Date.now();
    widget.markFinished("a1");
    widget.update();
    expect(hasFreshFinishedLine(getLines(), "review auth")).toBe(true);
  });

  it("drops a completed agent from the finished section after one turn", () => {
    const rec: FakeRec = {
      id: "a2",
      type: "general-purpose",
      status: "completed",
      description: "scan deps",
      toolUses: 1,
      startedAt: Date.now() - 500,
      completedAt: Date.now(),
    };
    const { widget, getLines } = makeWidget([rec]);

    widget.markFinished("a2");
    widget.update();
    expect(hasFreshFinishedLine(getLines(), "scan deps")).toBe(true);

    // Completed (non-error) agents linger for <1 turn; one turn ages them out.
    widget.onTurnStart();
    expect(hasFreshFinishedLine(getLines(), "scan deps")).toBe(false);
  });
});

describe("AgentWidget resumable summary", () => {
  it("shows a compact summary when only stopped/resumable sessions exist", () => {
    const { widget, getLines } = makeWidget([], [{ description: "a" }, { description: "b" }]);
    widget.update();
    const lines = getLines();
    // Widget stays registered (not unregistered as "nothing to show").
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("2 resumable sessions") && l.includes("/agents"))).toBe(true);
  });

  it("singularizes for a single resumable session", () => {
    const { widget, getLines } = makeWidget([], [{ description: "only" }]);
    widget.update();
    expect(getLines().some((l) => l.includes("1 resumable session"))).toBe(true);
  });

  it("renders live agents exactly once alongside the summary (no double-count)", () => {
    // A running agent + resumable entries: the running header must appear once,
    // and the summary is the only place resumable sessions surface — they never
    // bleed into the live `agents` rendering.
    const rec: FakeRec = {
      id: "r1", type: "general-purpose", status: "running",
      description: "active task", toolUses: 0, startedAt: Date.now(),
    };
    const { widget, getLines } = makeWidget([rec], [{ description: "x" }]);
    widget.update();
    const lines = getLines();
    expect(lines.filter((l) => l.includes("active task"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("1 resumable session"))).toBe(true);
  });

  it("renders nothing when there are no agents and no resumable sessions", () => {
    const { widget, getLines } = makeWidget([], []);
    widget.update();
    expect(getLines()).toEqual([]);
  });
});
