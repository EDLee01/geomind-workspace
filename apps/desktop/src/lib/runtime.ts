import { create } from "zustand";
import {
  MagiClient,
  DEFAULT_MAGI_URL,
  type HistoryMessage,
  type RuntimeEvent,
  type PermissionAskedEvent,
  type PermissionReply,
  type QuestionAskedEvent,
  type SessionMeta,
  type SkillInfo,
  type ToolCallStatus,
} from "@ai4s/sdk";
import type { ArtifactBlock, RuntimeStatus, ThreadBlock } from "@ai4s/shared";
import {
  detectTools as probeTools,
  isTauri,
  logDebug,
  newDatedWorkspace,
  setWorkspace,
  startRuntime,
  workspacePath,
  type ToolStatus,
} from "./tauri";
import { kernelReset } from "./kernel";
import { moveScrollMemory } from "./scrollMemory";
import { deriveArtifact } from "./artifacts";
import { provenanceInputFromEvent, recordProvenance } from "./provenance";
import { splitReview } from "./review";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const URL_KEY = "ai4s.magiUrl";
const HIDDEN_KEY = "ai4s.hiddenExamples";

function initialUrl(): string {
  if (typeof window === "undefined") return DEFAULT_MAGI_URL;
  return window.localStorage.getItem(URL_KEY) ?? DEFAULT_MAGI_URL;
}
function initialHidden(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export interface Thread {
  blocks: ThreadBlock[];
  index: Record<string, number>;
  loaded: boolean;
}

/** What a session's right pane shows: an artifact inspector, the Files
 *  browser, or nothing. The two are mutually exclusive — one pane. */
export interface PaneState {
  artifact: ArtifactBlock | null;
  showFiles: boolean;
}

interface RuntimeState {
  status: RuntimeStatus;
  serverUrl: string;
  sessions: SessionMeta[];
  currentId: string | null;
  threads: Record<string, Thread>;
  skills: SkillInfo[];
  /** The "/" palette: Magi has no slash-command catalog route, so this mirrors
   *  the installed skills (the only runnable "/name" items). */
  commands: Array<{ name: string; description?: string; source?: string }>;
  /** Model aliases the runtime exposes ("main", "fast", "deep", "auto"). */
  modelAliases: string[];
  /** The alias sent with every turn (Magi resolves it server-side). */
  model: string;
  tools: ToolStatus[];
  hiddenExamples: string[];
  error: string | null;
  /** Pending interactive requests the agent is blocked on, newest last. */
  questions: QuestionAskedEvent[];
  permissions: PermissionAskedEvent[];
  /** Right-pane state per session (DRAFT_KEY for a draft) — each session keeps
   *  its own open artifact / Files browser and gets it back when reopened.
   *  In-memory only: an app restart returns every session to a closed pane. */
  panes: Record<string, PaneState>;
  openArtifact: (a: ArtifactBlock) => void;
  closeArtifact: () => void;
  setShowFiles: (show: boolean) => void;
  answerQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  rejectQuestion: (requestId: string) => Promise<void>;
  replyPermission: (requestId: string, reply: PermissionReply) => Promise<void>;
  setServerUrl: (url: string) => void;
  /** Switch the model alias sent with every turn. */
  setModel: (alias: string) => void;
  loadCatalog: () => Promise<void>;
  detectTools: () => Promise<void>;
  connect: () => Promise<void>;
  connectRetry: (tries?: number) => Promise<void>;
  bootstrap: () => Promise<void>;
  disconnect: () => void;
  refreshSessions: () => Promise<void>;
  startDraft: () => void;
  /** Active workspace folder (absolute path); null in the browser. */
  workspace: string | null;
  /** True when the user explicitly picked the active folder for the next new
   *  session; false means a new session gets its own fresh dated folder. */
  workspacePinned: boolean;
  /** A deliberate workspace move is in flight (event-stream reconnect into the
   *  new folder). The UI must not present it as a disconnection — no status
   *  flip, no Connect button, no help card. Real failures surface after the
   *  retry window is exhausted, once this clears. */
  switching: boolean;
  /** A sendPrompt is in flight (click → POST accepted). Locks the composer. */
  sending: boolean;
  /** Sessions with an active turn (send accepted, session.idle not yet seen).
   *  Drives the composer lock and the "Working…" indicator. */
  runningSessions: Record<string, true>;
  /** Sessions whose current turn is a user-typed "!" shell command. Their bash
   *  output shows inline in the thread — the output IS the result the user
   *  asked for. Agent bash steps stay quiet single-line log entries. */
  shellTurns: Record<string, true>;
  /** Switch to an existing folder, or (with `dated`) create a new dated one. */
  switchWorkspace: (target: { path: string } | { dated: string }) => Promise<void>;
  openSession: (id: string) => Promise<void>;
  sendPrompt: (text: string) => Promise<string | null>;
  /** Run a "!" shell command directly in the session's workspace folder —
   *  no model turn; the output folds into the thread as a bash tool row. */
  runShell: (command: string) => Promise<string | null>;
  /** Run a "/" slash command (config command / skill / MCP prompt). */
  runCommand: (name: string, args?: string) => Promise<string | null>;
  deleteSession: (id: string) => Promise<void>;
  hideExample: (id: string) => void;
  installSkill: (text: string) => Promise<string | null>;
}

let client: MagiClient | null = null;
const emptyThread = (): Thread => ({ blocks: [], index: {}, loaded: false });
/** Threads key for the draft conversation — its blocks move to the real
 *  session id once the session exists, so the page never visibly resets. */
export const DRAFT_KEY = "draft";
/** One bounded retry for the first POSTs after a sidecar restart — the old
 *  connection occasionally dies mid-handshake ("Load failed"). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await sleep(600);
    return await fn();
  }
}
/** Tool calls already written to provenance — success events can repeat per callId. */
const recordedProvenance = new Set<string>();

/** Last SSE arrival per session (monotonic sequence, not wall time). Lets a
 *  failed sync POST tell "the connection died but the turn is alive" (events
 *  kept arriving after the POST began) from "the send never took" — WKWebView
 *  kills any fetch at ~60 s, long before a long agent turn finishes. */
let sseSeq = 0;
const sseLast = new Map<string, number>();

/** Resolve a (possibly nested) subagent session to its top-level session —
 *  a subagent's question/permission belongs to the conversation the user sees. */
export function rootSessionOf(parents: Record<string, string>, sessionId: string): string {
  let cur = sessionId;
  for (let hop = 0; parents[cur] && hop < 10; hop++) cur = parents[cur];
  return cur;
}

type StoreSet = {
  (partial: Partial<RuntimeState>): void;
  (fn: (s: RuntimeState) => Partial<RuntimeState>): void;
};
type StoreGet = () => RuntimeState;

/**
 * The one send lifecycle (new → input → send → response), shared by plain
 * prompts, "!" shell commands and "/" slash commands:
 *   1. `echo` lands in the thread IMMEDIATELY — on a draft under DRAFT_KEY,
 *      grafted onto the real session id later, so the page never resets.
 *   2. `sending` is true from click until the POST is accepted (locks the
 *      composer); the session sits in `runningSessions` while the turn runs.
 *   3. Failures land as a red status line inside the conversation.
 * `syncTurn` marks endpoints whose POST resolves only when the turn is OVER
 * (shell/command, unlike prompt_async) — their running lock is set BEFORE the
 * POST and cleared when it settles, because session.idle arrives before the
 * POST resolves and a lock set afterwards would never clear.
 * `shell` additionally marks the turn in `shellTurns` for its duration, so
 * the event fold shows the bash output inline.
 */
async function performTurn(
  set: StoreSet,
  get: StoreGet,
  echo: string,
  post: (sid: string) => Promise<unknown>,
  syncTurn: boolean,
  shell = false,
): Promise<string | null> {
  if (!client) {
    set({ error: "Not connected to the Magi runtime." });
    return null;
  }
  if (get().sending) return null; // one send at a time
  const echoKey = get().currentId ?? DRAFT_KEY;
  set((s) => {
    const cur = s.threads[echoKey] ?? emptyThread();
    return {
      sending: true,
      threads: {
        ...s.threads,
        [echoKey]: { ...cur, loaded: true, blocks: [...cur.blocks, { kind: "user", text: echo }] },
      },
    };
  });
  try {
    let id = get().currentId;
    if (!id) {
      // Lazy-create the session on the first message (#3). Unless the user
      // pinned a folder via the workspace switcher, a new session gets its
      // own fresh dated folder (~/Documents/OpenScience/<date-time>) first,
      // so its files never pile up in the bare base folder.
      if (isTauri && !get().workspacePinned) {
        set({ switching: true });
        try {
          await newDatedWorkspace(datedWorkspaceName());
          await kernelReset().catch(() => {});
          await get().connectRetry();
        } finally {
          set({ switching: false });
        }
        if (get().status !== "ready" || !client) {
          throw new Error("Runtime did not reconnect after creating the session folder.");
        }
      }
      id = await withRetry(() => client!.createSession());
      set((s) => {
        // Graft the draft conversation (and its pane) onto the real session id.
        const threads = { ...s.threads, [id!]: s.threads[DRAFT_KEY] ?? emptyThread() };
        delete threads[DRAFT_KEY];
        const panes = { ...s.panes };
        if (panes[DRAFT_KEY]) {
          panes[id!] = panes[DRAFT_KEY];
          delete panes[DRAFT_KEY];
        }
        return { currentId: id, threads, panes };
      });
      moveScrollMemory(`chat:${DRAFT_KEY}`, `chat:${id}`);
      void get().refreshSessions();
    }
    const sid = id;
    void logDebug(`turn → ${sid}`);
    if (syncTurn) {
      set((s) => ({
        runningSessions: { ...s.runningSessions, [sid]: true },
        ...(shell ? { shellTurns: { ...s.shellTurns, [sid]: true as const } } : {}),
      }));
      const mark = sseSeq;
      try {
        await post(sid);
      } catch (err) {
        // The POST rejected — but shell/command POSTs are held open for the
        // WHOLE turn, and WKWebView kills any fetch at ~60 s. If SSE kept
        // streaming this session since the POST began, the turn is alive
        // server-side: keep the running lock (session.idle or a session error
        // will clear it) and don't report a failure that didn't happen.
        if ((sseLast.get(sid) ?? 0) > mark) {
          void logDebug(`turn POST dropped mid-turn, still running → ${sid}`);
          return sid;
        }
        // A genuinely failed POST produces no events — drop both flags here.
        // (On success the session.idle event clears the shell flag, never the
        // POST settling: SSE frames and the POST response race on separate
        // connections, and the bash-output event may land after the POST
        // resolves.)
        set((s) => {
          const runningSessions = { ...s.runningSessions };
          const shellTurns = { ...s.shellTurns };
          delete runningSessions[sid];
          delete shellTurns[sid];
          return { runningSessions, shellTurns };
        });
        throw err;
      }
      set((s) => {
        const runningSessions = { ...s.runningSessions };
        delete runningSessions[sid];
        return { runningSessions };
      });
    } else {
      await post(sid);
      set((s) => ({ runningSessions: { ...s.runningSessions, [sid]: true } }));
    }
    void logDebug("turn OK");
    return sid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    void logDebug(`turn FAILED: ${msg}`);
    // The failure belongs next to the message that caused it.
    const key = get().currentId ?? DRAFT_KEY;
    set((s) => {
      const cur = s.threads[key] ?? emptyThread();
      return {
        error: msg,
        threads: {
          ...s.threads,
          [key]: {
            ...cur,
            loaded: true,
            blocks: [...cur.blocks, { kind: "status-line", text: `Send failed: ${msg}`, tone: "error" }],
          },
        },
      };
    });
    return get().currentId;
  } finally {
    set({ sending: false });
  }
}

/** The live Magi client (Settings talks to the runtime's config API directly). */
export function getClient(): MagiClient | null {
  return client;
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  status: "offline",
  serverUrl: initialUrl(),
  sessions: [],
  currentId: null,
  threads: {},
  skills: [],
  commands: [],
  modelAliases: [],
  model: "main",
  tools: [],
  hiddenExamples: initialHidden(),
  error: null,
  questions: [],
  permissions: [],
  panes: {},
  workspace: null,
  workspacePinned: false,
  switching: false,
  sending: false,
  runningSessions: {},
  shellTurns: {},

  // All three write the CURRENT session's pane (DRAFT_KEY on a draft), keeping
  // the artifact inspector and the Files browser mutually exclusive.
  openArtifact: (artifact) =>
    set((s) => ({
      panes: { ...s.panes, [s.currentId ?? DRAFT_KEY]: { artifact, showFiles: false } },
    })),
  closeArtifact: () =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      const showFiles = s.panes[key]?.showFiles ?? false;
      return { panes: { ...s.panes, [key]: { artifact: null, showFiles } } };
    }),
  setShowFiles: (show) =>
    set((s) => {
      const key = s.currentId ?? DRAFT_KEY;
      const artifact = show ? null : (s.panes[key]?.artifact ?? null);
      return { panes: { ...s.panes, [key]: { artifact, showFiles: show } } };
    }),

  answerQuestion: async (requestId, answers) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q || !client) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await client.answerQuestion(requestId, answers);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  rejectQuestion: async (requestId) => {
    const q = get().questions.find((x) => x.requestId === requestId);
    if (!q || !client) return;
    set((s) => ({ questions: s.questions.filter((x) => x.requestId !== requestId) }));
    try {
      await client.rejectQuestion(requestId);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  replyPermission: async (requestId, reply) => {
    const p = get().permissions.find((x) => x.requestId === requestId);
    if (!p || !client) return;
    // Identical pending asks (same session, action and resources — e.g. three
    // parallel reads into one folder) are ONE question to the user: answer
    // them all with one click instead of re-asking for each tool call.
    const sig = (x: PermissionAskedEvent) =>
      `${x.sessionId}|${x.action}|${x.resources.join("|")}`;
    const batch = get().permissions.filter((x) => sig(x) === sig(p));
    set((s) => ({ permissions: s.permissions.filter((x) => sig(x) !== sig(p)) }));
    try {
      await Promise.all(batch.map((x) => client!.replyPermission(x.requestId, reply)));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  setServerUrl: (serverUrl) => {
    if (typeof window !== "undefined") window.localStorage.setItem(URL_KEY, serverUrl);
    set({ serverUrl });
  },

  setModel: (alias) => {
    client?.setModel(alias);
    set({ model: alias });
  },

  loadCatalog: async () => {
    if (!client) return;
    try {
      // Magi resolves skills (from its profile dir) and model aliases (from
      // config.yaml) server-side — one shot each, no lazy-instance polling.
      const [skills, providers] = await Promise.all([
        client.listSkills().catch(() => []),
        client.listProviders().catch(() => null),
      ]);
      set({
        skills,
        commands: skills.map((s) => ({ name: s.name, description: s.description, source: "skill" })),
        modelAliases: providers ? Object.keys(providers.aliases) : [],
      });
    } catch {
      /* ignore transient failures */
    }
  },

  detectTools: async () => {
    try {
      set({ tools: await probeTools() });
    } catch {
      /* ignore */
    }
  },

  connect: async () => {
    get().disconnect();
    // Scope skill discovery to the sidecar's workspace (null in browser dev).
    const directory = await workspacePath();
    set({ workspace: directory });
    const c = new MagiClient({
      baseUrl: get().serverUrl,
      directory: directory ?? undefined,
      model: get().model,
    });
    client = c;
    c.onStatus((status) => {
      void logDebug(`status → ${status}`);
      set({ status });
    });
    c.onEvent((event) => {
      // text.updated now fires per streamed token — logging each one would
      // flood debug.log with an IPC call per token.
      if (event.type !== "text.updated")
        void logDebug(`event ← ${event.type}${"sessionId" in event ? " " + event.sessionId : ""}`);
      if ("sessionId" in event && event.sessionId) sseLast.set(event.sessionId, ++sseSeq);
      if (event.type === "error") {
        // A session-scoped error belongs IN the conversation (a red status
        // line where the user is looking), and it ends that session's turn so
        // the composer unlocks. Errors without a session keep the banner.
        const sid = event.sessionId;
        if (sid) {
          set((s) => {
            const cur = s.threads[sid] ?? emptyThread();
            const runningSessions = { ...s.runningSessions };
            delete runningSessions[sid];
            return {
              runningSessions,
              threads: {
                ...s.threads,
                [sid]: {
                  ...cur,
                  loaded: true,
                  blocks: [...cur.blocks, { kind: "status-line", text: event.message, tone: "error" }],
                },
              },
            };
          });
        } else {
          set({ error: event.message });
        }
        return;
      }
      // Interactive requests live outside the thread blocks (transient UI).
      switch (event.type) {
        case "question.asked":
          set((s) => ({
            questions: [...s.questions.filter((q) => q.requestId !== event.requestId), event],
          }));
          return;
        case "question.resolved":
          set((s) => ({ questions: s.questions.filter((q) => q.requestId !== event.requestId) }));
          return;
        case "permission.asked":
          set((s) => ({
            permissions: [
              ...s.permissions.filter((p) => p.requestId !== event.requestId),
              event,
            ],
          }));
          return;
        case "permission.resolved":
          set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== event.requestId) }));
          return;
      }
      const sid = event.sessionId;
      if (!sid) return;
      set((s) => {
        const cur = s.threads[sid] ?? emptyThread();
        const folded = foldEvent(
          { blocks: cur.blocks, index: cur.index },
          event,
          { shellTurn: !!s.shellTurns[sid] },
        );
        // The turn is over — unlock the composer and drop the "Working…" row.
        // The shell flag clears HERE (not when the POST settles): within the
        // SSE stream the bash-output event always precedes session.idle.
        const runningSessions = { ...s.runningSessions };
        const shellTurns = { ...s.shellTurns };
        if (event.type === "session.idle") {
          delete runningSessions[sid];
          delete shellTurns[sid];
        }
        return {
          runningSessions,
          shellTurns,
          threads: { ...s.threads, [sid]: { ...cur, ...folded, loaded: true } },
        };
      });
      // A completed live write becomes a provenance version (once per call).
      if (event.type === "tool.updated" && !recordedProvenance.has(event.callId)) {
        const input = provenanceInputFromEvent(event);
        if (input) {
          recordedProvenance.add(event.callId);
          void recordProvenance(input, sid, get().model);
        }
      }
      if (event.type === "session.idle") void get().refreshSessions();
    });
    try {
      void logDebug(`connect → ${get().serverUrl}`);
      await c.connect();
      void logDebug("connect OK");
      set({ error: null });
      await get().refreshSessions();
      // Catalog (skills/agents/commands) fills in behind the page — a session
      // switch must not wait on it to show the conversation.
      void get().loadCatalog();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logDebug(`connect FAILED: ${msg}`);
      set({ error: msg, status: "error" });
    }
  },

  // First boot can be slow far beyond the process spawn: on a fresh install
  // macOS TCC ("access Documents") blocks the sidecar until the user answers,
  // so the window must cover minutes, not seconds — giving up early strands
  // the user on an error screen that a single manual Connect would fix.
  // Failed attempts are masked (status AND error): workspace switches
  // reconnect the event stream on purpose, and flashing "could not open the
  // event stream" at the user mid-switch reads as breakage. The last error is
  // surfaced only if the whole retry window is exhausted.
  connectRetry: async (tries = 120) => {
    set({ status: "connecting" });
    let lastError: string | null = null;
    for (let i = 0; i < tries; i++) {
      await get().connect();
      if (get().status === "ready") return;
      lastError = get().error ?? lastError;
      set({ status: "connecting", error: null });
      // Quick retries first — the server is usually up within a second (a
      // reconnect finds it already listening); back off to 1 s for the long
      // tail (first boot blocked on macOS TCC can take minutes).
      await sleep(i < 8 ? 250 : 1000);
    }
    set({ status: "error", error: lastError });
  },

  bootstrap: async () => {
    void get().detectTools();
    if (!isTauri) return;
    void logDebug("bootstrap: starting bundled runtime");
    try {
      const url = await startRuntime();
      void logDebug(`bootstrap: runtime at ${url}`);
      if (url) set({ serverUrl: url });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logDebug(`bootstrap FAILED: ${msg}`);
      set({ error: msg });
      return;
    }
    await get().connectRetry();
  },

  disconnect: () => {
    client?.close();
    client = null;
    set({ status: "offline" });
  },

  refreshSessions: async () => {
    if (!client) return;
    try {
      const sessions = await client.listSessions();
      set({ sessions });
    } catch {
      /* ignore transient list failures */
    }
  },

  // "New" opens a blank draft — no session is created until the first message (#3).
  // A fresh draft also drops any pinned folder: back to the dated-folder default.
  startDraft: () =>
    set((s) => {
      const threads = { ...s.threads };
      delete threads[DRAFT_KEY]; // leftovers from an aborted first message
      const panes = { ...s.panes };
      delete panes[DRAFT_KEY]; // a fresh draft starts with a closed pane
      return { currentId: null, workspacePinned: false, threads, panes };
    }),

  switchWorkspace: async (target) => {
    set({ switching: true });
    try {
      if ("dated" in target) await newDatedWorkspace(target.dated);
      else await setWorkspace(target.path);
      // Reset the local kernel so it respawns in the new folder, then reconnect
      // the event stream scoped to it (connect() re-reads the active folder —
      // the sidecar itself keeps running). An explicit switch pins the folder,
      // so the next new session lands exactly there.
      await kernelReset().catch(() => {});
      set((s) => {
        // Back to a draft in the new folder — the draft pane must not carry
        // files from the previous folder. Session panes keep their memory.
        const panes = { ...s.panes };
        delete panes[DRAFT_KEY];
        return { currentId: null, panes, workspacePinned: true };
      });
      await get().connectRetry();
      await Promise.all([get().refreshSessions(), get().loadCatalog()]);
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ switching: false });
    }
  },

  openSession: async (id) => {
    set({ currentId: id });
    if (!client) return;
    // Follow the session into its own workspace folder: record it as active and
    // reconnect the event stream scoped to it, so the agent, kernel and Files
    // all operate where the session's files live. Sessions with no recorded
    // folder, or that already match the active folder, skip this.
    const dir = get().sessions.find((s) => s.id === id)?.directory;
    if (dir && dir !== get().workspace) {
      set({ switching: true });
      try {
        await setWorkspace(dir).catch(() => {});
        await kernelReset().catch(() => {});
        await get().connectRetry();
      } finally {
        set({ switching: false });
      }
    }
    if (!client) return;
    // Recover any request the agent is blocked on (asked before connect/reload).
    void (async () => {
      try {
        const [qs, ps] = await Promise.all([
          client!.listQuestions(id),
          client!.listPermissions(id),
        ]);
        // Both lists are workspace-scoped (they include subagent sessions'
        // asks) — replace by requestId so live SSE copies don't duplicate.
        set((s) => {
          const qIds = new Set(qs.map((q) => q.requestId));
          const pIds = new Set(ps.map((p) => p.requestId));
          return {
            questions: [...s.questions.filter((q) => !qIds.has(q.requestId)), ...qs],
            permissions: [...s.permissions.filter((p) => !pIds.has(p.requestId)), ...ps],
          };
        });
      } catch {
        /* pending-request recovery is best-effort */
      }
    })();
    if (get().threads[id]?.loaded) return;
    try {
      const messages = await client.getMessages(id);
      set((s) => ({
        threads: {
          ...s.threads,
          [id]: { ...historyToThread(messages), loaded: true },
        },
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  // The send lifecycle (new → input → send → response) is shared by plain
  // prompts, "!" shell commands and "/" slash commands — see performTurn.
  // Magi turns are always async background jobs, so all three take the same
  // non-blocking path (OpenCode held the shell/command POST open for the whole
  // turn; Magi returns a jobId immediately and streams over the audit SSE).
  sendPrompt: (text) =>
    performTurn(set, get, text, (sid) => withRetry(() => client!.sendPrompt(sid, text)), false),

  // Magi has no direct shell route: ask the agent to run the command.
  runShell: (command) =>
    performTurn(
      set,
      get,
      `! ${command}`,
      (sid) =>
        withRetry(() =>
          client!.sendPrompt(
            sid,
            `Run this shell command and report its output:\n\n\`\`\`bash\n${command}\n\`\`\``,
          ),
        ),
      false,
    ),

  // Magi has no slash-command route: send it verbatim for the agent to resolve.
  runCommand: (name, args) =>
    performTurn(
      set,
      get,
      args ? `/${name} ${args}` : `/${name}`,
      (sid) => withRetry(() => client!.sendPrompt(sid, args ? `/${name} ${args}` : `/${name}`)),
      false,
    ),

  deleteSession: async (id) => {
    if (client) {
      try {
        await client.deleteSession(id);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    set((s) => {
      const threads = { ...s.threads };
      delete threads[id];
      const runningSessions = { ...s.runningSessions };
      delete runningSessions[id];
      const panes = { ...s.panes };
      delete panes[id];
      return {
        sessions: s.sessions.filter((x) => x.id !== id),
        threads,
        runningSessions,
        panes,
        currentId: s.currentId === id ? null : s.currentId,
      };
    });
  },

  hideExample: (id) => {
    const next = Array.from(new Set([...get().hiddenExamples, id]));
    if (typeof window !== "undefined") window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    set({ hiddenExamples: next });
  },

  // Install a skill by asking the agent (uses OpenCode's customize-opencode skill) (#1).
  installSkill: async (text) => {
    if (!client) {
      set({ error: "Connect the runtime first to install skills." });
      return null;
    }
    try {
      const id = await client.createSession();
      set((s) => ({ currentId: id, threads: { ...s.threads, [id]: { ...emptyThread(), loaded: true } } }));
      await get().refreshSessions();
      const prompt =
        "Install the following as a skill for this project. If it is a URL, fetch it; " +
        "if it is Markdown, save it as a skill file under skills/<name>/SKILL.md. " +
        "Then reply with the installed skill's name.\n\n---\n" +
        text;
      set((s) => {
        const cur = s.threads[id];
        return {
          threads: {
            ...s.threads,
            [id]: { ...cur, blocks: [...cur.blocks, { kind: "user", text: `Install skill:\n${text}` }] },
          },
        };
      });
      await client.sendPrompt(id, prompt);
      return id;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
}));

/** Dated folder name like `2026-07-04-1615` for a fresh per-session workspace. */
export function datedWorkspaceName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

export interface FoldState {
  blocks: ThreadBlock[];
  index: Record<string, number>;
}

/** Pure reducer: fold one normalized OpenCode event into a thread's blocks. */
/**
 * Tidy a tool-call title for the conversation: show workspace files by their
 * relative path (`demo/analyze.py`), not the full `/Users/.../OpenScience/...`
 * absolute path, so the thread reads like a researcher's log, not a shell trace.
 * The workspace path never contains spaces (by design), so a space-free run
 * ending in `OpenScience/` matches it whether or not it has a leading slash
 * (OpenCode's write-tool titles drop it).
 */
export function tidyToolTitle(title: string): string {
  return title.replace(/[^\s]*OpenScience\//g, "").trim() || title;
}

export function foldEvent(
  state: FoldState,
  event: RuntimeEvent,
  opts?: { shellTurn?: boolean },
): FoldState {
  const blocks = [...state.blocks];
  const index = { ...state.index };
  switch (event.type) {
    case "text.updated": {
      // A ```review fence in the agent's text becomes a structured reviewer card.
      const { clean, review } = splitReview(event.text);
      const key = `text:${event.partId}`;
      if (key in index) blocks[index[key]] = { kind: "agent", markdown: clean };
      else {
        blocks.push({ kind: "agent", markdown: clean });
        index[key] = blocks.length - 1;
      }
      if (review) {
        const rkey = `review:${event.partId}`;
        if (rkey in index) blocks[index[rkey]] = review;
        else {
          blocks.push(review);
          index[rkey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "tool.updated": {
      // The interactive `question`/`permission` tools render as their own
      // answerable card (InteractionPrompt), not as a blank thread row. `todo*`
      // tools only report an opaque "N todos" count with no useful content —
      // pure noise in the conversation, so drop them.
      if (/question|permission|^ask$|todo/i.test(event.tool)) return { blocks, index };
      const key = `tool:${event.callId}`;
      // Completed MCP tools (and the shell endpoint) report title as "" — and
      // file tools (write/edit/read) only get a title on completion. Fall back
      // to the bash command line, then the file path from the tool's input,
      // then the tool name; never render a blank row.
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      const filePath = typeof event.input?.filePath === "string" ? event.input.filePath : "";
      const block: ThreadBlock = {
        kind: "tool-call",
        title: tidyToolTitle(event.title?.trim() || command || filePath || event.tool || "tool"),
        status: event.status,
        // A user-typed "!" command ran for its output — show it inline.
        // Agent bash steps stay quiet single-line log entries.
        ...(opts?.shellTurn && event.tool === "bash" && event.output?.trim()
          ? { outputSummary: event.output.replace(/\s+$/, "") }
          : {}),
      };
      if (key in index) blocks[index[key]] = block;
      else {
        blocks.push(block);
        index[key] = blocks.length - 1;
      }
      // Surface a file the agent wrote as a traceable artifact (deduped by path).
      const artifact = deriveArtifact(event);
      if (artifact) {
        const akey = `artifact:${artifact.path}`;
        if (akey in index) blocks[index[akey]] = artifact;
        else {
          blocks.push(artifact);
          index[akey] = blocks.length - 1;
        }
      }
      return { blocks, index };
    }
    case "session.idle":
      blocks.push({ kind: "status-line", text: "done", tone: "done" });
      return { blocks, index };
    default:
      return state;
  }
}

function mapToolStatus(status?: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "success";
    case "error":
      return "failed";
    default:
      return "pending";
  }
}

/** Convert loaded Magi history into thread blocks. Magi persists a flat
 *  role/content transcript; `getMessages` folds `tool` rows into the preceding
 *  assistant message as tool parts carrying only a name, status and output
 *  (no input/title/args, and no synthetic shell markers or slash-command
 *  template expansions — those were OpenCode-isms). */
export function historyToThread(messages: HistoryMessage[]): FoldState {
  const blocks: ThreadBlock[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      if (text) blocks.push({ kind: "user", text });
    } else {
      for (const p of m.parts) {
        if (p.type === "text" && p.text?.trim()) {
          const { clean, review } = splitReview(p.text);
          if (clean) blocks.push({ kind: "agent", markdown: clean });
          if (review) blocks.push(review);
        } else if (p.type === "tool") {
          // Interactive tools are surfaced by InteractionPrompt, not the thread;
          // `todo*` tools are opaque "N todos" noise — skip both.
          if (/question|permission|^ask$|todo/i.test(p.tool ?? "")) continue;
          blocks.push({
            kind: "tool-call",
            title: tidyToolTitle(p.tool || "tool"),
            status: mapToolStatus(p.state?.status),
          });
        }
      }
    }
  }
  return { blocks, index: {} };
}
