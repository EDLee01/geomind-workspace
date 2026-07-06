// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MagiClient, type RuntimeEvent } from "@ai4s/sdk";
import { startMockMagi, type MockMagi } from "@ai4s/sdk/mock-server";

let server: MockMagi;

beforeAll(async () => {
  server = await startMockMagi(0);
});
afterAll(async () => {
  await server.close();
});

function newClient() {
  return new MagiClient({ baseUrl: `http://127.0.0.1:${server.port}` });
}

async function waitFor(pred: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("MagiClient ↔ Magi Control API", () => {
  it("pairs, connects, creates a session, sends a prompt, streams normalized events", async () => {
    const events: RuntimeEvent[] = [];
    const client = newClient();
    client.onEvent((e) => events.push(e));

    await client.connect();
    expect(client.getStatus()).toBe("ready");
    expect(client.credentials()?.deviceId).toBe("dev_mock");

    const sessionId = await client.createSession("run a literature review");
    expect(sessionId).toBe("ses_1");

    const jobId = await client.sendPrompt(sessionId, "run a literature review");
    expect(jobId).toBe("job_1");
    await waitFor(() => events.some((e) => e.type === "session.idle"));

    const types = events.map((e) => e.type);
    expect(types).toContain("text.updated");
    expect(types).toContain("tool.updated");

    // Deltas accumulate into the running part text.
    const firstPart = events.filter(
      (e): e is Extract<RuntimeEvent, { type: "text.updated" }> =>
        e.type === "text.updated" && e.partId === `${jobId}#0`,
    );
    expect(firstPart.map((e) => e.text)).toContain("Planning ");
    expect(firstPart[firstPart.length - 1].text).toBe("Planning the analysis. ");

    // A tool call rolls the segment: post-tool text lands in a new part id.
    const laterPart = events.find(
      (e): e is Extract<RuntimeEvent, { type: "text.updated" }> =>
        e.type === "text.updated" && e.partId === `${jobId}#1`,
    );
    expect(laterPart?.text).toBe("Wrote report.md.");

    const toolDone = events.find(
      (e): e is Extract<RuntimeEvent, { type: "tool.updated" }> =>
        e.type === "tool.updated" && e.status === "success",
    );
    expect(toolDone?.tool).toBe("WebSearch");
    expect(toolDone?.output).toBe("5 results");

    client.close();
    expect(client.getStatus()).toBe("offline");
  });

  it("loads history: flat role rows fold into user/assistant + tool parts", async () => {
    const client = newClient();
    await client.connect();
    const sessionId = await client.createSession("hist");
    await client.sendPrompt(sessionId, "go");
    await new Promise((r) => setTimeout(r, 60));
    const messages = await client.getMessages(sessionId);
    expect(messages[0]).toEqual({ role: "user", parts: [{ type: "text", text: "run a literature review" }] });
    const assistant = messages[1];
    expect(assistant.role).toBe("assistant");
    expect(assistant.parts.some((p) => p.type === "text")).toBe(true);
    expect(assistant.parts.some((p) => p.type === "tool" && p.tool === "WebSearch")).toBe(true);
    client.close();
  });

  it("answers a question round-trip", async () => {
    const events: RuntimeEvent[] = [];
    const client = newClient();
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession("q");
    server.setNextTurn("question");
    await client.sendPrompt(sessionId, "which basin?");
    await waitFor(() => events.some((e) => e.type === "question.asked"));

    const asked = events.find(
      (e): e is Extract<RuntimeEvent, { type: "question.asked" }> => e.type === "question.asked",
    )!;
    expect(asked.questions[0].header).toBe("Basin");
    expect(asked.questions[0].options.map((o) => o.label)).toEqual(["Chesapeake", "Great Lakes"]);

    await client.answerQuestion(asked.requestId, [["Chesapeake"]]);
    await waitFor(() => events.some((e) => e.type === "question.resolved"));
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    client.close();
  });

  it("approves a permission round-trip", async () => {
    const events: RuntimeEvent[] = [];
    const client = newClient();
    client.onEvent((e) => events.push(e));
    await client.connect();
    const sessionId = await client.createSession("a");
    server.setNextTurn("approval");
    await client.sendPrompt(sessionId, "clean build");
    await waitFor(() => events.some((e) => e.type === "permission.asked"));

    const asked = events.find(
      (e): e is Extract<RuntimeEvent, { type: "permission.asked" }> => e.type === "permission.asked",
    )!;
    expect(asked.action).toBe("Bash");
    expect(asked.resources).toContain("rm -rf build");

    await client.replyPermission(asked.requestId, "once");
    await waitFor(() => events.some((e) => e.type === "permission.resolved"));
    await waitFor(() => events.some((e) => e.type === "session.idle"));
    client.close();
  });

  it("recovers pending interactions via the jobs/interactions route", async () => {
    const client = newClient();
    await client.connect();
    const sessionId = await client.createSession("recover");
    server.setNextTurn("question");
    await client.sendPrompt(sessionId, "which basin?");
    await new Promise((r) => setTimeout(r, 40));
    const questions = await client.listQuestions();
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0].questions[0].header).toBe("Basin");
    client.close();
  });

  it("lists skills and providers/aliases", async () => {
    const client = newClient();
    const skills = await client.listSkills();
    expect(skills[0].name).toBe("literature-search");
    const providers = await client.listProviders();
    expect(providers.aliases.main).toContain("DeepSeek");
    expect(providers.providers[0].name).toBe("siliconflow");
  });

  it("hides a deleted session locally", async () => {
    const client = newClient();
    await client.connect();
    const keep = await client.createSession("keep");
    const drop = await client.createSession("drop");
    await client.deleteSession(drop);
    const listed = await client.listSessions();
    const ids = listed.map((s) => s.id);
    expect(ids).toContain(keep);
    expect(ids).not.toContain(drop);
    expect(client.deletedSessionIds()).toContain(drop);
    client.close();
  });

  it("reports an error status when the server is unreachable", async () => {
    const client = new MagiClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.connect()).rejects.toBeTruthy();
    expect(client.getStatus()).toBe("error");
  });
});
