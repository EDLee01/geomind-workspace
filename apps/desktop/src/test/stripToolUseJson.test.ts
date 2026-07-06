import { describe, expect, it } from "vitest";
import { stripToolUseJson } from "@ai4s/sdk";

// These payloads mirror the REAL metadata.text strings captured from the bad
// session d57f9fb3 (claude-sonnet-4-6 via hotaitool), where a non-streamed
// tool-only turn's assistant.message text was pure tool_use JSON and the thread
// rendered it as raw text. Magi's messageText() produces exactly
// JSON.stringify({ id, name, input }) per tool-use content part.
describe("stripToolUseJson", () => {
  it("leaves normal prose untouched, whitespace and all", () => {
    expect(stripToolUseJson("Planning the analysis. ")).toBe("Planning the analysis. ");
    expect(stripToolUseJson("Planning ")).toBe("Planning ");
    expect(stripToolUseJson("  hello  ")).toBe("  hello  ");
  });

  it("drops a bare FileRead tool_use block (real payload)", () => {
    const t =
      '{"id":"toolu_01CNFYM94FcV4KdmN5MYMMAT","name":"FileRead","input":{"file_path":"/home/claude-user/.codex/memories/work-principles.md"}}';
    expect(stripToolUseJson(t)).toBe("");
  });

  it("drops a Bash tool_use block whose input has slashes and dots", () => {
    const t =
      '{"id":"toolu_015dmVamR77urCHWEiGyqfja","name":"Bash","input":{"command":"cat /home/claude-user/geomind-desktop-runtime/ws/demo_analysis/results.json"}}';
    expect(stripToolUseJson(t)).toBe("");
  });

  it("drops a FileWrite whose input.content has braces, quotes and escaped newlines (regex-killer)", () => {
    // A naive /\{.*?\}/ regex mis-slices this because the content itself
    // contains `{`, `}`, `\n`, and escaped `"`. The balanced scanner must not.
    const input = {
      file_path: "demo_analysis/run_analysis.py",
      content:
        '"""\nDose-response analysis.\n"""\nimport json\nd = {"a": 1, "b": {"c": 2}}\nprint(d)\n',
    };
    const t = JSON.stringify({ id: "toolu_01Hb6yALtD9nDrnUR11eqkx8", name: "FileWrite", input });
    expect(stripToolUseJson(t)).toBe("");
  });

  it("keeps a prose preface and strips a trailing tool_use block", () => {
    const t =
      'Let me read that file first. {"id":"toolu_01ABCdef","name":"FileRead","input":{"file_path":"a.txt"}}';
    expect(stripToolUseJson(t)).toBe("Let me read that file first. ");
  });

  it("strips multiple concatenated tool_use blocks, keeping the gaps", () => {
    const a = JSON.stringify({ id: "toolu_01one", name: "Bash", input: { command: "ls" } });
    const b = JSON.stringify({ id: "toolu_02two", name: "Bash", input: { command: "pwd" } });
    expect(stripToolUseJson(`${a} and then ${b}`)).toBe(" and then ");
  });

  it("does not touch JSON that merely looks similar but isn't a tool_use id", () => {
    const t = '{"id":"msg_01xyz","name":"note","input":{}}';
    expect(stripToolUseJson(t)).toBe(t);
  });

  it("preserves an incomplete/unbalanced tool_use fragment rather than eating the tail", () => {
    const t = 'text {"id":"toolu_01trunc","name":"Bash","input":{"command":"ls';
    expect(stripToolUseJson(t)).toBe(t);
  });
});
