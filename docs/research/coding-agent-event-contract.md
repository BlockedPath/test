# Coding-agent event contract for the GUI

Research for [Research: Define the coding-agent event contract for the GUI](https://github.com/BlockedPath/test/issues/4).

Research date: 2026-07-12.

## Decision

Expose one **framework-independent GUI session model** above the ACP wire protocol. The ACP bridge (engine adapter) owns JSON-RPC framing, correlation IDs, and raw `session/update` / capability messages. The GUI consumes only **normalized events** and a single **session state machine**. Do not invent a second agent protocol; normalize ACP into GUI vocabulary so conversation, activity panel, editor/diffs, approvals, and emergency stop share one model.

V1 maps directly from official ACP prompt-turn lifecycle, tool-call statuses, permission options, terminal embedding, and stop reasons. YOLO mode is a **GUI policy** that auto-selects permission outcomes; it does not remove activity, diffs, cancel, or emergency stop from the model.

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│ GUI surfaces                                                │
│  conversation · activity panel · editor/diffs · stop/YOLO   │
└────────────────────────────▲────────────────────────────────┘
                             │ normalized GuiEvent stream
                             │ + SessionSnapshot projections
┌────────────────────────────┴────────────────────────────────┐
│ Session store (reducer)                                     │
│  applies GuiEvent → SessionSnapshot                         │
└────────────────────────────▲────────────────────────────────┘
                             │ normalize / escalate
┌────────────────────────────┴────────────────────────────────┐
│ ACP bridge (agent engine adapter)                           │
│  spawn · JSON-RPC · session/prompt · session/update ·       │
│  session/request_permission · session/cancel · process kill │
└────────────────────────────▲────────────────────────────────┘
                             │ stdin/stdout JSON-RPC
┌────────────────────────────┴────────────────────────────────┐
│ Grok Build CLI (`grok agent stdio`)                         │
└─────────────────────────────────────────────────────────────┘
```

This follows the engine-boundary decision: GUI must not depend on TUI presentation output; ACP is the primary seam; the adapter exposes GUI-level concepts only.

Sources: [Grok CLI engine boundary](./grok-cli-engine-boundary.md), [Headless & Scripting — ACP](https://docs.x.ai/build/cli/headless-scripting#acp), [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn).

## Session state machine

One active **Session** per project window (domain rule). Within a session, the turn lifecycle is:

| State | Meaning | Who may leave it |
| --- | --- | --- |
| `idle` | Ready for user input; no open prompt turn | User sends prompt → `running` |
| `running` | `session/prompt` in flight; streaming updates | Agent stop reason / cancel / fault |
| `awaiting_approval` | Open `session/request_permission` (or GUI-equivalent approval) | User decision, YOLO auto-decision, cancel |
| `cancelling` | Client sent `session/cancel` (or emergency stop started); waiting for terminal stop | Prompt result `cancelled`, or process death |
| `completed_turn` | Transient: last turn finished with a non-cancel stop reason | Immediately returns to `idle` (keep last stop reason in snapshot) |
| `faulted` | Transport/process/protocol error; session may be unusable | Recover / dispose / new session |
| `disposed` | Engine process cleaned up; no further events | Terminal |

**Invariants**

1. At most one open user prompt turn per session at a time (ACP prompt-turn model).
2. `awaiting_approval` is a substate of a live turn: the session remains associated with the open `session/prompt` request.
3. YOLO never skips logging: auto-approved actions still emit tool/activity events.
4. Conversation messages, tool rows, and diffs are append-only projections; cancel does not rewrite history except marking open items terminal.
5. Emergency stop is strictly stronger than cancel: cancel is cooperative ACP; emergency stop escalates to process kill and `faulted`/`disposed` if the agent does not finish.

Sources: [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), domain glossary in `CONTEXT.md`.

## Normalized event envelope

All GUI events share:

```ts
type GuiEvent = {
  /** Monotonic per-session event id assigned by the bridge/store */
  eventId: string;
  /** Wall-clock ISO-8601 when the bridge observed the event */
  observedAt: string;
  sessionId: string;
  /** Optional correlation to the open prompt turn */
  turnId?: string;
  type: GuiEventType;
  payload: unknown; // discriminated by type
};
```

`turnId` is bridge-assigned when `session/prompt` is sent and cleared when that request completes. ACP does not define a turn id on the wire; the bridge synthesizes one for GUI correlation.

## Event catalog

Framework-independent. Names are GUI vocabulary; ACP mappings are explicit.

### Lifecycle and transport

| `type` | Payload (essential fields) | ACP / bridge source |
| --- | --- | --- |
| `engine.started` | `{ engineVersion?, protocolVersion, cwd }` | Process spawn + `initialize` result |
| `engine.authenticated` | `{ methodId }` | `authenticate` |
| `session.created` | `{ sessionId, cwd, modes?, configOptions? }` | `session/new` |
| `session.resumed` | `{ sessionId, cwd, replayed?: boolean }` | `session/load` or `session/resume` |
| `engine.stderr` | `{ text, level?: "info"\|"warn"\|"error" }` | Child stderr (not TUI) |
| `engine.exited` | `{ exitCode, signal? }` | Process exit |
| `engine.error` | `{ code, message, recoverable, cause? }` | JSON-RPC error, parse failure, timeout |
| `session.disposed` | `{ reason: "user"\|"fault"\|"shutdown" }` | Adapter cleanup |

### Conversation

| `type` | Payload | ACP source |
| --- | --- | --- |
| `user.message` | `{ messageId, content: ContentBlock[] }` | Client-originated when sending `session/prompt` (and any `user_message_chunk` on replay) |
| `assistant.message_chunk` | `{ messageId?, chunk: ContentBlock }` | `session/update` → `agent_message_chunk` |
| `assistant.thought_chunk` | `{ messageId?, chunk: ContentBlock }` | `session/update` → `agent_thought_chunk` |
| `plan.updated` | `{ entries: PlanEntry[] }` | `session/update` → `plan` |
| `usage.updated` | `{ used, size, cost? }` | `session/update` → `usage_update` |
| `turn.started` | `{ turnId, prompt: ContentBlock[] }` | Bridge, when sending `session/prompt` |
| `turn.completed` | `{ turnId, stopReason }` | `session/prompt` response |

**ContentBlock** (v1 minimum): text is mandatory; image/audio/resource follow ACP when capabilities allow.

**StopReason** (must match ACP): `end_turn` | `max_tokens` | `max_turn_requests` | `refusal` | `cancelled`.

Sources: [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn), [ACP Content](https://agentclientprotocol.com/protocol/v1/content), [xAI ACP example](https://docs.x.ai/build/cli/headless-scripting#acp) (`agent_message_chunk`).

### Tool activity

| `type` | Payload | ACP source |
| --- | --- | --- |
| `tool.started` | `{ toolCallId, title, kind, status, rawInput?, locations? }` | `session/update` → `tool_call` |
| `tool.updated` | `{ toolCallId, status?, title?, content?, rawInput?, rawOutput?, locations? }` | `session/update` → `tool_call_update` |
| `tool.finished` | `{ toolCallId, status: "completed"\|"failed"\|"cancelled", content?, rawOutput? }` | Derived when status becomes terminal |

**ToolKind** (ACP): `read` | `edit` | `delete` | `move` | `search` | `execute` | `think` | `fetch` | `other`.

**ToolCallStatus** (ACP + GUI cancel): `pending` | `in_progress` | `completed` | `failed` | `cancelled`.

`cancelled` is required on the GUI even though some agents only report `pending`/`in_progress`/`completed`/`failed`: after `session/cancel`, the Client **SHOULD** preemptively mark non-finished tool calls cancelled.

**Tool content variants** (for activity + editor):

| Content type | Fields | GUI surface |
| --- | --- | --- |
| `content` | nested ContentBlock (text, etc.) | Activity log |
| `diff` | `{ path, oldText?, newText }` | Diff viewer / editor; `oldText` null ⇒ new file |
| `terminal` | `{ terminalId }` | Live command output panel |

**Locations**: `{ path, line? }` drive follow-along in the editor.

Sources: [ACP Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls), [ACP Prompt Turn — cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation).

### File reads and proposed edits

File reads and edits are **not separate ACP session updates**; they appear as tool calls (and optional client fs methods). Normalize them for the GUI:

| `type` | When emitted | Payload |
| --- | --- | --- |
| `file.read` | Tool kind `read` (or fs read activity the bridge chooses to surface) | `{ toolCallId, path, line?, status }` |
| `file.edit_proposed` | Tool kind `edit`/`delete`/`move` with pending/in-progress and/or diff content **before** apply | `{ toolCallId, path, diff?, status }` |
| `file.edit_applied` | Edit tool reaches `completed` (or client `fs/write_text_file` success if bridge owns write) | `{ toolCallId, path, diff? }` |
| `file.edit_failed` | Edit tool `failed` or write error | `{ toolCallId, path, message }` |

These are **projections** of tool events for the editor surface. Activity panel can render either the generic `tool.*` stream or the specialized `file.*` events; the store should derive both from one underlying tool-call record to avoid double-counting.

If the agent uses client `fs/read_text_file` / `fs/write_text_file`, the bridge may emit the same `file.*` events keyed by request id rather than `toolCallId`.

Sources: [ACP Tool Calls — diffs](https://agentclientprotocol.com/protocol/v1/tool-calls#diffs), [ACP Schema — fs methods](https://agentclientprotocol.com/protocol/v1/schema).

### Command execution

| `type` | Payload | ACP source |
| --- | --- | --- |
| `command.started` | `{ terminalId, toolCallId?, command, args?, cwd? }` | `terminal/create` (+ tool content embedding) |
| `command.output` | `{ terminalId, chunk?, snapshot?, truncated? }` | Client-local streaming and/or `terminal/output` |
| `command.exited` | `{ terminalId, exitCode?, signal? }` | `terminal/wait_for_exit` / output exitStatus |
| `command.killed` | `{ terminalId, reason: "user"\|"agent"\|"timeout"\|"emergency_stop" }` | `terminal/kill` or emergency stop |
| `command.released` | `{ terminalId }` | `terminal/release` |

Activity panel binds `terminalId` to the parent tool row when tool content includes `{ type: "terminal", terminalId }`. Output remains displayable after release.

Sources: [ACP Terminals](https://agentclientprotocol.com/protocol/v1/terminals).

### Approvals

| `type` | Payload | ACP source |
| --- | --- | --- |
| `approval.requested` | `{ requestId, toolCallId, title?, kind?, options: ApprovalOption[], preview? }` | `session/request_permission` |
| `approval.resolved` | `{ requestId, outcome: ApprovalOutcome, source: "user"\|"yolo"\|"policy"\|"cancel" }` | Client response to permission request |

```ts
type ApprovalOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

type ApprovalOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };
```

**Policy mapping (product, not ACP)**

| Safety class | Default when not YOLO | YOLO |
| --- | --- | --- |
| Safe reads | Auto-allow (or never requested) | Auto-allow |
| Edits | Present diff + require allow | Auto-allow once/always per policy; still show diff in activity |
| Commands | Require allow; project-trust may pre-allow | Auto-allow with visible warning state |
| Destructive / outside project | Always explicit allow; never silent YOLO auto | Still require explicit allow (recommended hard rule) |

When the turn is cancelled, any pending approval **MUST** resolve with `{ outcome: "cancelled" }` (ACP requirement).

Sources: [ACP Tool Calls — permission](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission), map safety notes on issue #1, `CONTEXT.md` (Approval, YOLO mode).

### Cancellation and emergency stop

| `type` | Payload | Notes |
| --- | --- | --- |
| `turn.cancel_requested` | `{ turnId, reason: "user"\|"timeout" }` | Bridge sends ACP `session/cancel` |
| `turn.cancelled` | `{ turnId, stopReason: "cancelled" }` | Prompt response with cancelled stop reason |
| `session.emergency_stop` | `{ phase: "cancel"\|"kill"\|"cleanup", detail? }` | Escalation sequence |

**Cooperative cancel (default Stop)**

1. Emit `turn.cancel_requested`.
2. Enter `cancelling`.
3. Send ACP `session/cancel`.
4. Preemptively mark non-terminal tool calls `cancelled` in the store.
5. Resolve pending approvals with `cancelled`.
6. **Continue accepting** `session/update` until `session/prompt` returns.
7. Emit `turn.cancelled` / `turn.completed` with `stopReason: "cancelled"`.
8. Return to `idle` (session still usable).

**Emergency stop**

1. Same as cooperative cancel.
2. If prompt does not complete within a short budget, kill child process (and documented descendant cleanup from engine-boundary research).
3. Emit `engine.exited` / `engine.error` as appropriate; mark in-flight tools cancelled; session → `faulted` or `disposed`.
4. User must start a new engine/session for further work if the process died.

Cancellation is **not** an error in the conversation model. Agents must return stop reason `cancelled` rather than a JSON-RPC error for abort; the bridge must map abort exceptions accordingly if the child misbehaves.

Sources: [ACP Cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation), [engine boundary — process control](./grok-cli-engine-boundary.md).

### Completion and errors

| Outcome | Events | Session state |
| --- | --- | --- |
| Normal end | `turn.completed` `{ stopReason: "end_turn" }` | `idle` |
| Model limits | `turn.completed` `{ stopReason: "max_tokens" \| "max_turn_requests" }` | `idle` (user may continue) |
| Refusal | `turn.completed` `{ stopReason: "refusal" }` | `idle` |
| Cancel | `turn.cancelled` | `idle` |
| Tool failure | `tool.finished` `{ status: "failed" }` then possibly more assistant text | stay `running` until turn stop |
| Protocol/process fault | `engine.error` (+ optional `engine.exited`) | `faulted` |

User-visible error severity:

- **Turn-level**: stop reasons other than `end_turn` / `cancelled` — show in conversation footer.
- **Tool-level**: failed tool row in activity; does not alone fault the session.
- **Session-level**: transport errors, unexpected process exit mid-turn — block input until recover.

## Session snapshot (projection)

Surfaces should read a single snapshot, not re-parse raw ACP:

```ts
type SessionSnapshot = {
  sessionId: string;
  projectPath: string;
  state: "idle" | "running" | "awaiting_approval" | "cancelling" | "faulted" | "disposed";
  yoloEnabled: boolean;
  turn?: {
    turnId: string;
    startedAt: string;
    stopReason?: StopReason;
  };
  messages: Message[];
  tools: Record<string, ToolCallRecord>;
  terminals: Record<string, TerminalRecord>;
  pendingApprovals: ApprovalRecord[];
  plan?: PlanEntry[];
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  lastError?: { code: string; message: string; recoverable: boolean };
};
```

**Surface bindings**

| Surface | Reads | Writes / commands |
| --- | --- | --- |
| Conversation | `messages`, streaming assistant chunks, turn stop reason | `sendPrompt`, attachments as ContentBlocks |
| Activity panel | `tools`, `terminals`, `pendingApprovals`, plan, errors | Focus tool, open diff, resolve approval |
| Editor / diffs | Tool locations, `diff` content, follow-along path/line | Accept/reject only via approval API (not freeform) |
| Emergency stop | `state` for enabled/disabled and busy indicator | `cancelTurn`, `emergencyStop` |
| YOLO control | `yoloEnabled` | Toggle; does not clear history |

## ACP → GUI mapping (minimum)

| ACP | GUI |
| --- | --- |
| `initialize` / `authenticate` / `session/new` | `engine.*`, `session.created` |
| `session/prompt` request | `user.message`, `turn.started` |
| `agent_message_chunk` | `assistant.message_chunk` |
| `agent_thought_chunk` | `assistant.thought_chunk` |
| `plan` | `plan.updated` |
| `usage_update` | `usage.updated` |
| `tool_call` | `tool.started` (+ optional `file.*` / `command.*`) |
| `tool_call_update` | `tool.updated` / `tool.finished` |
| `session/request_permission` | `approval.requested` |
| permission response | `approval.resolved` |
| `terminal/*` | `command.*` |
| `session/cancel` | `turn.cancel_requested` → later `turn.cancelled` |
| `session/prompt` result | `turn.completed` |
| JSON-RPC / process errors | `engine.error` / `engine.exited` |

Unknown `sessionUpdate` values: preserve as `engine.unknown_update` with raw payload for diagnostics; do not crash the reducer.

## Representative sequences

### A. Streamed answer only

```
user → sendPrompt("Explain src/main.ts")
  turn.started
  assistant.message_chunk (×N)
  turn.completed { stopReason: "end_turn" }
state: idle
```

### B. Read file, then answer

```
turn.started
assistant.message_chunk
tool.started { kind: "read", status: "pending" }
tool.updated { status: "in_progress" }
file.read { path, status: "in_progress" }
tool.finished { status: "completed" }
assistant.message_chunk
turn.completed { stopReason: "end_turn" }
```

### C. Proposed edit with approval (non-YOLO)

```
turn.started
tool.started { kind: "edit", status: "pending", locations: [{ path }] }
approval.requested {
  options: [allow-once, reject-once, ...],
  preview: { type: "diff", path, oldText, newText }
}
state: awaiting_approval
user selects allow-once
approval.resolved { outcome: selected, source: "user" }
tool.updated { status: "in_progress", content: [diff] }
file.edit_proposed → file.edit_applied
tool.finished { status: "completed" }
assistant.message_chunk
turn.completed { stopReason: "end_turn" }
```

Editor shows the diff from tool content; activity shows the same tool row; conversation shows assistant summary only.

### D. Command execution

```
turn.started
tool.started { kind: "execute", title: "Run tests" }
approval.requested  // unless policy/YOLO auto-allows
approval.resolved
command.started { terminalId, command, args }
tool.updated { status: "in_progress", content: [{ type: "terminal", terminalId }] }
command.output (stream)
command.exited { exitCode: 0 }
tool.finished { status: "completed" }
command.released
turn.completed { stopReason: "end_turn" }
```

### E. YOLO mode edit

```
// yoloEnabled === true
turn.started
tool.started { kind: "edit" }
approval.requested
approval.resolved { source: "yolo", outcome: selected allow-once|allow-always }
// activity still lists tool + diff; no modal wait
tool.finished { status: "completed" }
turn.completed
```

### F. Cancel during tool + pending approval

```
turn.started
tool.started { status: "pending" }
approval.requested
user hits Stop
turn.cancel_requested
state: cancelling
approval.resolved { outcome: cancelled, source: "cancel" }
tool.finished { status: "cancelled" }   // client-preemptive mark
// optional trailing session/update still applied
turn.cancelled { stopReason: "cancelled" }
state: idle
```

### G. Emergency stop when cancel stalls

```
turn.cancel_requested
state: cancelling
// budget exceeded
session.emergency_stop { phase: "kill" }
engine.exited { signal: "SIGKILL" }  // or Windows equivalent
engine.error { recoverable: false, message: "Emergency stop terminated engine" }
// open tools → cancelled
state: faulted | disposed
```

### H. Transport fault mid-stream

```
turn.started
assistant.message_chunk
engine.error { code: "parse_error" | "io_error", recoverable: false }
engine.exited
state: faulted
// no turn.completed required if prompt never returns; store synthesizes
// turn.completed { stopReason: "cancelled" } OR lastError-only policy —
// prefer synthesizing cancelled for UI consistency, with lastError set.
```

## Failure and cancellation matrix

| Scenario | Prompt stopReason | Tool statuses | Approvals | Session state | User recovery |
| --- | --- | --- | --- | --- | --- |
| User Stop, agent cooperates | `cancelled` | non-terminal → `cancelled` | `cancelled` | `idle` | Send new prompt |
| User Stop, agent hangs | synthesized cancel / none | `cancelled` | `cancelled` | `faulted` after kill | Restart engine |
| Emergency stop | cancel then kill | `cancelled` | `cancelled` | `disposed`/`faulted` | New session |
| Tool fails, turn continues | eventually `end_turn` or other | that tool `failed` | n/a | `idle` after turn | Inspect activity |
| Refusal | `refusal` | as reported | as reported | `idle` | Rephrase / change scope |
| Auth missing | n/a (before turn) | n/a | n/a | `faulted` or pre-session | Run CLI login / set key |
| Max tokens | `max_tokens` | terminal as reported | n/a | `idle` | Continue conversation |

## Adapter commands (GUI → bridge)

Align with engine-boundary surface; events above are the inverse stream.

| Command | Effect |
| --- | --- |
| `start(projectPath, capabilities, authPolicy)` | Spawn + initialize |
| `authenticate()` | ACP authenticate |
| `createSession()` / `resumeSession()` | session/new or load/resume |
| `sendPrompt(content)` | session/prompt; opens turn |
| `respondToApproval(requestId, decision)` | permission result |
| `setYolo(enabled)` | GUI-only policy flag |
| `cancel()` | session/cancel + preemptive local marks |
| `emergencyStop()` | cancel + kill + cleanup |
| `dispose()` | session close if any + process teardown |

## Out of scope for this ticket

- Desktop framework choice and packaging.
- Pixel-level UI layout.
- Exact YOLO product rules (grilled in the safety ticket); this contract only reserves policy hooks.
- Implementing the reducer or bridge.
- Non-ACP streaming-json headless mode as a primary UI path (diagnostics only).

## Consequences for later tickets

- **Prototype (#5)** can drive UI with recorded `GuiEvent` fixtures without a live binary.
- **Windows stack (#3)** must support child process I/O suitable for this event stream.
- **Safety grilling (#6)** specifies which `approval.requested` cases YOLO may auto-resolve.
- **Acceptance suite (#7)** should include sequences A–G as observable contracts.
- **ACP spike (#8)** validates that real Grok CLI messages populate this model; extend mapping if Grok emits additional update kinds.

## Sources

- [Grok CLI engine boundary research](./grok-cli-engine-boundary.md) (issue #2 decision)
- [Headless & Scripting — ACP](https://docs.x.ai/build/cli/headless-scripting) (xAI; `grok agent stdio`, `session/update` / `agent_message_chunk`)
- [ACP Overview](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) (lifecycle, stop reasons, cancellation)
- [ACP Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls) (status, kinds, permission, diff, terminal content)
- [ACP Terminals](https://agentclientprotocol.com/protocol/v1/terminals)
- [ACP Content](https://agentclientprotocol.com/protocol/v1/content)
- [ACP Schema](https://agentclientprotocol.com/protocol/v1/schema)
- Domain glossary: `CONTEXT.md`
