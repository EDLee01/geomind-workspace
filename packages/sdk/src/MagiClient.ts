import type {
  HistoryMessage,
  MagiAuditEvent,
  MagiClientOptions,
  MagiCredentials,
  MagiInteraction,
  MagiJobRecord,
  MagiMessageRecord,
  MagiProvidersResponse,
  MagiSessionSummary,
  PermissionAskedEvent,
  PermissionReply,
  QuestionAskedEvent,
  QuestionItem,
  RuntimeEvent,
  RuntimeStatus,
  SessionMeta,
  SkillInfo,
} from "./types";
import { DEFAULT_MAGI_URL } from "./types";

type EventListener = (event: RuntimeEvent) => void;
type StatusListener = (status: RuntimeStatus) => void;
type CredentialsListener = (creds: MagiCredentials) => void;

/** Per-job streaming state: Magi text deltas are raw chunks the client sums;
 *  a new segment (part id) starts after each tool call so text and tool
 *  blocks interleave in order. */
interface TextSegment {
  sessionId: string;
  seq: number;
  text: string;
  deltaSeen: boolean;
}

/** Input keys worth surfacing as the "resources" of a permission ask. */
const RESOURCE_KEYS = ["command", "file_path", "filePath", "path", "url", "pattern"];

/**
 * The single boundary between the app and the Magi agent runtime.
 * Talks to a running `magi serve` (Control API): plain HTTP for actions and
 * the `GET /events` SSE audit stream for everything live. The UI must go
 * through this class, never the transport directly (see AGENTS.md guardrails).
 *
 * Reply routing: every interactive request id is `<jobId>:<toolUseId>` — the
 * two halves address Magi's reply routes directly.
 */
