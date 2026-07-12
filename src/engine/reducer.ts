import type {
  ContentBlock,
  GuiEvent,
  Message,
  SessionSnapshot,
  ToolCallRecord,
} from "./types";

export function createEmptySnapshot(seed: {
  sessionId: string;
  projectPath: string;
}): SessionSnapshot {
  return {
    sessionId: seed.sessionId,
    projectPath: seed.projectPath,
    state: "idle",
    yoloEnabled: false,
    messages: [],
    tools: {},
    terminals: {},
    pendingApprovals: [],
  };
}

function appendTextChunk(
  content: ContentBlock[],
  chunk: ContentBlock,
): ContentBlock[] {
  if (chunk.type !== "text") {
    return [...content, chunk];
  }
  const last = content[content.length - 1];
  if (last && last.type === "text") {
    return [
      ...content.slice(0, -1),
      { type: "text", text: last.text + chunk.text },
    ];
  }
  return [...content, chunk];
}

function upsertRoleMessage(
  messages: Message[],
  messageId: string,
  role: Message["role"],
  chunk: ContentBlock,
): Message[] {
  const idx = messages.findIndex((m) => m.messageId === messageId);
  if (idx === -1) {
    return [
      ...messages,
      {
        messageId,
        role,
        content: [chunk],
        streaming: true,
      },
    ];
  }
  const existing = messages[idx]!;
  const next = [...messages];
  next[idx] = {
    ...existing,
    content: appendTextChunk(existing.content, chunk),
    streaming: true,
  };
  return next;
}

function upsertAssistantMessage(
  messages: Message[],
  messageId: string,
  chunk: ContentBlock,
): Message[] {
  return upsertRoleMessage(messages, messageId, "assistant", chunk);
}

function finishStreamingMessages(messages: Message[]): Message[] {
  return messages.map((m) =>
    m.streaming ? { ...m, streaming: false } : m,
  );
}

/**
 * Pure reducer: GuiEvent → SessionSnapshot.
 * Surfaces render projections of the snapshot, never raw ACP/TUI.
 */
