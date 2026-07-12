/**
 * Framework-independent GUI session model.
 * See docs/research/coding-agent-event-contract.md
 */

export type SessionLifecycleState =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "cancelling"
  | "completed_turn"
  | "faulted"
  | "disposed";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data?: string; mimeType?: string; uri?: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string };

export type ApprovalOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

export type ApprovalOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export type PlanEntry = {
  content: string;
  status?: "pending" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high";
};

export type MessageRole = "user" | "assistant" | "system" | "thought";

export type Message = {
  messageId: string;
  role: MessageRole;
  content: ContentBlock[];
  /** True while assistant text is still streaming */
  streaming?: boolean;
};

export type ToolCallRecord = {
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
  content?: unknown[];
};

export type TerminalRecord = {
  terminalId: string;
  toolCallId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  output: string;
  exitCode?: number | null;
  signal?: string | null;
  status: "running" | "exited" | "killed" | "released";
};

export type ApprovalRecord = {
  requestId: string;
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  options: ApprovalOption[];
  preview?: unknown;
  resolved?: {
    outcome: ApprovalOutcome;
    source: "user" | "yolo" | "policy" | "cancel";
  };
};

export type SessionSnapshot = {
  sessionId: string;
  projectPath: string;
  state: SessionLifecycleState;
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
  usage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string };
  };
  lastError?: { code: string; message: string; recoverable: boolean };
  engineVersion?: string;
  protocolVersion?: number;
};

/** Monotonic envelope shared by all GUI events */
export type GuiEventBase = {
  eventId: string;
  observedAt: string;
  sessionId: string;
  turnId?: string;
};

export type GuiEvent =
  | (GuiEventBase & {
      type: "engine.started";
      payload: {
        engineVersion?: string;
        protocolVersion: number;
        cwd: string;
      };
    })
  | (GuiEventBase & {
      type: "engine.authenticated";
      payload: { methodId: string };
    })
  | (GuiEventBase & {
      type: "session.created";
      payload: {
        sessionId: string;
        cwd: string;
        modes?: unknown;
        configOptions?: unknown;
      };
    })
  | (GuiEventBase & {
      type: "session.resumed";
      payload: { sessionId: string; cwd: string; replayed?: boolean };
    })
  | (GuiEventBase & {
      type: "engine.stderr";
      payload: { text: string; level?: "info" | "warn" | "error" };
    })
  | (GuiEventBase & {
      type: "engine.exited";
      payload: { exitCode: number | null; signal?: string | null };
    })
  | (GuiEventBase & {
      type: "engine.error";
      payload: {
        code: string;
        message: string;
        recoverable: boolean;
        cause?: string;
      };
    })
  | (GuiEventBase & {
      type: "session.disposed";
      payload: { reason: "user" | "fault" | "shutdown" };
    })
  | (GuiEventBase & {
      type: "user.message";
      payload: { messageId: string; content: ContentBlock[] };
    })
  | (GuiEventBase & {
      type: "assistant.message_chunk";
      payload: { messageId?: string; chunk: ContentBlock };
    })
  | (GuiEventBase & {
      type: "assistant.thought_chunk";
      payload: { messageId?: string; chunk: ContentBlock };
    })
  | (GuiEventBase & {
      type: "plan.updated";
      payload: { entries: PlanEntry[] };
    })
  | (GuiEventBase & {
      type: "usage.updated";
      payload: {
        used: number;
        size: number;
        cost?: { amount: number; currency: string };
      };
    })
  | (GuiEventBase & {
      type: "turn.started";
      payload: { turnId: string; prompt: ContentBlock[] };
    })
  | (GuiEventBase & {
      type: "turn.completed";
      payload: { turnId: string; stopReason: StopReason };
    })
  | (GuiEventBase & {
      type: "turn.cancel_requested";
      payload: { turnId: string; reason: "user" | "timeout" };
    })
  | (GuiEventBase & {
      type: "turn.cancelled";
      payload: { turnId: string; stopReason: "cancelled" };
    })
  | (GuiEventBase & {
      type: "session.emergency_stop";
      payload: {
        phase: "cancel" | "kill" | "cleanup";
        detail?: string;
      };
    })
  | (GuiEventBase & {
      type: "tool.started";
      payload: {
        toolCallId: string;
        title: string;
        kind: ToolKind;
        status: ToolCallStatus;
        rawInput?: unknown;
        locations?: Array<{ path: string; line?: number }>;
      };
    })
  | (GuiEventBase & {
      type: "tool.updated";
      payload: {
        toolCallId: string;
        status?: ToolCallStatus;
        title?: string;
        content?: unknown[];
        rawInput?: unknown;
        rawOutput?: unknown;
        locations?: Array<{ path: string; line?: number }>;
      };
    })
  | (GuiEventBase & {
      type: "tool.finished";
      payload: {
        toolCallId: string;
        status: "completed" | "failed" | "cancelled";
        content?: unknown[];
        rawOutput?: unknown;
      };
    })
  | (GuiEventBase & {
      type: "approval.requested";
      payload: {
        requestId: string;
        toolCallId: string;
        title?: string;
        kind?: ToolKind;
        options: ApprovalOption[];
        preview?: unknown;
      };
    })
  | (GuiEventBase & {
      type: "approval.resolved";
      payload: {
        requestId: string;
        outcome: ApprovalOutcome;
        source: "user" | "yolo" | "policy" | "cancel";
      };
    })
  | (GuiEventBase & {
      type: "command.started";
      payload: {
        terminalId: string;
        toolCallId?: string;
        command: string;
        args?: string[];
        cwd?: string;
      };
    })
  | (GuiEventBase & {
      type: "command.output";
      payload: {
        terminalId: string;
        chunk?: string;
        snapshot?: string;
        truncated?: boolean;
      };
    })
  | (GuiEventBase & {
      type: "command.exited";
      payload: {
        terminalId: string;
        exitCode?: number | null;
        signal?: string | null;
      };
    })
  | (GuiEventBase & {
      type: "command.killed";
      payload: {
        terminalId: string;
        reason: "user" | "agent" | "timeout" | "emergency_stop";
      };
    })
  | (GuiEventBase & {
      type: "command.released";
      payload: { terminalId: string };
    })
  | (GuiEventBase & {
      type: "yolo.changed";
      payload: { enabled: boolean };
    })
  | (GuiEventBase & {
      type: "engine.unknown_update";
      payload: { raw: unknown };
    });

export type StartOptions = {
  projectPath: string;
  capabilities?: Record<string, unknown>;
  authPolicy?: "cached" | "browser" | "device" | "api_key";
};

export type CreateSessionOptions = {
  cwd?: string;
};