export class MagiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly directory: string | null;
  private readonly deviceName: string;
  private creds: MagiCredentials | null;
  /** When true, a reverse proxy authenticates to the daemon; this client sends
   *  no Authorization header and never pairs. */
  private readonly proxyAuth: boolean;
  private model: string;
  private status: RuntimeStatus = "offline";
  private abort: AbortController | null = null;
  private readonly eventListeners = new Set<EventListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly credentialsListeners = new Set<CredentialsListener>();
  private readonly textSegments = new Map<string, TextSegment>();
  /** sessionId → the currently running job the client started. */
  private readonly runningJobs = new Map<string, string>();
  /** requestId → question payload, kept to shape the reply body. */
  private readonly pendingQuestions = new Map<string, QuestionItem[]>();
  /** Locally hidden sessions — Magi has no session-delete route yet. */
  private readonly deletedSessions: Set<string>;

  constructor(opts: MagiClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_MAGI_URL).replace(/\/$/, "");
    // Bind to globalThis — an unbound `fetch` reference throws "Illegal invocation" in browsers.
    this.fetchImpl = (opts.fetchImpl ?? globalThis.fetch).bind(globalThis);
    this.directory = opts.directory ?? null;
    this.deviceName = opts.deviceName ?? "geomind-desktop";
    this.creds = opts.deviceId && opts.token ? { deviceId: opts.deviceId, token: opts.token } : null;
    this.proxyAuth = opts.proxyAuth ?? false;
    this.model = opts.model ?? "main";
    this.deletedSessions = new Set(opts.deletedSessionIds ?? []);
  }

  getStatus(): RuntimeStatus {
    return this.status;
  }
  onEvent(l: EventListener): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }
  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }
  /** Fires when the client (re)pairs, so the app can persist the credentials. */
  onCredentials(l: CredentialsListener): () => void {
    this.credentialsListeners.add(l);
    return () => this.credentialsListeners.delete(l);
  }
  credentials(): MagiCredentials | null {
    return this.creds;
  }

  /** The model alias sent with every job ("main", "fast", "deep", "auto"). */
  getModel(): string {
    return this.model;
  }
  setModel(alias: string): void {
    this.model = alias;
  }

  /** Session ids hidden locally (persist these across restarts). */
  deletedSessionIds(): string[] {
    return [...this.deletedSessions];
  }

  // ---- auth ----

  /** Mint a device token via POST /pairing. Loopback-only on the Magi side.
   *  No-op in proxyAuth mode — the reverse proxy handles daemon auth. */
  private async pair(): Promise<void> {
    if (this.proxyAuth) return;
    const res = await this.fetchImpl(`${this.baseUrl}/pairing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.deviceName }),
    });
    if (!res.ok) throw new Error(`Magi pairing failed (${res.status})`);
    const token = (await res.json()) as { deviceId: string; token: string };
    this.creds = { deviceId: token.deviceId, token: token.token };
    this.credentialsListeners.forEach((l) => l(this.creds!));
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    // In proxyAuth mode the Authorization header is left untouched so the
    // reverse proxy's own auth (e.g. browser HTTP basic auth) rides on it.
    if (!this.proxyAuth && this.creds) {
      h["X-Magi-Device-Id"] = this.creds.deviceId;
      h["Authorization"] = `Bearer ${this.creds.token}`;
    }
    return h;
  }

  /** Authenticated fetch. Pairs on first use and re-pairs once on 401 —
   *  control-API-minted tokens expire (Magi default TTL is short). In
   *  proxyAuth mode there is nothing to pair and a 401 comes from the proxy. */
  private async fetchAuthed(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.proxyAuth && !this.creds) await this.pair();
    const doFetch = () =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(init.body !== undefined), ...(init.headers ?? {}) },
      });
    let res = await doFetch();
    if (res.status === 401 && !this.proxyAuth) {
      await this.pair();
      res = await doFetch();
    }
    return res;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchAuthed(path, init);
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = `: ${body.error}`;
      } catch {
        /* no JSON body */
      }
      throw new Error(`Magi ${init.method ?? "GET"} ${path} failed (${res.status})${detail}`);
    }
    return (await res.json()) as T;
  }

  // ---- event stream ----

  /** Open the audit SSE stream. Resolves once the server acknowledges.
   *  History is NOT replayed into the stream (the thread is rebuilt from
   *  `getMessages`): the client reads the current tail id first and asks for
   *  `?after=` it, so only live events arrive. */
  async connect(): Promise<void> {
    this.setStatus("connecting");
    try {
      if (!this.creds) await this.pair();
      const tail = await this.requestJson<{ events: Array<{ id: number }> }>(
        "/events.json?limit=1",
      );
      const after = tail.events[0]?.id;
      this.abort = new AbortController();
      const res = await this.fetchAuthed(
        `/events${after !== undefined ? `?after=${after}` : ""}`,
        { headers: { Accept: "text/event-stream" }, signal: this.abort.signal },
      );
      if (!res.ok || !res.body) {
        this.setStatus("error");
        throw new Error(`Magi /events returned ${res.status}`);
      }
      this.setStatus("ready");
      void this.readStream(res.body);
    } catch (err) {
      if (this.status !== "ready") this.setStatus("error");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  close(): void {
    this.abort?.abort();
    this.abort = null;
    this.setStatus("offline");
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleSseChunk(chunk);
        }
      }
    } catch {
      // aborted or connection dropped
    } finally {
      this.setStatus("offline");
    }
  }

  private handleSseChunk(chunk: string): void {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      // `id:` lines and `:` heartbeat comments are ignored.
    }
    if (eventName !== "audit" || dataLines.length === 0) return;
    try {
      this.normalize(JSON.parse(dataLines.join("\n")) as MagiAuditEvent);
    } catch {
      /* ignore malformed frame */
    }
  }

  // ---- audit → app-event normalization ----

  private normalize(ev: MagiAuditEvent): void {
    const meta = ev.metadata ?? {};
    const sessionId = ev.sessionId ?? "";
    const jobId = ev.jobId ?? "";
    switch (ev.action) {
      case "agent.text.delta": {
        if (!jobId || typeof meta.text !== "string" || meta.text.length === 0) return;
        const seg = this.segment(jobId, sessionId);
        seg.text += meta.text;
        seg.deltaSeen = true;
        this.emit({
          type: "text.updated",
          sessionId,
          partId: `${jobId}#${seg.seq}`,
          text: seg.text,
        });
        return;
      }
      case "agent.assistant.message": {
        // Streamed turns already showed this text via deltas. Non-streamed
        // turns (or providers without SSE) surface it here instead.
        if (!jobId) return;
        const seg = this.segment(jobId, sessionId);
        if (!seg.deltaSeen && typeof meta.text === "string" && meta.text.trim()) {
          seg.text += meta.text;
          this.emit({
            type: "text.updated",
            sessionId,
            partId: `${jobId}#${seg.seq}`,
            text: seg.text,
          });
        }
        // A message boundary: whatever text follows belongs to a new part.
        this.rollSegment(jobId, sessionId);
        return;
      }
      case "agent.tool.use": {
        if (jobId) this.rollSegment(jobId, sessionId);
        const input = isRecord(meta.input) ? meta.input : undefined;
        this.emit({
          type: "tool.updated",
          sessionId,
          callId: String(meta.id ?? ""),
          tool: ev.target ?? "tool",
          status: "running",
          input,
        });
        return;
      }
      case "agent.tool.completed":
      case "agent.tool.failed": {
        const failed = ev.action === "agent.tool.failed";
        // Prefer the tool output carried on the event itself; fall back to the
        // failure reason (older daemons that don't inline output on failures).
        const output =
          typeof meta.output === "string"
            ? meta.output
            : failed && typeof meta.reason === "string"
              ? meta.reason
              : undefined;
        this.emit({
          type: "tool.updated",
          sessionId,
          callId: String(meta.toolCallId ?? ""),
          tool: ev.target ?? "tool",
          status: failed ? "failed" : "success",
          output,
        });
        return;
      }
      case "agent.approval.pending": {
        const toolUse = isRecord(meta.toolUse) ? meta.toolUse : undefined;
        const input = toolUse && isRecord(toolUse.input) ? toolUse.input : undefined;
        this.emit({
          type: "permission.asked",
          sessionId,
          requestId: `${jobId}:${String(meta.toolUseId ?? "")}`,
          action: ev.target ?? "tool",
          resources: permissionResources(input, meta.reason),
        });
        return;
      }
      case "agent.approval.resolved":
      case "agent.approval.timeout":
      case "agent.approval.cancelled":
      case "agent.approval.auto_resolved":
      case "control.approval.resolved":
      case "control.approval.cancelled": {
        this.emit({
          type: "permission.resolved",
          sessionId,
          requestId: `${jobId}:${String(meta.toolUseId ?? "")}`,
        });
        return;
      }
      case "agent.user_question.pending": {
        const requestId = `${jobId}:${String(meta.toolUseId ?? "")}`;
        const questions = mapQuestions(meta.question);
        this.pendingQuestions.set(requestId, questions);
        this.emit({ type: "question.asked", sessionId, requestId, questions });
        return;
      }
      case "agent.user_question.resolved":
      case "agent.user_question.timeout":
      case "agent.user_question.cancelled":
      case "agent.user_question.auto_resolved":
      case "control.user_question.resolved":
      case "control.user_question.cancelled": {
        const requestId = `${jobId}:${String(meta.toolUseId ?? "")}`;
        this.pendingQuestions.delete(requestId);
        this.emit({ type: "question.resolved", sessionId, requestId });
        return;
      }
      case "agent.query.completed": {
        this.finishJob(jobId, sessionId);
        this.emit({ type: "session.idle", sessionId });
        return;
      }
      case "agent.query.cancelled": {
        this.finishJob(jobId, sessionId);
        this.emit({ type: "session.idle", sessionId });
        return;
      }
      case "agent.query.failed": {
        this.finishJob(jobId, sessionId);
        const message =
          typeof meta.error === "string" && meta.error ? meta.error : "agent run failed";
        // First line only — Magi appends stack traces to some errors.
        this.emit({ type: "error", sessionId, message: message.split("\n")[0] });
        return;
      }
      default:
        return; // control.*, cron.*, memory.*, hook and telemetry events
    }
  }

  private segment(jobId: string, sessionId: string): TextSegment {
    let seg = this.textSegments.get(jobId);
    if (!seg) {
      seg = { sessionId, seq: 0, text: "", deltaSeen: false };
      this.textSegments.set(jobId, seg);
    }
    return seg;
  }

  /** Close the current text part; the next delta starts a fresh one. */
  private rollSegment(jobId: string, sessionId: string): void {
    const seg = this.segment(jobId, sessionId);
    if (seg.text) {
      seg.seq += 1;
      seg.text = "";
    }
    seg.deltaSeen = false;
  }

  private finishJob(jobId: string, sessionId: string): void {
    this.textSegments.delete(jobId);
    if (this.runningJobs.get(sessionId) === jobId) this.runningJobs.delete(sessionId);
  }

  private emit(event: RuntimeEvent): void {
    this.eventListeners.forEach((l) => l(event));
  }
  private setStatus(status: RuntimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  // ---- sessions ----

  /** Create a session in the client's workspace directory. Pass the first
   *  message as `title` — Magi has no retitle route, so the list name is
   *  fixed at creation. */
  async createSession(title?: string): Promise<string> {
    const body: Record<string, unknown> = {};
    if (this.directory) body.cwd = this.directory;
    if (title?.trim()) body.title = title.trim().slice(0, 80);
    const json = await this.requestJson<{ session: { id: string } }>("/sessions", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return json.session.id;
  }

  /** List sessions (newest first, server caps at 50), minus locally deleted. */
  async listSessions(): Promise<SessionMeta[]> {
    const json = await this.requestJson<{ sessions: MagiSessionSummary[] }>("/sessions");
    return json.sessions
      .filter((s) => !this.deletedSessions.has(s.id))
      .map((s) => ({
        id: s.id,
        title: s.title?.trim() || "Untitled",
        directory: s.cwd,
        messageCount: s.messageCount,
      }));
  }

  /** Hide a session locally. Magi's Control API has no delete route (the
   *  store deletes the row + cascades messages. We also record the id in
   *  `deletedSessions` (persisted via `deletedSessionIds()`) so the session
   *  hides immediately and stays hidden against daemons too old to have the
   *  route. A 409 (session has a running job) is surfaced to the caller. */
  async deleteSession(sessionId: string): Promise<void> {
    const res = await this.fetchAuthed(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    // 404 → either already gone or the daemon predates this route; either way
    // the local hide below is the correct outcome, so don't throw.
    if (!res.ok && res.status !== 404) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) detail = `: ${body.error}`;
      } catch {
        /* no JSON body */
      }
      throw new Error(`Magi DELETE /sessions/${sessionId} failed (${res.status})${detail}`);
    }
    this.deletedSessions.add(sessionId);
  }

  /** Load a session's message history. Magi stores flat role/content rows;
   *  tool-result rows become tool parts appended to the assistant flow. */
  async getMessages(sessionId: string): Promise<HistoryMessage[]> {
    const json = await this.requestJson<{ session: { messages: MagiMessageRecord[] } }>(
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    const out: HistoryMessage[] = [];
    for (const m of json.session.messages ?? []) {
      if (m.role === "user") {
        if (m.content.trim()) out.push({ role: "user", parts: [{ type: "text", text: m.content }] });
      } else if (m.role === "assistant") {
        if (m.content.trim())
          out.push({ role: "assistant", parts: [{ type: "text", text: m.content }] });
      } else if (m.role === "tool") {
        const isError = m.metadata?.isError === true;
        const part = {
          type: "tool" as const,
          tool: typeof m.metadata?.toolName === "string" ? m.metadata.toolName : "tool",
          state: {
            status: isError ? ("error" as const) : ("completed" as const),
            output: m.content,
          },
        };
        const last = out[out.length - 1];
        if (last?.role === "assistant") last.parts.push(part);
        else out.push({ role: "assistant", parts: [part] });
      }
      // other roles (system, summaries) are not part of the visible thread
    }
    return out;
  }

  // ---- turns ----

  /** Send a prompt as a background Magi job; output streams via onEvent.
   *  Returns the job id (also tracked internally for cancelTurn). */
  async sendPrompt(sessionId: string, text: string): Promise<string> {
    const json = await this.requestJson<{ jobId: string }>("/jobs", {
      method: "POST",
      body: JSON.stringify({
        prompt: text,
        sessionId,
        background: true,
        model: this.model,
      }),
    });
    this.runningJobs.set(sessionId, json.jobId);
    return json.jobId;
  }

  /** Abort the session's running job, if the client started one. */
  async cancelTurn(sessionId: string): Promise<boolean> {
    let jobId = this.runningJobs.get(sessionId);
    if (!jobId) {
      const jobs = await this.requestJson<{ jobs: MagiJobRecord[] }>("/jobs");
      jobId = jobs.jobs.find((j) => j.sessionId === sessionId && j.status === "running")?.id;
    }
    if (!jobId) return false;
    await this.requestJson(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "cancelled by user" }),
    });
    return true;
  }

  // ---- interactive requests (question / permission) ----

  /** Pending questions across running jobs (recovery on open). */
  async listQuestions(_sessionId?: string): Promise<QuestionAskedEvent[]> {
    const pending = await this.listPendingInteractions();
    return pending
      .filter((i) => i.kind === "question")
      .map((i) => {
        const requestId = `${i.jobId}:${i.toolUseId}`;
        const questions = mapQuestions(i.question);
        this.pendingQuestions.set(requestId, questions);
        return { type: "question.asked" as const, sessionId: i.sessionId, requestId, questions };
      });
  }

  /** Pending permission requests across running jobs (recovery on open). */
  async listPermissions(_sessionId?: string): Promise<PermissionAskedEvent[]> {
    const pending = await this.listPendingInteractions();
    return pending
      .filter((i) => i.kind === "approval")
      .map((i) => ({
        type: "permission.asked" as const,
        sessionId: i.sessionId,
        requestId: `${i.jobId}:${i.toolUseId}`,
        action: i.toolUse?.name ?? "tool",
        resources: permissionResources(i.toolUse?.input, i.reason),
      }));
  }

  private async listPendingInteractions(): Promise<MagiInteraction[]> {
    const jobs = await this.requestJson<{ jobs: MagiJobRecord[] }>("/jobs");
    const running = jobs.jobs.filter((j) => j.status === "running");
    const results = await Promise.all(
      running.map(async (job) => {
        try {
          const body = await this.requestJson<{ interactions: MagiInteraction[] }>(
            `/jobs/${encodeURIComponent(job.id)}/interactions`,
          );
          return body.interactions.filter((i) => i.status === "pending");
        } catch {
          return [] as MagiInteraction[];
        }
      }),
    );
    return results.flat();
  }

  /** Answer a question: one array of selected labels per question, in order. */
  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const { jobId, toolUseId } = splitRequestId(requestId);
    let questions = this.pendingQuestions.get(requestId);
    if (!questions) {
      // Recover the payload (e.g. after a reload) so the reply names each question.
      const pending = await this.listPendingInteractions();
      const hit = pending.find((i) => i.jobId === jobId && i.toolUseId === toolUseId);
      questions = mapQuestions(hit?.question);
    }
    const body = {
      answers: questions.map((q, i) => ({
        question: q.question,
        selectedLabels: answers[i] ?? [],
      })),
    };
    await this.requestJson(
      `/jobs/${encodeURIComponent(jobId)}/questions/${encodeURIComponent(toolUseId)}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    this.pendingQuestions.delete(requestId);
  }

  /** Reject/dismiss a question (the job receives a cancellation). */
  async rejectQuestion(requestId: string): Promise<void> {
    const { jobId, toolUseId } = splitRequestId(requestId);
    await this.requestJson(
      `/jobs/${encodeURIComponent(jobId)}/questions/${encodeURIComponent(toolUseId)}/cancel`,
      { method: "POST", body: JSON.stringify({ reason: "dismissed by user" }) },
    );
    this.pendingQuestions.delete(requestId);
  }

  /** Reply to a permission request. Magi approvals are one-shot booleans. */
  async replyPermission(requestId: string, reply: PermissionReply): Promise<void> {
    const { jobId, toolUseId } = splitRequestId(requestId);
    await this.requestJson(
      `/jobs/${encodeURIComponent(jobId)}/approvals/${encodeURIComponent(toolUseId)}`,
      { method: "POST", body: JSON.stringify({ approved: reply === "once" }) },
    );
  }

  // ---- catalog ----

  /** Skills installed in the Magi profile (global skills dir). */
  async listSkills(): Promise<SkillInfo[]> {
    const json = await this.requestJson<{
      skills: Array<{ name: string; root: string; summary: string }>;
    }>("/skills");
    return json.skills.map((s) => ({ name: s.name, description: s.summary, location: s.root }));
  }

  /** Configured providers and the model-alias map from the daemon's config. */
  async listProviders(): Promise<MagiProvidersResponse> {
    return this.requestJson<MagiProvidersResponse>("/providers");
  }
}

// ---- helpers ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function splitRequestId(requestId: string): { jobId: string; toolUseId: string } {
  const sep = requestId.indexOf(":");
  if (sep === -1) throw new Error(`malformed request id: ${requestId}`);
  return { jobId: requestId.slice(0, sep), toolUseId: requestId.slice(sep + 1) };
}

function permissionResources(
  input: Record<string, unknown> | undefined,
  reason: unknown,
): string[] {
  const resources: string[] = [];
  if (input) {
    for (const key of RESOURCE_KEYS) {
      const v = input[key];
      if (typeof v === "string" && v.trim()) resources.push(v);
    }
  }
  if (resources.length === 0 && typeof reason === "string" && reason.trim()) {
    resources.push(reason);
  }
  return resources;
}

function mapQuestions(question: unknown): QuestionItem[] {
  if (!isRecord(question) || !Array.isArray(question.questions)) return [];
  return question.questions.filter(isRecord).map((q) => ({
    question: typeof q.question === "string" ? q.question : "",
    header: typeof q.header === "string" ? q.header : "",
    options: Array.isArray(q.options)
      ? q.options.filter(isRecord).map((o) => ({
          label: typeof o.label === "string" ? o.label : "",
          description: typeof o.description === "string" ? o.description : undefined,
        }))
      : [],
    multiple: q.multiSelect === true,
    // Magi accepts free-text labels in replies, so custom input is always available.
    custom: true,
  }));
}
