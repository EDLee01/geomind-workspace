import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FolderOpen, Loader2, NotebookPen, PlugZap } from "lucide-react";
import { DRAFT_KEY, useRuntimeStore } from "@/lib/runtime";
import { fileInspectorFromBlock } from "@/lib/artifacts";
import { useScrollMemory } from "@/lib/scrollMemory";
import { BlockList, type BlockHandlers } from "@/components/thread/BlockList";
import { Composer } from "@/components/thread/Composer";
import { baseName, WorkspaceChip } from "@/components/thread/WorkspaceChip";
import { WorkflowStarters } from "@/components/thread/WorkflowStarters";
import { InteractionPrompt } from "@/components/thread/InteractionPrompt";
import { InspectorShell } from "@/components/inspector/InspectorShell";
import { SessionFilesPane } from "./FilesPage";
import { cn } from "@/lib/cn";

/** Live agent session backed by the Magi runtime. `/live` (no id) is a blank draft;
 *  the session is created lazily on the first message, then the URL updates to /live/:id. */
export function LiveSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const {
    status,
    switching,
    sending,
    runningSessions,
    serverUrl,
    sessions,
    currentId,
    threads,
    error,
    questions,
    permissions,
    workspace,
    panes,
    commands,
    connect,
    openSession,
    startDraft,
    sendPrompt,
    runShell,
    runCommand,
    openArtifact,
    closeArtifact,
    setShowFiles,
    answerQuestion,
    rejectQuestion,
    replyPermission,
  } = useRuntimeStore();

  // A deliberate workspace move restarts the sidecar — expected and brief, so
  // the UI stays "connected" (no badge flip, no Connect button, no help card).
  // Only a real failure (retry window exhausted, switching cleared) surfaces.
  const connected = status === "ready" || switching;
  const connecting = status === "connecting" && !switching;
  const displayStatus = switching ? "ready" : status;

  useEffect(() => {
    if (sessionId) void openSession(sessionId);
    else startDraft(); // blank draft — no session created yet (#3)
  }, [sessionId, openSession, startDraft]);

  // All three composer paths reflect a freshly-created session in the URL.
  const afterTurn = (id: string | null) => {
    if (id && !sessionId) navigate(`/live/${id}`);
  };
  const onSend = async (text: string) => afterTurn(await sendPrompt(text));
  const onRunShell = async (command: string) => afterTurn(await runShell(command));
  const onRunCommand = async (name: string, args: string) => afterTurn(await runCommand(name, args));

  // Interactions from the thread/inspector fold back into the conversation as follow-up prompts.
  const handlers: BlockHandlers = {
    onArtifactOpen: openArtifact,
    onFigureComment: (a, title) =>
      void sendPrompt(`On the figure ${title}, at (${a.x.toFixed(0)}%, ${a.y.toFixed(0)}%): ${a.note}`),
  };
  const onEvaluate = (expr: string) => void sendPrompt(`Evaluate in the notebook kernel:\n\`\`\`python\n${expr}\n\`\`\``);

  // A draft shows its local thread (the first message echoes there instantly,
  // before any session exists) — it is grafted onto the session id on create.
  const thread = currentId ? threads[currentId] : threads[DRAFT_KEY];
  // Opening a session fetches its history (cross-folder opens also restart the
  // sidecar) — show skeleton shapes meanwhile, never a blank page.
  const historyLoading = connected && !!sessionId && !thread?.loaded;
  const title = sessions.find((s) => s.id === currentId)?.title;
  const isEmpty = !thread || thread.blocks.length === 0;
  // The turn lifecycle: `sending` covers click → POST accepted (incl. the
  // dated-folder setup on a first message); `running` covers the agent
  // working until session.idle. Together they lock the composer and show the
  // working indicator, so a sent message is never silently "nowhere".
  const running = !!(currentId && runningSessions[currentId]);
  const working = sending || running;

  // The oldest unanswered request blocks the run — surface it. Magi runs
  // subagents in-process and does not expose their sessions on the stream, so
  // every ask carries the conversation's own session id.
  const belongsHere = (sid: string) => !!currentId && sid === currentId;
  const activeQuestion = questions.find((q) => belongsHere(q.sessionId));
  const activePermission = permissions.find((p) => belongsHere(p.sessionId));
  const activeRequest = activeQuestion ?? activePermission;
  const requestOrigin = undefined;

  // Notebooks the agent touched in THIS session — the conversation ↔ notebook map.
  const sessionNotebooks = (thread?.blocks ?? []).filter(
    (b): b is Extract<typeof b, { kind: "artifact" }> =>
      b.kind === "artifact" && b.filename.endsWith(".ipynb"),
  );
  const uniqueNotebooks = [...new Map(sessionNotebooks.map((b) => [b.path, b])).values()];

  // The right pane belongs to the session: each one remembers its own open
  // artifact or Files browser (mutually exclusive, enforced by the store) and
  // gets it back when the user returns.
  const pane = panes[currentId ?? DRAFT_KEY];
  const activeArtifact = pane?.artifact ?? null;
  const showFiles = !activeArtifact && !!pane?.showFiles;

  // Conversation scroll position, per session — restored once history is in.
  const chatRef = useRef<HTMLDivElement>(null);
  const onChatScroll = useScrollMemory(chatRef, `chat:${currentId ?? DRAFT_KEY}`, !historyLoading);

  // When the agent starts working a notebook (Jupyter MCP), open it beside the
  // chat automatically — once per notebook, so a manual close stays closed.
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    const agentNb = uniqueNotebooks.find(
      (b) => b.tool.toLowerCase().includes("jupyter") && !autoOpened.current.has(b.path),
    );
    if (agentNb) {
      autoOpened.current.add(agentNb.path);
      openArtifact(agentNb);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueNotebooks.length]);

  return (
    <div className="flex h-full min-w-0">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-6 py-2.5">
          <h1 className="truncate text-[13px] font-medium text-text">
            {/* A URL with a session id is never a draft — while its title or
                history is still loading (cross-folder opens take a moment),
                stay blank rather than flashing the "New session" empty state. */}
            {sessionId ? (title ?? "") : "New session"}
          </h1>
          <WorkspaceChip />
          <div className="flex-1" />
          <ConnBadge status={displayStatus} />
          {uniqueNotebooks.map((nb) => (
            <button
              key={nb.path}
              onClick={() => openArtifact(nb)}
              className={cn(
                "flex items-center gap-1 rounded-input px-2 py-1 font-mono text-xs ring-1 ring-border hover:bg-surface-2",
                activeArtifact?.path === nb.path ? "bg-surface-2 text-text" : "bg-surface text-muted",
              )}
              title={`Open ${nb.path} — the agent works on this notebook in this session`}
            >
              <NotebookPen size={11} />
              <span className="max-w-[180px] truncate">{nb.filename}</span>
            </button>
          ))}
          <button
            onClick={() => setShowFiles(!showFiles)}
            className={cn(
              "flex items-center gap-1 rounded-input px-2 py-1 text-xs ring-1 ring-border hover:bg-surface-2",
              showFiles ? "bg-surface-2 text-text" : "bg-surface text-muted",
            )}
            title={`Browse this session's folder beside the chat${workspace ? ` — ${workspace}` : ""}`}
            aria-pressed={showFiles}
          >
            <FolderOpen size={12} />
            {/* An open session's folder is a fact — the toggle names it, replacing
                a separate folder chip (one element for "this session's files"). */}
            <span className="max-w-[160px] truncate">
              {sessionId && workspace ? baseName(workspace) : "Files"}
            </span>
          </button>
          {!connected && (
            <button
              onClick={connect}
              disabled={connecting}
              className="flex items-center gap-1.5 rounded-input bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
            >
              {connecting ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
              Connect
            </button>
          )}
        </div>

        <div ref={chatRef} onScroll={onChatScroll} className="flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-8 py-6">
            {/* Deliberate workspace switches don't render anything at all (they're
                masked as connected); a genuine boot/reconnect shows only the
                header badge's pulsing dot — anything appearing and disappearing
                in the content flow makes the page jump. The help card is for
                real error/offline states. */}
            {!connected && !connecting && (
              <div className="rounded-card border border-border bg-surface p-5 shadow-card">
                <div className="text-sm font-medium text-text">Magi runtime</div>
                <p className="mt-1 text-sm text-muted">
                  The desktop app runs a bundled Magi daemon automatically. In the browser, start one with{" "}
                  <span className="font-mono">magi serve</span> and connect.
                </p>
                <div className="mt-3 rounded-input bg-surface-2 px-3 py-2 font-mono text-xs text-text">
                  {serverUrl}
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-input border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
                {error}
              </div>
            )}
            {connected && isEmpty && !sessionId && (
              <WorkflowStarters onPick={(p) => void onSend(p)} />
            )}
            {historyLoading && <ThreadSkeleton />}
            {!historyLoading && thread && <BlockList blocks={thread.blocks} handlers={handlers} />}
            {working && (
              // Typing-indicator at the bottom of the conversation: the message
              // just echoed above it, so the user always sees the send is alive.
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 size={14} className="animate-spin" />
                {activeRequest
                  ? "Paused — the agent needs your answer below"
                  : sending && !currentId
                    ? "Starting the session in its folder…"
                    : "Working…"}
              </div>
            )}
          </div>
        </div>

        <div className="px-8 pb-5 pt-2">
          <div className="mx-auto max-w-[760px] space-y-3">
            {activeRequest && (
              <InteractionPrompt
                question={activeQuestion}
                permission={activeQuestion ? undefined : activePermission}
                origin={requestOrigin}
                onAnswer={(id, answers) => void answerQuestion(id, answers)}
                onReject={(id) => void rejectQuestion(id)}
                onPermission={(id, reply) => void replyPermission(id, reply)}
              />
            )}
            <Composer
              onSend={onSend}
              onRunShell={(c) => void onRunShell(c)}
              onRunCommand={(n, a) => void onRunCommand(n, a)}
              commands={commands}
              disabled={!connected || working}
              placeholder={
                working ? "Waiting for the reply…" : connected ? "Ask anything" : "Connect to chat"
              }
            />
          </div>
        </div>
      </div>

      {activeArtifact && (
        <div className="hidden w-[46%] max-w-[720px] shrink-0 lg:block">
          <InspectorShell
            inspector={fileInspectorFromBlock(activeArtifact)}
            onClose={closeArtifact}
            onEvaluate={onEvaluate}
          />
        </div>
      )}
      {!activeArtifact && showFiles && (
        <div className="hidden w-[46%] max-w-[720px] shrink-0 border-l border-border bg-surface lg:block">
          <SessionFilesPane onClose={() => setShowFiles(false)} />
        </div>
      )}
    </div>
  );
}