export function reduce(
  snapshot: SessionSnapshot,
  event: GuiEvent,
): SessionSnapshot {
  switch (event.type) {
    case "engine.started":
      return {
        ...snapshot,
        projectPath: event.payload.cwd || snapshot.projectPath,
        engineVersion: event.payload.engineVersion,
        protocolVersion: event.payload.protocolVersion,
      };

    case "session.created":
    case "session.resumed":
      return {
        ...snapshot,
        sessionId: event.payload.sessionId,
        projectPath: event.payload.cwd || snapshot.projectPath,
        state: "idle",
        lastError: undefined,
      };

    case "turn.started": {
      const userMessage: Message = {
        messageId: `user-${event.payload.turnId}`,
        role: "user",
        content: event.payload.prompt,
      };
      return {
        ...snapshot,
        state: "running",
        turn: {
          turnId: event.payload.turnId,
          startedAt: event.observedAt,
        },
        messages: [...snapshot.messages, userMessage],
        lastError: undefined,
      };
    }

    case "user.message": {
      // Prefer turn.started for user text; still accept explicit user.message
      const exists = snapshot.messages.some(
        (m) => m.messageId === event.payload.messageId,
      );
      if (exists) return snapshot;
      return {
        ...snapshot,
        messages: [
          ...snapshot.messages,
          {
            messageId: event.payload.messageId,
            role: "user",
            content: event.payload.content,
          },
        ],
      };
    }

    case "assistant.message_chunk": {
      const messageId =
        event.payload.messageId ??
        `asst-${event.turnId ?? snapshot.turn?.turnId ?? "unknown"}`;
      return {
        ...snapshot,
        messages: upsertAssistantMessage(
          snapshot.messages,
          messageId,
          event.payload.chunk,
        ),
      };
    }

    case "assistant.thought_chunk": {
      const messageId =
        event.payload.messageId ??
        `thought-${event.turnId ?? snapshot.turn?.turnId ?? "unknown"}`;
      return {
        ...snapshot,
        messages: upsertRoleMessage(
          snapshot.messages,
          messageId,
          "thought",
          event.payload.chunk,
        ),
      };
    }

    case "plan.updated":
      return { ...snapshot, plan: event.payload.entries };

    case "usage.updated":
      return {
        ...snapshot,
        usage: {
          used: event.payload.used,
          size: event.payload.size,
          cost: event.payload.cost,
        },
      };

    case "turn.completed": {
      const isCurrent = snapshot.turn?.turnId === event.payload.turnId;
      // completed_turn is transient in the state machine; the pure reducer
      // settles at idle with the stop reason retained (see event contract).
      return {
        ...snapshot,
        state: "idle",
        turn: isCurrent
          ? {
              turnId: event.payload.turnId,
              startedAt: snapshot.turn?.startedAt ?? event.observedAt,
              stopReason: event.payload.stopReason,
            }
          : snapshot.turn,
        messages: finishStreamingMessages(snapshot.messages),
      };
    }

    case "turn.cancel_requested":
      return {
        ...snapshot,
        state: "cancelling",
      };

    case "turn.cancelled":
      return {
        ...snapshot,
        state: "idle",
        turn: {
          turnId: event.payload.turnId,
          startedAt: snapshot.turn?.startedAt ?? event.observedAt,
          stopReason: "cancelled",
        },
        messages: finishStreamingMessages(snapshot.messages),
        pendingApprovals: [],
        tools: cancelOpenTools(snapshot.tools),
      };

    case "tool.started": {
      const record: ToolCallRecord = {
        toolCallId: event.payload.toolCallId,
        title: event.payload.title,
        kind: event.payload.kind,
        status: event.payload.status,
        rawInput: event.payload.rawInput,
        locations: event.payload.locations,
      };
      return {
        ...snapshot,
        tools: { ...snapshot.tools, [record.toolCallId]: record },
      };
    }

    case "tool.updated": {
      const prev = snapshot.tools[event.payload.toolCallId];
      if (!prev) return snapshot;
      return {
        ...snapshot,
        tools: {
          ...snapshot.tools,
          [event.payload.toolCallId]: {
            ...prev,
            status: event.payload.status ?? prev.status,
            title: event.payload.title ?? prev.title,
            content: event.payload.content ?? prev.content,
            rawInput: event.payload.rawInput ?? prev.rawInput,
            rawOutput: event.payload.rawOutput ?? prev.rawOutput,
            locations: event.payload.locations ?? prev.locations,
          },
        },
      };
    }

    case "tool.finished": {
      const prev = snapshot.tools[event.payload.toolCallId];
      if (!prev) return snapshot;
      return {
        ...snapshot,
        tools: {
          ...snapshot.tools,
          [event.payload.toolCallId]: {
            ...prev,
            status: event.payload.status,
            content: event.payload.content ?? prev.content,
            rawOutput: event.payload.rawOutput ?? prev.rawOutput,
          },
        },
      };
    }

    case "approval.requested":
      return {
        ...snapshot,
        state: "awaiting_approval",
        pendingApprovals: [
          ...snapshot.pendingApprovals.filter(
            (a) => a.requestId !== event.payload.requestId,
          ),
          {
            requestId: event.payload.requestId,
            toolCallId: event.payload.toolCallId,
            title: event.payload.title,
            kind: event.payload.kind,
            options: event.payload.options,
            preview: event.payload.preview,
          },
        ],
      };

    case "approval.resolved": {
      const remaining = snapshot.pendingApprovals.filter(
        (a) => a.requestId !== event.payload.requestId,
      );
      const stillRunning =
        snapshot.turn &&
        snapshot.state !== "cancelling" &&
        snapshot.state !== "faulted" &&
        snapshot.state !== "disposed";
      return {
        ...snapshot,
        pendingApprovals: remaining,
        state:
          remaining.length === 0 && stillRunning
            ? "running"
            : remaining.length > 0
              ? "awaiting_approval"
              : snapshot.state === "awaiting_approval"
                ? "running"
                : snapshot.state,
      };
    }

    case "yolo.changed":
      return { ...snapshot, yoloEnabled: event.payload.enabled };

    case "session.emergency_stop":
      if (event.payload.phase === "cancel") {
        return { ...snapshot, state: "cancelling" };
      }
      return {
        ...snapshot,
        state: event.payload.phase === "cleanup" ? "disposed" : "faulted",
        messages: finishStreamingMessages(snapshot.messages),
        pendingApprovals: [],
        tools: cancelOpenTools(snapshot.tools),
      };

    case "engine.error":
      return {
        ...snapshot,
        state: "faulted",
        lastError: {
          code: event.payload.code,
          message: event.payload.message,
          recoverable: event.payload.recoverable,
        },
        messages: finishStreamingMessages(snapshot.messages),
      };

    case "engine.exited":
      if (snapshot.state === "disposed" || snapshot.state === "faulted") {
        return snapshot;
      }
      // Unexpected exit while a turn is open (or cancelling) is a fault.
      if (
        snapshot.state === "running" ||
        snapshot.state === "awaiting_approval" ||
        snapshot.state === "cancelling"
      ) {
        return {
          ...snapshot,
          state: "faulted",
          lastError: snapshot.lastError ?? {
            code: "engine_exited",
            message: `Engine exited (code=${event.payload.exitCode ?? "null"})`,
            recoverable: false,
          },
        };
      }
      return snapshot;

    case "session.disposed":
      return {
        ...snapshot,
        state: "disposed",
        messages: finishStreamingMessages(snapshot.messages),
        pendingApprovals: [],
        tools: cancelOpenTools(snapshot.tools),
      };

    case "engine.authenticated":
    case "engine.stderr":
    case "engine.unknown_update":
      return snapshot;

    default: {
      // Exhaustiveness: unknown events must not crash the reducer
      const _never: never = event;
      void _never;
      return snapshot;
    }
  }
}

function cancelOpenTools(
  tools: Record<string, ToolCallRecord>,
): Record<string, ToolCallRecord> {
  const next: Record<string, ToolCallRecord> = {};
  for (const [id, tool] of Object.entries(tools)) {
    if (tool.status === "pending" || tool.status === "in_progress") {
      next[id] = { ...tool, status: "cancelled" };
    } else {
      next[id] = tool;
    }
  }
  return next;
}
