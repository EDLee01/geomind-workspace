// A minimal Magi Control-API server for tests and local dev. Node-only.
// Implements the routes MagiClient uses (POST /pairing, POST /sessions,
// GET /sessions, GET /sessions/:id, POST /jobs, GET /jobs, GET /events SSE,
// GET /skills, GET /providers, interaction replies) and streams a Magi-shaped
// audit turn as `event: audit` frames.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockMagi {
  port: number;
  close: () => Promise<void>;
  /** Drive an interactive turn instead of the default streamed one. */
  setNextTurn: (kind: "text" | "question" | "approval") => void;
}

export function startMockMagi(port = 0): Promise<MockMagi> {
  const clients = new Set<ServerResponse>();
  let auditId = 0;
  let nextTurn: "text" | "question" | "approval" = "text";
  const sessions = new Map<string, { id: string; title: string; cwd: string }>();
  const messages = new Map<string, Array<{ role: string; content: string; metadata?: unknown }>>();
  const jobs = new Map<string, { id: string; sessionId: string; status: string }>();
  const pendingInteractions = new Map<
    string,
    Array<Record<string, unknown>>
  >(); // jobId → interactions

  const push = (action: string, sessionId: string, jobId: string, metadata: unknown, target?: string) => {
    const view = { id: ++auditId, sessionId, jobId, action, target, metadata };
    for (const c of clients) c.write(`id: ${view.id}\nevent: audit\ndata: ${JSON.stringify(view)}\n\n`);
  };

  const streamTextTurn = (sessionId: string, jobId: string) => {
    push("agent.request.started", sessionId, jobId, { provider: "mock" });
    push("agent.text.delta", sessionId, jobId, { text: "Planning ", length: 9 });
    push("agent.text.delta", sessionId, jobId, { text: "the analysis. ", length: 14 });
    push("agent.tool.use", sessionId, jobId, { id: "tu1", input: { query: "lakes" } }, "WebSearch");
    push("agent.tool.completed", sessionId, jobId, { toolCallId: "tu1" }, "WebSearch");
    push("agent.text.delta", sessionId, jobId, { text: "Wrote report.md.", length: 16 });
    push("agent.assistant.message", sessionId, jobId, { text: "Planning the analysis. Wrote report.md.", toolUseCount: 0 });
    messages.set(sessionId, [
      { role: "user", content: "run a literature review" },
      { role: "assistant", content: "Planning the analysis. Wrote report.md." },
      { role: "tool", content: "5 results", metadata: { toolName: "WebSearch", toolCallId: "tu1" } },
    ]);
    jobs.set(jobId, { id: jobId, sessionId, status: "completed" });
    push("agent.query.completed", sessionId, jobId, { turns: 1 }, "mock");
  };

  const streamQuestionTurn = (sessionId: string, jobId: string) => {
    const question = {
      questions: [
        {
          question: "Which basin should I focus on?",
          header: "Basin",
          options: [
            { label: "Chesapeake", description: "dense NTN coverage" },
            { label: "Great Lakes", description: "long record" },
          ],
          multiSelect: false,
        },
      ],
    };
    pendingInteractions.set(jobId, [
      { jobId, sessionId, toolUseId: "q1", kind: "question", status: "pending", question },
    ]);
    jobs.set(jobId, { id: jobId, sessionId, status: "running" });
    push("agent.user_question.pending", sessionId, jobId, { toolUseId: "q1", question }, "AskUserQuestion");
  };

  const streamApprovalTurn = (sessionId: string, jobId: string) => {
    const toolUse = { id: "a1", name: "Bash", input: { command: "rm -rf build" } };
    pendingInteractions.set(jobId, [
      { jobId, sessionId, toolUseId: "a1", kind: "approval", status: "pending", toolUse, reason: "destructive command" },
    ]);
    jobs.set(jobId, { id: jobId, sessionId, status: "running" });
    push("agent.approval.pending", sessionId, jobId, { toolUseId: "a1", toolUse, reason: "destructive command" }, "Bash");
  };

  const finishInteraction = (sessionId: string, jobId: string) => {
    pendingInteractions.delete(jobId);
    jobs.set(jobId, { id: jobId, sessionId, status: "completed" });
    push("agent.text.delta", sessionId, jobId, { text: "Done.", length: 5 });
    push("agent.assistant.message", sessionId, jobId, { text: "Done.", toolUseCount: 0 });
    push("agent.query.completed", sessionId, jobId, { turns: 1 }, "mock");
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "POST" && url === "/pairing") {
      return json(res, 200, { deviceId: "dev_mock", token: "tok_mock", expiresAt: "2099-01-01T00:00:00Z" });
    }
    if (method === "GET" && url === "/health") {
      return json(res, 200, { ok: true });
    }
    if (method === "GET" && url.startsWith("/events.json")) {
      return json(res, 200, { events: auditId ? [{ id: auditId }] : [] });
    }
    if (method === "GET" && url.startsWith("/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (method === "POST" && url === "/sessions") {
      const body = await readBody(req);
      const id = `ses_${sessions.size + 1}`;
      const session = { id, title: typeof body.title === "string" ? body.title : "New session", cwd: typeof body.cwd === "string" ? body.cwd : "/ws/mock" };
      sessions.set(id, session);
      return json(res, 200, { session });
    }
    if (method === "GET" && url === "/sessions") {
      return json(res, 200, {
        sessions: [...sessions.values()].map((s) => ({
          id: s.id, title: s.title, cwd: s.cwd, createdAt: "t", updatedAt: "t",
          messageCount: (messages.get(s.id) ?? []).length,
        })),
      });
    }
    const sm = url.match(/^\/sessions\/([^/]+)$/);
    if (method === "GET" && sm) {
      const id = decodeURIComponent(sm[1]);
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: "session not found" });
      return json(res, 200, { session: { ...s, messages: (messages.get(id) ?? []).map((m, i) => ({ id: i, sessionId: id, role: m.role, content: m.content, createdAt: "t", metadata: m.metadata ?? {} })) } });
    }
    if (method === "POST" && url === "/jobs") {
      const body = await readBody(req);
      const sessionId = String(body.sessionId ?? "ses_1");
      const jobId = `job_${jobs.size + 1}`;
      jobs.set(jobId, { id: jobId, sessionId, status: "running" });
      json(res, 202, { sessionId, jobId, status: "running" });
      const run = nextTurn;
      nextTurn = "text";
      setTimeout(() => {
        if (run === "question") streamQuestionTurn(sessionId, jobId);
        else if (run === "approval") streamApprovalTurn(sessionId, jobId);
        else streamTextTurn(sessionId, jobId);
      }, 5);
      return;
    }
    if (method === "GET" && url === "/jobs") {
      return json(res, 200, { jobs: [...jobs.values()] });
    }
    const ji = url.match(/^\/jobs\/([^/]+)\/interactions$/);
    if (method === "GET" && ji) {
      return json(res, 200, { interactions: pendingInteractions.get(decodeURIComponent(ji[1])) ?? [] });
    }
    const jq = url.match(/^\/jobs\/([^/]+)\/questions\/([^/]+)$/);
    if (method === "POST" && jq) {
      const jobId = decodeURIComponent(jq[1]);
      await readBody(req);
      const s = jobs.get(jobId);
      push("agent.user_question.resolved", s?.sessionId ?? "", jobId, { toolUseId: decodeURIComponent(jq[2]) }, "AskUserQuestion");
      if (s) finishInteraction(s.sessionId, jobId);
      return json(res, 200, { ok: true });
    }
    const ja = url.match(/^\/jobs\/([^/]+)\/approvals\/([^/]+)$/);
    if (method === "POST" && ja) {
      const jobId = decodeURIComponent(ja[1]);
      await readBody(req);
      const s = jobs.get(jobId);
      push("agent.approval.resolved", s?.sessionId ?? "", jobId, { toolUseId: decodeURIComponent(ja[2]), approved: true }, "Bash");
      if (s) finishInteraction(s.sessionId, jobId);
      return json(res, 200, { ok: true });
    }
    const jc = url.match(/^\/jobs\/([^/]+)\/(questions|approvals)\/([^/]+)\/cancel$/);
    if (method === "POST" && jc) {
      const jobId = decodeURIComponent(jc[1]);
      await readBody(req);
      const s = jobs.get(jobId);
      const action = jc[2] === "questions" ? "agent.user_question.cancelled" : "agent.approval.cancelled";
      push(action, s?.sessionId ?? "", jobId, { toolUseId: decodeURIComponent(jc[3]) });
      pendingInteractions.delete(jobId);
      return json(res, 200, { ok: true });
    }
    const jcancel = url.match(/^\/jobs\/([^/]+)\/cancel$/);
    if (method === "POST" && jcancel) {
      const jobId = decodeURIComponent(jcancel[1]);
      await readBody(req);
      const s = jobs.get(jobId);
      jobs.set(jobId, { id: jobId, sessionId: s?.sessionId ?? "", status: "cancelled" });
      if (s) push("agent.query.cancelled", s.sessionId, jobId, { reason: "cancelled by user" });
      return json(res, 200, { ok: true, status: "cancelling" });
    }
    if (method === "GET" && url === "/skills") {
      return json(res, 200, { skills: [{ name: "literature-search", root: "/skills/literature-search", summary: "Traceable literature review." }] });
    }
    if (method === "GET" && url === "/providers") {
      return json(res, 200, { providers: [{ name: "siliconflow", type: "openai", defaultModel: "deepseek-ai/DeepSeek-V3", configured: true }], aliases: { main: "siliconflow/deepseek-ai/DeepSeek-V3", fast: "siliconflow/Qwen/Qwen2.5-7B-Instruct" } });
    }
    json(res, 404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        port: actualPort,
        setNextTurn: (k) => (nextTurn = k),
        close: () =>
          new Promise((r) => {
            for (const c of clients) c.end();
            clients.clear();
            server.close(() => r());
          }),
      });
    });
  });
}