/** Loading placeholder mirroring the thread's real shapes: a user card, agent
 *  text lines, a quiet tool row — so the page never sits blank while history
 *  loads and nothing jumps when the content arrives. */
function ThreadSkeleton() {
  return (
    <div className="animate-pulse space-y-4" aria-hidden>
      <div className="h-11 rounded-card bg-surface-2" />
      <div className="space-y-2.5 px-1 pt-1">
        <div className="h-3.5 w-11/12 rounded bg-surface-2" />
        <div className="h-3.5 w-4/5 rounded bg-surface-2" />
        <div className="h-3.5 w-2/3 rounded bg-surface-2" />
      </div>
      <div className="ml-2 h-4 w-2/5 rounded bg-surface-2 opacity-60" />
      <div className="h-11 rounded-card bg-surface-2" />
      <div className="space-y-2.5 px-1 pt-1">
        <div className="h-3.5 w-5/6 rounded bg-surface-2" />
        <div className="h-3.5 w-3/5 rounded bg-surface-2" />
      </div>
    </div>
  );
}

function ConnBadge({ status }: { status: string }) {
  const tone = status === "ready" ? "text-ok" : status === "error" ? "text-error" : "text-muted";
  return (
    <span className={cn("flex items-center gap-1.5 text-xs", tone)} title={`Magi · ${status}`}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "ready" ? "bg-ok" : status === "error" ? "bg-error" : "bg-muted",
          status === "connecting" && "animate-pulse",
        )}
      />
      {/* Ready is the norm — a green dot says it all (hover for detail). Text
          appears only for states that need attention. */}
      {status !== "ready" && <>Magi · {status}</>}
    </span>
  );
}
