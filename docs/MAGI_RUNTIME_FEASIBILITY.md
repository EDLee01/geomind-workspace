# Magi as the Agent Runtime — Feasibility Report (geomind)

Read-only survey, 2026-07-06. Sources: this repo (`open-science`) and
`/home/claude-user/magi` (github.com/EDLee01/magi, v0.1.13 per
`capability-manifest.json:4`). Every claim cites `file:line`. Line numbers refer
to the working trees as of today.

**Verdict (three-way call): "adaptable, but with cuts and one recommended
server-side addition."** The core conversation loop (create session, send
prompt, streamed text, tool events, approval/question round-trips, history,
session list, skills) maps onto Magi's Control API. What does not map: the
whole provider/auth/model-catalog management surface, MCP config-over-HTTP,
agent/command catalogs, session delete, `runShell`, and "always allow"
permission replies. Details and evidence below.

---

## 1. What the open-science frontend actually depends on

The UI talks to the runtime only through `packages/sdk` (`OpenCodeClient`,
per the guardrail in `AGENTS.md`). The full dependency surface:

### 1.1 HTTP routes called by `OpenCodeClient`

| Method | Route | Purpose | Evidence |
|---|---|---|---|
| GET (SSE) | `/event?directory=` | one event stream for everything | `packages/sdk/src/OpenCodeClient.ts:112,143` |
| POST | `/session?directory=` | create session | `OpenCodeClient.ts:183` |
| GET | `/experimental/session` (fallback `/session`) | list sessions across folders | `OpenCodeClient.ts:201,205` |
| DELETE | `/session/:id` | delete session | `OpenCodeClient.ts:226` |
| GET | `/session/:id/message` | message history | `OpenCodeClient.ts:236` |
| POST | `/session/:id/prompt_async` | send prompt (returns immediately, output via SSE) | `OpenCodeClient.ts:484` |
| POST | `/session/:id/shell` | run a "!" shell command, no model turn | `OpenCodeClient.ts:456` |
| POST | `/session/:id/command` | run a slash command (skill/MCP prompt) | `OpenCodeClient.ts:471` |
| GET | `/api/skill?directory=` | list skills | `OpenCodeClient.ts:252` |
| GET | `/agent` | list agents (modes) | `OpenCodeClient.ts:421` |
| GET | `/command?directory=` | slash-command palette | `OpenCodeClient.ts:429` |
| GET | `/config` | default model | `OpenCodeClient.ts:262` |
| PATCH | `/global/config` | set model / add provider / add MCP server | `OpenCodeClient.ts:270,311,348` |
| GET | `/config/providers` | connected providers + models | `OpenCodeClient.ts:280` |
| GET | `/global/config` | custom provider ids, MCP configs | `OpenCodeClient.ts:321,331` |
| GET | `/mcp` | MCP servers live status | `OpenCodeClient.ts:330` |
| GET | `/provider`, `/provider/auth` | provider catalog + auth methods | `OpenCodeClient.ts:358,372` |
| PUT/DELETE | `/auth/:providerID` | store/remove API key | `OpenCodeClient.ts:379,389` |
| POST | `/provider/:id/oauth/authorize`, `/oauth/callback` | provider OAuth | `OpenCodeClient.ts:403,413` |
| GET | `/question?directory=`, `/permission?directory=` | pending-ask recovery | `OpenCodeClient.ts:508,545` |
| POST | `/question/:id/reply`, `/question/:id/reject` | answer/reject question | `OpenCodeClient.ts:528,537` |
| POST | `/permission/:id/reply` | reply `once \| always \| reject` | `OpenCodeClient.ts:571` (type at `types.ts:102`) |

### 1.2 SSE event types consumed (normalized in `normalize()`)

