import type { RuntimeStatus, ToolCallStatus } from "@ai4s/shared";

export type { RuntimeStatus, ToolCallStatus };

/** Magi release this client targets (github.com/EDLee01/magi). */
export const MAGI_VERSION = "0.1.13";

/** Magi control server default (`magi serve`). */
export const DEFAULT_MAGI_URL = "http://127.0.0.1:8765";

// ---- Normalized events (Magi audit SSE → app) ----
// Magi streams an append-only AUDIT log over `GET /events` (SSE, `event: audit`
// frames). The client folds those records into the idempotent events below:
// text/tool events carry a stable id and the app upserts by that id.

export interface TextUpdatedEvent {
  type: "text.updated";
  sessionId: string;
  /** Synthetic segment id (`<jobId>#<n>`) — a new segment starts after each
   *  tool call, so text and tool blocks interleave in order. */
  partId: string;
  text: string;
}
export interface ToolUpdatedEvent {
  type: "tool.updated";
  sessionId: string;
  callId: string;
  tool: string;
  status: ToolCallStatus;
  title?: string;
  /** Tool arguments (from `agent.tool.use` metadata.input). */
  input?: Record<string, unknown>;
  /** Tool result text. Magi only carries it on FAILURE (the error reason);
   *  successful outputs land in session history, not the audit stream. */
  output?: string;
  /** Reserved: Magi does not announce subagent sessions on the parent's
   *  stream, so this is currently never set. */
  childSessionId?: string;
}
export interface SessionIdleEvent {
  type: "session.idle";
  sessionId: string;
}

// ---- Interactive requests (the agent asks; the user must answer) ----
// Magi blocks the running job until answered (default timeout 300 s; the
// desktop shell raises it via MAGI_INTERACTION_TIMEOUT_MS at spawn). Two
// kinds: a `question` (AskUserQuestion) and a `permission` (tool approval).
// The requestId encodes the reply route: `<jobId>:<toolUseId>`.

export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionItem {
  question: string;
  header: string;
  options: QuestionOption[];
  /** Allow selecting more than one option (Magi: `multiSelect`). */
  multiple?: boolean;
  /** Allow a free-text answer in addition to the options. */
  custom?: boolean;
}
export interface QuestionAskedEvent {
  type: "question.asked";
  sessionId: string;
  requestId: string;
  questions: QuestionItem[];
}
/** A question was answered/rejected/timed out elsewhere — clear it from the UI. */
export interface QuestionResolvedEvent {
  type: "question.resolved";
  sessionId: string;
  requestId: string;
}

export interface PermissionAskedEvent {
  type: "permission.asked";
  sessionId: string;
  requestId: string;
  /** The tool asking for approval, e.g. "Bash", "Write". */
  action: string;
  /** Concrete targets pulled from the tool input (command line, file paths),
   *  plus Magi's human-readable reason when present. */
  resources: string[];
}
export interface PermissionResolvedEvent {
  type: "permission.resolved";
  sessionId: string;
  requestId: string;
}
export interface RuntimeErrorEvent {
  type: "error";
  sessionId?: string;
  message: string;
}

export type RuntimeEvent =
  | TextUpdatedEvent
  | ToolUpdatedEvent
  | SessionIdleEvent
  | RuntimeErrorEvent
  | QuestionAskedEvent
  | QuestionResolvedEvent
  | PermissionAskedEvent
  | PermissionResolvedEvent;

/** Approve a permission once, or reject it. Magi approvals are one-shot
 *  booleans — there is no server-side "always allow" rule store. */
export type PermissionReply = "once" | "reject";

// ---- REST shapes the app consumes ----

export interface SessionMeta {
  id: string;
  title: string;
  /** Workspace folder this session operates in (absolute path; Magi `cwd`). */
  directory?: string;
  /** Message count from the session summary. */
  messageCount?: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  location?: string;
}

/** A message loaded from history (GET /sessions/:id → messages[]).
 *  Magi stores flat role/content rows; the client folds `tool` rows into the
 *  surrounding assistant message as tool parts. */
export interface HistoryMessage {
  role: "user" | "assistant";
  parts: HistoryPart[];
}
export interface HistoryPart {
  type: "text" | "tool";
  text?: string;
  /** Runtime-generated marker text (kept for parity with the thread reducer;
   *  Magi never sets it). */
  synthetic?: boolean;
  tool?: string;
  state?: {
    status?: "completed" | "error" | "running" | "pending";
    /** A short title for the tool row. Magi history has none; the reducer
     *  falls back to the tool name. */
    title?: string;
    /** Tool arguments. Not present in Magi history (only live). */
    input?: Record<string, unknown>;
    output?: string;
  };
}

// ---- Model / provider configuration (Magi-native) ----
// Magi's currency is model ALIASES (`main`, `fast`, `deep`, `auto`) resolved
// server-side from config.yaml. The client sends the chosen alias with every
// job; there is no server-held "default model" to write.

export interface MagiProviderInfo {
  name: string;
  type: string;
  defaultModel: string;
  /** False when the provider's API-key env var is not set on the daemon. */
  configured: boolean;
}

export interface MagiProvidersResponse {
  providers: MagiProviderInfo[];
  /** alias → "provider/model" (or bare model) as configured in config.yaml. */
  aliases: Record<string, string>;
}

export interface MagiClientOptions {
  /** Base URL of a running `magi serve`, e.g. http://127.0.0.1:8765 */
  baseUrl?: string;
  /** Pre-paired device credentials (the desktop shell reads the daemon's
   *  self-minted pair from control-credentials.json). When absent the client
   *  auto-pairs via POST /pairing — loopback only. */
  deviceId?: string;
  token?: string;
  /** Device name used when auto-pairing. */
  deviceName?: string;
  /** Inject fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Workspace directory new sessions are created in (Magi session cwd). */
  directory?: string;
  /** Model alias sent with every job. Default "main". */
  model?: string;
  /** Hosted-behind-a-reverse-proxy mode: the proxy authenticates to the daemon
   *  (injects the device token) and gates access itself (e.g. HTTP basic auth).
   *  The client then sends NO `Authorization` header — leaving it free for the
   *  proxy's own auth scheme — and skips pairing entirely. */
  proxyAuth?: boolean;
  /** Session ids the user deleted locally (Magi has no delete route yet);
   *  the client filters them out of listSessions and adds to it. */
  deletedSessionIds?: string[];
}

export interface MagiCredentials {
  deviceId: string;
  token: string;
}

// ---- Raw Magi wire shapes (subset we consume) ----

/** One audit record as served by GET /events (Magi's `MagiEventView`). */
export interface MagiAuditEvent {
  id: number;
  sessionId: string;
  jobId?: string;
  action: string;
  status?: string;
  target?: string;
  createdAt?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface MagiSessionSummary {
  id: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface MagiMessageRecord {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface MagiJobRecord {
  id: string;
  sessionId: string;
  kind: string;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface MagiInteraction {
  jobId: string;
  sessionId: string;
  toolUseId: string;
  kind: "approval" | "question";
  status: "pending" | "resolved" | "timeout" | "cancelled";
  toolUse?: { id: string; name: string; input?: Record<string, unknown> };
  reason?: string;
  question?: {
    questions: Array<{
      question: string;
      header?: string;
      options: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }>;
  };
}
