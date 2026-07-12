import { describe, expect, it } from "vitest";
import { createEmptySnapshot, reduce } from "./reducer";
import type { GuiEvent, SessionSnapshot } from "./types";

function evt<T extends GuiEvent["type"]>(
  type: T,
  payload: Extract<GuiEvent, { type: T }>["payload"],
  overrides: Partial<Pick<GuiEvent, "eventId" | "sessionId" | "turnId" | "observedAt">> = {},
): Extract<GuiEvent, { type: T }> {
  return {
    eventId: overrides.eventId ?? `e-${type}`,
    observedAt: overrides.observedAt ?? "2026-07-12T00:00:00.000Z",
    sessionId: overrides.sessionId ?? "sess-1",
    turnId: overrides.turnId,
    type,
    payload,
  } as Extract<GuiEvent, { type: T }>;
}

describe("session reducer lifecycle", () => {
  it("starts idle after session.created", () => {
    const initial = createEmptySnapshot({
      sessionId: "pending",
      projectPath: "/tmp/project",
    });
    const next = reduce(
      initial,
      evt("session.created", {
        sessionId: "sess-1",
        cwd: "/tmp/project",
      }),
    );

    expect(next.sessionId).toBe("sess-1");
    expect(next.projectPath).toBe("/tmp/project");
    expect(next.state).toBe("idle");
    expect(next.messages).toEqual([]);
    expect(next.pendingApprovals).toEqual([]);
  });

  it("transitions idle → running on turn.started and records the user prompt", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );

    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-1",
          prompt: [{ type: "text", text: "Hello agent" }],
        },
        { turnId: "turn-1" },
      ),
    );

    expect(snap.state).toBe("running");
    expect(snap.turn?.turnId).toBe("turn-1");
    expect(snap.messages).toHaveLength(1);
    expect(snap.messages[0]?.role).toBe("user");
    expect(snap.messages[0]?.content).toEqual([
      { type: "text", text: "Hello agent" },
    ]);
  });

  it("streams assistant chunks while running and completes turn → idle", () => {
    let snap: SessionSnapshot = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-1",
          prompt: [{ type: "text", text: "Explain main.ts" }],
        },
        { turnId: "turn-1" },
      ),
    );

    snap = reduce(
      snap,
      evt(
        "assistant.message_chunk",
        {
          messageId: "asst-1",
          chunk: { type: "text", text: "Sure, " },
        },
        { turnId: "turn-1" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "assistant.message_chunk",
        {
          messageId: "asst-1",
          chunk: { type: "text", text: "here is the summary." },
        },
        { turnId: "turn-1" },
      ),
    );

    expect(snap.state).toBe("running");
    const assistant = snap.messages.find((m) => m.role === "assistant");
    expect(assistant?.streaming).toBe(true);
    expect(assistant?.content).toEqual([
      { type: "text", text: "Sure, here is the summary." },
    ]);

    snap = reduce(
      snap,
      evt(
        "turn.completed",
        { turnId: "turn-1", stopReason: "end_turn" },
        { turnId: "turn-1" },
      ),
    );

    // completed_turn is transient in the state machine; the pure reducer
    // settles at idle with the stop reason retained (completed transition).
    expect(snap.state).toBe("idle");
    expect(snap.turn?.stopReason).toBe("end_turn");
    expect(snap.messages.find((m) => m.role === "assistant")?.streaming).toBe(
      false,
    );
  });

  it("covers completed transition: running → idle with end_turn stop reason", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-c",
          prompt: [{ type: "text", text: "done soon" }],
        },
        { turnId: "turn-c" },
      ),
    );
    expect(snap.state).toBe("running");

    snap = reduce(
      snap,
      evt(
        "turn.completed",
        { turnId: "turn-c", stopReason: "end_turn" },
        { turnId: "turn-c" },
      ),
    );

    expect(snap.state).toBe("idle");
    expect(snap.turn).toMatchObject({
      turnId: "turn-c",
      stopReason: "end_turn",
    });
  });

  it("faults the session on engine.error", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-1",
          prompt: [{ type: "text", text: "go" }],
        },
        { turnId: "turn-1" },
      ),
    );

    snap = reduce(
      snap,
      evt("engine.error", {
        code: "io_error",
        message: "engine stdout closed unexpectedly",
        recoverable: false,
      }),
    );

    expect(snap.state).toBe("faulted");
    expect(snap.lastError).toEqual({
      code: "io_error",
      message: "engine stdout closed unexpectedly",
      recoverable: false,
    });
  });

  it("disposes the session on session.disposed", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );

    snap = reduce(
      snap,
      evt("session.disposed", { reason: "user" }),
    );

    expect(snap.state).toBe("disposed");
  });

  it("enters awaiting_approval on approval.requested and returns to running when resolved", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-1",
          prompt: [{ type: "text", text: "edit file" }],
        },
        { turnId: "turn-1" },
      ),
    );

    snap = reduce(
      snap,
      evt(
        "approval.requested",
        {
          requestId: "apr-1",
          toolCallId: "tool-1",
          title: "Edit main.ts",
          kind: "edit",
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
        { turnId: "turn-1" },
      ),
    );

    expect(snap.state).toBe("awaiting_approval");
    expect(snap.pendingApprovals).toHaveLength(1);

    snap = reduce(
      snap,
      evt(
        "approval.resolved",
        {
          requestId: "apr-1",
          outcome: { outcome: "selected", optionId: "allow-once" },
          source: "user",
        },
        { turnId: "turn-1" },
      ),
    );

    expect(snap.state).toBe("running");
    expect(snap.pendingApprovals).toHaveLength(0);
  });

  it("enters cancelling on turn.cancel_requested and returns idle after turn.cancelled", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-1",
          prompt: [{ type: "text", text: "long task" }],
        },
        { turnId: "turn-1" },
      ),
    );

    snap = reduce(
      snap,
      evt(
        "turn.cancel_requested",
        { turnId: "turn-1", reason: "user" },
        { turnId: "turn-1" },
      ),
    );
    expect(snap.state).toBe("cancelling");

    snap = reduce(
      snap,
      evt(
        "turn.cancelled",
        { turnId: "turn-1", stopReason: "cancelled" },
        { turnId: "turn-1" },
      ),
    );
    expect(snap.state).toBe("idle");
    expect(snap.turn?.stopReason).toBe("cancelled");
  });
});