`OpenCodeClient.ts:617-778` consumes: `message.updated` (role learning),
`message.part.updated` (text parts + tool parts incl. status/title/input/output
and the `task` tool's child-session id, `:626-664`), `message.part.delta`
(per-token text streaming, `:666-681`), `session.idle` (turn end, `:682-689`),
`question.[v2.]asked/replied/rejected` (`:691-729`), `permission.[v2.]asked/replied`
(`:730-760`), `session.error` (`:761-774`). These are normalized to the 8 app
events in `packages/sdk/src/types.ts:91-99`.

### 1.3 How the app uses them

- `apps/desktop/src/lib/runtime.ts` drives everything: `connect()` opens the
  stream and folds events into thread blocks (`runtime.ts:452-552`,
  `foldEvent` at `:838-911`); `performTurn` implements the send lifecycle with
  sync-vs-async POST semantics (`:191-318`); pending questions/permissions are
  recovered on session open (`:689-708`); history is rebuilt via
  `getMessages` → `historyToThread` (`:711-717`, `:927-1014`); permission
  replies are batched by (session, action, resources) signature (`:388-403`).
- Tool events also feed provenance recording (`runtime.ts:544-550`) and
  artifact derivation (`foldEvent` → `deriveArtifact`, `:894-902`) — both need
  the tool's `input` (file path, content) and `status`.
- Subagent asks are re-rooted to the visible conversation via
  `childSessionId` → `sessionParents` (`runtime.ts:512-519`, `rootSessionOf`
  at `:164-168`).
- The Rust side spawns the runtime as a Tauri sidecar on a private port with
  app-private XDG dirs (`apps/desktop/src-tauri/src/runtime.rs:243-306`),
  switches workspaces without restart by reconnecting the stream with
  `?directory=` (`runtime.rs:352-374`), and writes provider/model config
  directly into the config file + restarts the sidecar
  (`runtime.rs:546-575`, merge logic in `opencode_config.rs:7-58`).

---

## 2. Magi's actual external interface

Magi is a Node CLI with a daemon ("Control API") — one HTTP server started by
`magi serve` / daemonized via `startDaemon` (spawns `node <cli> serve` with
`MAGI_DAEMON=1`, `src/control/daemon.ts:172-210`). Defaults:
`127.0.0.1:8765`, overridable with `MAGI_CONTROL_BIND` / `MAGI_CONTROL_PORT`
(`src/paths.ts:10-11,55-60`); state root `~/.magi-next` overridable with
`MAGI_CONFIG_DIR` (`src/paths.ts:34-36`) — this is the direct analog of the
app-private XDG sandbox `runtime.rs` builds today.

### 2.1 Routes (all in `src/control/server.ts:369-941`)

| Method | Route | What it does | Evidence |
|---|---|---|---|
| GET | `/health` | liveness + root + bind info (unauthenticated) | `server.ts:387-393` |
| GET | `/panel`, `/panel-client.js`, `/openapi.json` | built-in mobile web panel + OpenAPI doc | `server.ts:395-405` |
| POST | `/pairing` | mint a device token; loopback (or already-authed) only | `server.ts:407-433`, `auth.ts:11-27` |
| GET | `/sessions` | list 50 newest session summaries | `server.ts:439-441` |
| POST | `/sessions` | create session (id/title/cwd/metadata) | `server.ts:443-452` |
| GET | `/sessions/:id` | session **including full `messages[]`** | `server.ts:467-477`; messages included via `session-store.ts:198-217` (`SessionRecord.messages`, `:9-17`) |
| GET | `/sessions/:id/events` | audit events for a session | `server.ts:454-465` |
| POST | `/sessions/:id/messages` | run a prompt in the session — **synchronous**, response held until the turn ends | `server.ts:478-487` → `runControlJob:1031-1076` → `runHeadlessPrompt` (`src/headless.ts:33-59`) |
| POST | `/jobs` | run a prompt; with `background: true` returns `202 {sessionId, jobId, status:"running"}` immediately (async, streamed) | `server.ts:875-898`, `startBackgroundControlJob:1092-1142` |
| GET | `/jobs`, `/jobs/:id` | job list / job status+metadata | `server.ts:489-491,620-626` |
| POST | `/jobs/:id/cancel` | abort a running job | `server.ts:628-665` |
| GET | `/jobs/:id/events` | audit events for one job | `server.ts:493-504` |
| GET | `/jobs/:id/interactions` | pending/resolved approvals+questions for a job | `server.ts:900-910` |
| POST | `/jobs/:id/approvals/:toolUseId` | resolve an approval: `approved` true/false | `server.ts:506-545`, decision parsing `:1322-1343` |
| POST | `/jobs/:id/questions/:toolUseId` | answer an AskUserQuestion (`selectedLabels`) | `server.ts:547-578`, normalization `:1352-1372` |
| POST | `/jobs/:id/(approvals\|questions)/:toolUseId/cancel` | reject/dismiss an ask | `server.ts:580-618` |
| GET | `/events` | **SSE stream of audit events** — optional `?sessionId=&jobId=&after=&limit=`, replays history then live-pushes, 15 s heartbeats | `server.ts:928-939`, `streamEvents:955-1007` |
| GET | `/events.json` | same data, one-shot JSON | `server.ts:866-873` |
| GET | `/skills` | installed skills (`{name, root, summary}`) | `server.ts:690-692`, shape `src/skills/loader.ts:7-12` |
| GET | `/providers` | configured providers (name/type/defaultModel/configured) + model aliases | `server.ts:671-681` |
| GET | `/plugins` | plugins + marketplaces | `server.ts:683-688` |
| GET | `/agents`, POST `/agents`, POST `/agents/:id/(start\|wait\|cancel\|complete)` | explorer/worker **task queue** (not agent definitions) | `server.ts:667-669,694-860` |
| GET | `/audit` | last 100 audit events | `server.ts:862-864` |

Auth: every route except `/health`, `/panel*`, `/openapi.json`, `/pairing`
requires `X-Magi-Device-Id` + `Authorization: Bearer <token>`
(`server.ts:435-437`, `isAuthorized:1144-1148`, `validateDeviceToken`
`auth.ts:29-45`). When daemonized, Magi self-mints a 1-year token and writes it
to `state/daemon/control-credentials.json` (`src/cli.ts:2145-2153`,
`daemon.ts:119-127`) — a Tauri shell can read that file, or POST `/pairing`
from loopback.

### 2.2 The event stream: SSE, but audit-shaped

Magi DOES have an SSE channel (`GET /events`, `server.ts:964-1007`). Frames
are `event: audit` + a `MagiEventView` JSON (`id, sessionId, jobId, eventName,
action, category, status, target, createdAt, message, metadata` —
`src/events.ts:37-49`). Everything the frontend needs rides in
`action` + `metadata` of audit records written by the query engine:

| Signal | Magi audit action | Payload carried | Evidence |
|---|---|---|---|
| streamed text | `agent.text.delta` | **`metadata.text` = the raw delta chunk** (plus `length`, `preview`) | `src/agent/query-engine.ts:1289-1301` |
| assistant message final | `agent.assistant.message` | `metadata.text` (full text), `toolUseCount` | `query-engine.ts:1303-1318` |
| tool start | `agent.tool.use` | `target`=tool name, `metadata.id` (toolUseId), `metadata.input` (args) | `query-engine.ts:1254-1264` |
| tool end | `agent.tool.completed` / `agent.tool.failed` | `metadata.toolCallId`; **failure carries `reason`, success does NOT carry the output** | `query-engine.ts:1332-1341` |
| approval ask | `agent.approval.pending` | full `toolUse` (name+input), `reason`, `diff`, `cwd`, `timeoutAt`, `toolUseId` | `query-engine.ts:349-364` |
| approval resolved | `agent.approval.resolved` / `.timeout` / `.cancelled` | `toolUseId`, `approved` | `query-engine.ts:372-405` |
| question ask | `agent.user_question.pending` | full `question` object (`questions[]` with `question, header, options[{label,description}], multiSelect` — `src/tools/user-question.ts:3-19`), `toolUseId` | `query-engine.ts:464-478` |
| question resolved | `agent.user_question.resolved` / `.timeout` / `.cancelled` | `toolUseId`, `answer` | `query-engine.ts:486-499` |
| turn end ("session.idle") | `agent.query.completed` (+ job status `completed`) | `turns`, `attempts` | `query-engine.ts:255-261,237-246` |
| turn error | `agent.query.failed` / `.cancelled` | `error`, `reason` | `query-engine.ts:279-288` |

Streaming nuance: token-level `text_delta` events only flow when the job runs
with `stream: true`. The **background** job path defaults stream on
(`stream: body.stream !== false`, `server.ts:1135`); the **synchronous** paths
(`POST /sessions/:id/messages`, `POST /jobs` without `background`) never pass
`stream` (`server.ts:1046-1063`), and the provider stream is gated on
`input.stream === true` (`src/agent/query.ts:256`) — non-streamed turns still
emit one `text_delta` per turn with the whole response text
(`query.ts:397-399`). So for a live UI, **always use
`POST /jobs {background:true, sessionId}` + `GET /events?jobId=` (or
`?sessionId=`)**.

Magi's own `peer-client.ts` is a working reference client for exactly this
create-session → post-message → poll-job → read-`agent.text.delta` protocol
(`src/control/peer-client.ts:108-245`, text extraction `:225-231`;
also documented in `ARCHITECTURE.md:144-153`).

### 2.3 Config surface

All provider/model/MCP configuration is a YAML file, `~/.magi-next/config.yaml`
(`paths.ts:43`), parsed in `src/config.ts`: `providers:` (type/apiKeyEnv/
baseUrl/defaultModel — `config.ts:33,225-296`), `models.aliases` +
`models.fallbacks` (`config.ts:34-37,298-310`), `mcp.servers` (stdio/http/sse/
websocket transports, command/args/url/headers/env/approval/oauth —
`McpServerConfig`, `config.ts:48-57,335-377`), and `control:` (bind/port/
allowAnyCwd/defaultCwd/denyDestructive — `config.ts:23-32,214-222`).
**There is no HTTP route that writes config** — no PATCH/PUT/DELETE routes
exist at all (verified: zero matches for PATCH/PUT/DELETE in
`server.ts`). The `/mcp` slash command (`src/commands/mcp.ts:5-234`) manages
MCP connections but lives in the TUI command registry, not the Control API.

### 2.4 Workspace scoping

Control jobs run in a cwd that must resolve inside a configured workspace root
(`resolveControlCwd`, `server.ts:1257-1320`): default is the daemon's own cwd
or `control.defaultCwd`; escapes are rejected unless `control.allowAnyCwd` /
`MAGI_CONTROL_ALLOW_ANY_CWD=1` (`server.ts:1242-1244`). Sessions carry their
own cwd from creation (`server.ts:443-452`), and `POST /sessions/:id/messages`
runs in the session's recorded cwd (`server.ts:484`). This matches
open-science's per-session dated-folder model — but geomind must set
`control.defaultCwd` to the workspace base (e.g. `~/Documents/GeoMind`) so
every dated subfolder validates, or enable `allowAnyCwd`.

---

## 3. Capability matrix

Legend: ✅ direct equivalent · 🟡 exists but shape/semantics differ (adapter
work) · ❌ missing from Magi's Control API.

| # | Frontend capability (OpenCode form) | Magi Control API | Transport | Status |
|---|---|---|---|---|
| 1 | Create session (`POST /session`, `OpenCodeClient.ts:180-191`) | `POST /sessions` with `{title, cwd, metadata}` (`server.ts:443-452`) | HTTP | ✅ — richer, even (cwd per session) |
| 2 | Send prompt async (`prompt_async`, `OpenCodeClient.ts:482-492`) | `POST /jobs {prompt, sessionId, background:true}` → 202 `{jobId}` (`server.ts:886-892,1092-1142`) | HTTP | ✅ — but the client must track the returned `jobId` (OpenCode has no job concept) |
| 3 | Streamed token deltas (`message.part.delta`, `OpenCodeClient.ts:666-681`) | `agent.text.delta` audit events with `metadata.text` over `GET /events` SSE (`query-engine.ts:1289-1301`, `server.ts:955-1007`) | SSE | 🟡 — works, but deltas are raw chunks (client accumulates, as `textStreams` already does at `OpenCodeClient.ts:69`), and only background jobs stream token-level (`server.ts:1135`, `query.ts:256`) |
| 4 | Tool start/end events with input+title+output (`OpenCodeClient.ts:638-663`) | `agent.tool.use` (id+input) / `agent.tool.completed`/`failed` (`query-engine.ts:1254-1264,1332-1341`) | SSE | 🟡 — start has full input (enough for provenance/artifacts via `filePath`+`content`); **success events do not carry tool output** (output lands only as a `role:"tool"` message in history, `query-engine.ts:1320-1331`); no `title` field (derive from tool name+input, which `foldEvent` already does as fallback, `runtime.ts:876-881`) |
| 5 | Permission ask + reply `once/always/reject` (`OpenCodeClient.ts:730-760,569-575`) | `agent.approval.pending` (full toolUse+reason+diff) via SSE; reply `POST /jobs/:id/approvals/:toolUseId {approved: bool}`; reject via the same route or `/cancel` (`query-engine.ts:349-364`, `server.ts:506-545,580-618`) | SSE + HTTP | 🟡 — **no "always allow" persistence**; decision is a one-shot boolean (`server.ts:1322-1343`). "Always" must be cut or emulated client-side (auto-approve matching future asks) |
| 6 | Question ask + reply/reject (`OpenCodeClient.ts:691-729,526-541`) | `agent.user_question.pending` with full `questions[]` payload; reply `POST /jobs/:id/questions/:toolUseId {answers:[{question,selectedLabels}]}`; reject via `/cancel` (`query-engine.ts:464-478`, `server.ts:547-618,1352-1372`) | SSE + HTTP | ✅ — near-isomorphic (`multiSelect` ↔ `multiple`; Magi lacks OpenCode's `custom` free-text flag in the item schema, `user-question.ts:9-15`) |
| 7 | Pending-ask recovery on open (`GET /question`, `/permission`, `OpenCodeClient.ts:507-566`) | `GET /jobs/:id/interactions` (`server.ts:900-910`), or replay `GET /events?sessionId=` history (`server.ts:978-989`) | HTTP | ✅ |
| 8 | Session history (`GET /session/:id/message`, `OpenCodeClient.ts:234-245`) | `GET /sessions/:id` returns `messages[]` (role user/assistant/tool, flat `content` string + metadata with `toolCallId`/`toolName`, `server.ts:467-477`, `session-store.ts:19-26,198-217`, `query-engine.ts:1320-1331`) | HTTP | 🟡 — flat strings, not typed parts; `historyToThread` (`runtime.ts:927-1014`) must be rewritten around role-based messages; per-job events (`GET /sessions/:id/events`) can reconstruct tool detail |
| 9 | Session list (`GET /experimental/session`, `OpenCodeClient.ts:200-222`) | `GET /sessions` → `SessionSummary {id,title,cwd,createdAt,updatedAt,messageCount}` (`server.ts:439-441`, `session-store.ts:117-124,320-333`) | HTTP | ✅ — `cwd` even substitutes for OpenCode's `directory`; fixed limit 50 |
| 10 | Delete session (`OpenCodeClient.ts:225-231`) | **No route.** Store supports it (`deleteSession`, `session-store.ts:257`) but the server never exposes DELETE (no DELETE handler anywhere in `server.ts`) | — | ❌ — needs a Magi route (trivial: store method exists) or the UI hides sessions locally |
| 11 | Turn-end signal (`session.idle`, `OpenCodeClient.ts:682-689`) | `agent.query.completed`/`failed`/`cancelled` audit events + job status (`query-engine.ts:255-288`) | SSE | ✅ |
| 12 | Session error surface (`session.error`, `OpenCodeClient.ts:761-774`) | `agent.query.failed` with `metadata.error` (`query-engine.ts:279-288`) | SSE | ✅ |
| 13 | Model list (`GET /config/providers`, `OpenCodeClient.ts:279-292`) | `GET /providers`: name/type/defaultModel/configured + alias map (`server.ts:671-681`) | HTTP | 🟡 — no per-provider model catalog; Magi's currency is **aliases** (`main/fast/deep/auto`, `ARCHITECTURE.md:47-56`); the model picker becomes an alias picker, per-turn override via job `body.model` (`server.ts:1054,1180`) |
| 14 | Set default model (`PATCH /global/config`, `OpenCodeClient.ts:269-276`) | **No config-write route** (no PATCH routes in `server.ts`) | — | ❌ over HTTP — geomind's Rust side writes `config.yaml` + restarts the daemon, same pattern as `configure_opencode` (`runtime.rs:546-575`) |
| 15 | Provider auth: catalog, API keys, OAuth (`OpenCodeClient.ts:298-417`) | Nothing. Providers = `config.yaml` + env API keys (`config.ts:225-296`); `configured` flag readable at `/providers` (`server.ts:677`) | — | ❌ — cut the in-app provider marketplace/OAuth; keep a simple "endpoint + key + model" form writing config.yaml (matches geomind's SiliconFlow-default plan) |
| 16 | Agent list (`GET /agent`, `OpenCodeClient.ts:420-424`) | `GET /agents` is a **task queue**, not agent definitions (`server.ts:667-669`); subagent types are hardcoded prompt wrappers (`src/headless.ts:652-686,719-730`) | — | ❌ as a catalog — the UI's only real use is picking the shell agent (`runtime.ts:730`), which disappears with `runShell` (see #18) |
| 17 | Slash-command palette (`GET /command`, `OpenCodeClient.ts:428-449`) | **No route.** Slash commands live in the in-process TUI registry (e.g. `src/commands/mcp.ts:5`); skills ARE listed (`GET /skills`, `server.ts:690-692`) | — | 🟡 — build the "/" palette from `GET /skills` only (skills are prompt-injected workflows, `ARCHITECTURE.md:68-73`); running one = send its body/`/name` as a normal prompt; config-commands and MCP-prompt entries are cut |
| 18 | Direct shell run, no model turn (`POST /session/:id/shell`, `OpenCodeClient.ts:454-464`) | **No route.** | — | ❌ — either cut the "!" feature, run it in Tauri/Rust locally (geomind owns the machine anyway), or add a Magi route |
| 19 | MCP config downlink + status (`GET /mcp`, PATCH config, `OpenCodeClient.ts:328-354`) | Config: `config.yaml mcp.servers` only (`config.ts:39-41,335-377`). Status/health/tools: `/mcp` **slash command** (TUI), not HTTP (`src/commands/mcp.ts:136-230`) | — | ❌ over HTTP — same remedy as #14: Rust writes config.yaml + daemon restart; live status either cut or added to Magi |
| 20 | Skills list (`GET /api/skill`, `OpenCodeClient.ts:248-258`) | `GET /skills` → `{name, root, summary}` (`server.ts:690-692`, `loader.ts:7-12`) | HTTP | ✅ — note: **one global skills dir** `~/.magi-next/skills` (`paths.ts:49`), no per-directory scoping, which actually simplifies `runtime.rs`'s `deploy_bundled_skills` (`runtime.rs:153-170`) |
| 21 | Subagent → parent session linking (`childSessionId`, `types.ts:32-34`, `runtime.ts:512-519`) | Subagent sessions carry `metadata.parentAgentId` + job kind `sub-agent` (`headless.ts:507-522`), but **no live SSE event names the child session from the parent's stream** | — | 🟡/❌ — re-rooting child asks needs a session-list join on metadata, or (better) all asks already carry the parent `jobId` when the subagent runs in-process; needs a prototype to confirm; worst case subagent asks are auto-resolved headlessly (`query-engine.ts:305-327`) |
| 22 | Cancel a running turn | `POST /jobs/:id/cancel` (`server.ts:628-665`) | HTTP | ✅ — **new capability**; OpenCodeClient has no abort at all (no such method in `OpenCodeClient.ts`) |
| 23 | Sidecar lifecycle (spawn, private state, stable port — `runtime.rs:243-306`) | `magi serve` with `MAGI_CONFIG_DIR` (private root, `paths.ts:34-36`), `MAGI_CONTROL_PORT`/`BIND` (`paths.ts:55-60`); `/health` for readiness (`server.ts:387-393`); daemon self-pairing token in `state/daemon/control-credentials.json` (`cli.ts:2145-2153`) | process | ✅ — near drop-in for `spawn_sidecar`, plus geomind must bundle Node ≥ 20 (`ARCHITECTURE.md:173`) or pkg the CLI; native dep `better-sqlite3` must match the bundled Node ABI |

### Transport-layer summary

- **Magi has a real SSE channel** — `GET /events` streams `event: audit`
  frames with heartbeats and replay-from-`after` cursor
  (`server.ts:955-1007`). No WebSocket, no long-poll needed. The
  `EventSource`-vs-fetch split in `OpenCodeClient.connect()`
  (`OpenCodeClient.ts:105-166`) must always take the **fetch-stream branch**,
  because auth headers (`X-Magi-Device-Id` + `Bearer`) can't ride on a browser
  `EventSource` — the fallback path already exists and is the model for
  MagiClient.
- Biggest semantic difference: OpenCode streams **domain events** (message
  parts with stable part ids); Magi streams **audit records** (append-only log
  with numeric ids). The adapter must map `action`+`metadata` → the 8
  normalized app events, accumulate `text_delta` chunks per (jobId, turn), and
  synthesize part ids. All the raw material is present (§2.2 table).
- Per-workspace scoping: OpenCode's `?directory=` becomes Magi's
  per-session `cwd` + `control.defaultCwd`/`allowAnyCwd` (§2.4). No
  reconnect-on-folder-switch needed at all — one global `/events` stream
  filtered by `sessionId` suffices.

---

## 4. Conclusion

**"可适配但需砍/改造若干功能"，另有两处强烈建议给 Magi 加接口。**

Adaptable as-is (core loop): create/list sessions, background prompt jobs,
token streaming, tool start events, approval/question round-trips with
recovery, turn-end/error signals, history, skills, cancellation (matrix rows
1-3, 5-9, 11-13, 20, 22-23). This covers the entire conversation page.

Must cut or relocate:
- Provider marketplace / OAuth / API-key routes (row 15) → replaced by a
  config.yaml writer in Rust (the `opencode_config.rs` pattern survives almost
  verbatim, just emitting YAML).
- "Always allow" permission replies (row 5) → one-shot approve/deny, or
  client-side auto-approve rules.
- `runShell` "!" commands via the runtime (row 18) → run locally in Rust or cut.
- Slash-command palette beyond skills; agent-mode list (rows 16-17).
- MCP live status page (row 19) → config-file management only, or cut.

Recommended Magi additions (small, high value):
1. `DELETE /sessions/:id` — the store method already exists
   (`session-store.ts:257`); only the route is missing (row 10).
2. Include tool output in `agent.tool.completed` metadata
   (`query-engine.ts:1332-1341` currently drops it) — without this, live tool
   rows can't show output until history refetch (row 4).
3. (Optional) a parent-link audit event when a subagent session is spawned
   (`headless.ts:507-522`) so child asks re-root cleanly (row 21).

Items 1-2 are the only places where "adaptable" would otherwise degrade the
current UX rather than just relocate a Settings feature.

---

## 5. Migration work list (files + change type, no code)

### packages/sdk
- `src/MagiClient.ts` (new, replaces `OpenCodeClient.ts`): fetch-based SSE
  reader for `GET /events` (reuse `readStream`/`handleSseChunk` logic,
  `OpenCodeClient.ts:579-615`); audit→app-event normalizer replacing
  `normalize()` (`:617-778`) per the §2.2 mapping; delta accumulator keyed by
  jobId instead of partId (`:69,666-681`); `createSession`/`listSessions`/
  `getMessages` re-pointed to `/sessions*`; `sendPrompt` →
  `POST /jobs {background:true}` capturing `jobId`; question/permission
  reply methods re-pointed to `/jobs/:id/{approvals,questions}/:toolUseId`;
  new `cancelJob`; auth via `X-Magi-Device-Id` + Bearer headers
  (`server.ts:1144-1148`). Delete the provider/OAuth/MCP/command methods
  (`OpenCodeClient.ts:260-449`).
- `src/types.ts`: keep the 8 normalized app events (they survive unchanged);
  replace the raw wire types (`:236-256`) with `MagiEventView`
  (`events.ts:37-49`); `PermissionReply` loses `"always"` (`:102`);
  `HistoryMessage` becomes role+content+metadata (`session-store.ts:19-26`).
- `src/mockServer.ts`: rewrite fixtures to Magi routes/frames.

### apps/desktop/src (frontend)
- `lib/runtime.ts`: track `jobId` per turn (needed for replies + cancel —
  today requests are keyed only by `requestId`, `:368-403`); `performTurn`'s
  sync-POST branch (`:191-318`) simplifies — background jobs make every send
  async; `historyToThread` (`:927-1014`) rewritten for role-based messages;
  drop `runShell`/`runCommand` or reroute to Tauri (`:729-748`); catalog
  loading (`:410-431`) reduced to skills + providers/aliases.
- `lib/provenance.ts` / `lib/artifacts.ts` call sites: tool input still
  arrives (from `agent.tool.use`), but output-dependent artifact derivation
  needs the history refetch fallback until Magi addition #2 lands.
- Settings pages: provider marketplace/OAuth UI removed; replaced with
  endpoint+key+alias form → Tauri command.

### apps/desktop/src-tauri (Rust)
- `runtime.rs`: `spawn_sidecar` (`:243-288`) spawns `node magi-cli serve` (or a
  packaged binary) with `MAGI_CONFIG_DIR=<app-private root>`,
  `MAGI_CONTROL_PORT=<free port>`; readiness = poll `/health`; read/mint the
  device token (POST `/pairing` from loopback, `server.ts:407-433`) and hand
  it to the frontend; workspace switching (`set_workspace`, `:352-374`) keeps
  the file bookkeeping but drops the reconnect requirement; skills deploy
  (`:153-170`) targets `~<private root>/skills` (`paths.ts:49`).
- `opencode_config.rs` → `magi_config.rs`: same merge-and-restart pattern
  (`:7-58`) but emitting `config.yaml` — `providers.<name>` (type/baseUrl/
  apiKeyEnv or key), `models.aliases.main`, `mcp.servers.*`,
  `control.defaultCwd=<workspace base>` (`config.ts:23-57`). Note Magi reads
  API keys from **env vars** (`apiKeyEnv`, `config.ts:240-247`) — the
  spawn env, not the YAML, carries the secret, which is *better* for the
  keychain guardrail in `AGENTS.md`.
- Bundling: ship Node ≥ 20 + `better-sqlite3` native module per target
  (`ARCHITECTURE.md:173`) — this is the one packaging cost OpenCode's single
  binary didn't have.

### Effort shape (hour-scale, per project convention)
Adapter (`MagiClient` + normalizer + tests against a live `magi serve`): the
bulk. Frontend `runtime.ts`/history rework: medium. Rust spawn/config/pairing:
small. Settings simplification: net-negative code. The two recommended Magi
routes: trivial on the Magi side and each removes a UX regression.
