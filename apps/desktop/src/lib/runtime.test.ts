import { describe, expect, it } from "vitest";
import type { RuntimeEvent, HistoryMessage } from "@ai4s/sdk";
import { datedWorkspaceName, foldEvent, historyToThread, tidyToolTitle, type FoldState } from "./runtime";

const empty: FoldState = { blocks: [], index: {} };
const S = "ses_1";
const foldAll = (events: RuntimeEvent[]): FoldState =>
  events.reduce((s, e) => foldEvent(s, e), empty);

describe("tidyToolTitle", () => {
  it("shows workspace files by their relative path", () => {
    expect(tidyToolTitle("/Users/asq/Documents/OpenScience/demo/analyze.py")).toBe("demo/analyze.py");
    expect(tidyToolTitle("mkdir -p /Users/asq/Documents/OpenScience/demo_analysis")).toBe(
      "mkdir -p demo_analysis",
    );
    // OpenCode's write-tool titles drop the leading slash — must still relativize.
    expect(tidyToolTitle("Users/asq/Documents/OpenScience/demo_analysis/analyze.py")).toBe(
      "demo_analysis/analyze.py",
    );
  });
  it("leaves non-workspace titles unchanged", () => {
    expect(tidyToolTitle("search (done)")).toBe("search (done)");
    expect(tidyToolTitle("python3 -c \"import numpy\"")).toBe('python3 -c "import numpy"');
  });
});

describe("datedWorkspaceName", () => {
  it("formats a zero-padded YYYY-MM-DD-HHMM folder name", () => {
    expect(datedWorkspaceName(new Date(2026, 6, 4, 16, 5))).toBe("2026-07-04-1605");
    expect(datedWorkspaceName(new Date(2026, 0, 9, 3, 40))).toBe("2026-01-09-0340");
  });
});

describe("foldEvent", () => {
  it("upserts a text part by id (idempotent full-text updates, not appends)", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "Planning" },
      { type: "text.updated", sessionId: S, partId: "p1", text: "Planning the review" },
    ]);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toEqual({ kind: "agent", markdown: "Planning the review" });
  });

  it("upserts a tool call by callId and reflects status transitions", () => {
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "search", status: "running", title: "search" },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "search", status: "success", title: "search (done)" },
    ]);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ kind: "tool-call", status: "success", title: "search (done)" });
  });

  it("does not render interactive question/permission tools as thread rows", () => {
    // These are surfaced by InteractionPrompt (answerable), not as blank rows.
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "q1", tool: "question", status: "running", title: "" },
      { type: "tool.updated", sessionId: S, callId: "p1", tool: "permission", status: "running", title: "" },
    ]);
    expect(s.blocks).toHaveLength(0);
  });

  it("drops opaque todo tool rows from the conversation", () => {
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "t1", tool: "todowrite", status: "success", title: "4 todos" },
    ]);
    expect(s.blocks).toHaveLength(0);
  });

  it("never blanks a tool row when the completed event reports an empty title", () => {
    // Completed MCP tool parts carry title: "" — the tool name must survive.
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "jupyter_insert_cell", status: "running" },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "jupyter_insert_cell", status: "success", title: "" },
    ]);
    expect(s.blocks[0]).toMatchObject({
      kind: "tool-call",
      status: "success",
      title: "jupyter_insert_cell",
    });
  });

  it("shows the file path for a file tool that has no title yet", () => {
    // OpenCode only sets a write/edit tool's title on completion — while the
    // tool runs, the file path in its input is the only thing worth showing.
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "write", status: "running", input: { filePath: "/Users/asq/Documents/OpenScience/2026-07-04/index.html", content: "<!doctype html>" } },
    ]);
    expect(s.blocks[0]).toMatchObject({
      kind: "tool-call",
      status: "running",
      title: "2026-07-04/index.html",
    });
  });

  it("surfaces a written file as an artifact block, deduped by path", () => {
    const s = foldAll([
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "write", status: "running", input: { filePath: "fig.py" } },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "write", status: "success", input: { filePath: "fig.py", content: "print(1)" } },
    ]);
    const artifacts = s.blocks.filter((b) => b.kind === "artifact");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ kind: "artifact", filename: "fig.py", artifact: "script", content: "print(1)" });
    // The tool-call row is still present alongside the artifact.
    expect(s.blocks.some((b) => b.kind === "tool-call")).toBe(true);
  });

  it("keeps distinct parts as separate blocks in arrival order", () => {
    const s = foldAll([
      { type: "text.updated", sessionId: S, partId: "p1", text: "planning" },
      { type: "tool.updated", sessionId: S, callId: "c1", tool: "search", status: "success" },
      { type: "text.updated", sessionId: S, partId: "p2", text: "done" },
      { type: "session.idle", sessionId: S },
    ]);
    expect(s.blocks.map((b) => b.kind)).toEqual(["agent", "tool-call", "agent", "status-line"]);
  });
});

describe("historyToThread", () => {
  // Magi persists a flat role/content transcript; MagiClient.getMessages folds
  // `tool` rows into the preceding assistant message carrying only a name +
  // status (no input/title/args, no synthetic shell markers or slash-command
  // template expansions — those were OpenCode-specific).
  it("converts user/assistant messages (text + tool parts) into blocks", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "planning" },
          { type: "tool", tool: "WebSearch", state: { status: "completed" } },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.map((b) => b.kind)).toEqual(["user", "agent", "tool-call"]);
    expect(t.blocks[2]).toMatchObject({ kind: "tool-call", status: "success", title: "WebSearch" });
  });

  it("titles a tool row by its tool name (no input/title in Magi history)", () => {
    const msgs: HistoryMessage[] = [
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "Bash", state: { status: "completed", output: "ok" } }],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks[0]).toMatchObject({ kind: "tool-call", title: "Bash", status: "success" });
    expect(t.blocks[0]).not.toHaveProperty("outputSummary");
  });

  it("maps a failed tool row to the failed status", () => {
    const msgs: HistoryMessage[] = [
      {
        role: "assistant",
        parts: [{ type: "tool", tool: "Bash", state: { status: "error", output: "boom" } }],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks[0]).toMatchObject({ kind: "tool-call", status: "failed" });
  });

  it("skips interactive question/permission and todo tool rows", () => {
    const msgs: HistoryMessage[] = [
      {
        role: "assistant",
        parts: [
          { type: "tool", tool: "AskUserQuestion", state: { status: "completed" } },
          { type: "tool", tool: "TodoWrite", state: { status: "completed" } },
          { type: "tool", tool: "Read", state: { status: "completed" } },
        ],
      },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.map((b) => (b.kind === "tool-call" ? b.title : b.kind))).toEqual(["Read"]);
  });

  it("drops empty user/assistant text", () => {
    const msgs: HistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "   " }] },
      { role: "assistant", parts: [{ type: "text", text: "answer" }] },
    ];
    const t = historyToThread(msgs);
    expect(t.blocks.map((b) => b.kind)).toEqual(["agent"]);
  });
});
