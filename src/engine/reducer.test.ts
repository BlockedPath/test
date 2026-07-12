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

  it("tracks command lifecycle in terminals and keeps output after release", () => {
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
          prompt: [{ type: "text", text: "run tests" }],
        },
        { turnId: "turn-1" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "command.started",
        {
          terminalId: "term-1",
          toolCallId: "tool-exec-1",
          command: "npm",
          args: ["test"],
          cwd: "/proj",
        },
        { turnId: "turn-1" },
      ),
    );
    expect(snap.terminals["term-1"]?.status).toBe("running");
    expect(snap.terminals["term-1"]?.command).toBe("npm");

    snap = reduce(
      snap,
      evt(
        "command.output",
        {
          terminalId: "term-1",
          chunk: "ok\n",
          snapshot: "ok\n",
        },
        { turnId: "turn-1" },
      ),
    );
    expect(snap.terminals["term-1"]?.output).toBe("ok\n");

    snap = reduce(
      snap,
      evt(
        "command.exited",
        { terminalId: "term-1", exitCode: 0, signal: null },
        { turnId: "turn-1" },
      ),
    );
    expect(snap.terminals["term-1"]?.status).toBe("exited");
    expect(snap.terminals["term-1"]?.exitCode).toBe(0);

    snap = reduce(
      snap,
      evt("command.released", { terminalId: "term-1" }, { turnId: "turn-1" }),
    );
    expect(snap.terminals["term-1"]?.status).toBe("released");
    expect(snap.terminals["term-1"]?.output).toBe("ok\n");
  });

  it("marks running terminals killed on cancel", () => {
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
          prompt: [{ type: "text", text: "hang" }],
        },
        { turnId: "turn-1" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "command.started",
        {
          terminalId: "term-1",
          command: "sleep",
          args: ["99"],
          cwd: "/proj",
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
    expect(snap.terminals["term-1"]?.status).toBe("killed");
  });

  it("appends thought chunks as thought-role messages distinct from assistant text", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-t",
          prompt: [{ type: "text", text: "think" }],
        },
        { turnId: "turn-t" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "assistant.thought_chunk",
        {
          messageId: "thought-1",
          chunk: { type: "text", text: "Considering the layout… " },
        },
        { turnId: "turn-t" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "assistant.message_chunk",
        {
          messageId: "asst-1",
          chunk: { type: "text", text: "Final answer." },
        },
        { turnId: "turn-t" },
      ),
    );

    const thought = snap.messages.find((m) => m.role === "thought");
    const assistant = snap.messages.find((m) => m.role === "assistant");
    expect(thought?.content).toEqual([
      { type: "text", text: "Considering the layout… " },
    ]);
    expect(assistant?.content).toEqual([{ type: "text", text: "Final answer." }]);
  });

  it("records multi-file edit batches and enters awaiting_approval", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        {
          turnId: "turn-edit",
          prompt: [{ type: "text", text: "edit files" }],
        },
        { turnId: "turn-edit" },
      ),
    );

    const batch = {
      batchId: "batch-1",
      title: "Multi-file edit",
      status: "pending" as const,
      changes: [
        {
          changeId: "c1",
          path: "a.ts",
          kind: "create" as const,
          status: "pending" as const,
          selected: true,
          malformed: false,
          diff: { path: "a.ts", oldText: null, newText: "x\n" },
        },
        {
          changeId: "c2",
          path: "b.ts",
          kind: "delete" as const,
          status: "pending" as const,
          selected: true,
          malformed: false,
          diff: { path: "b.ts", oldText: "y\n", newText: null },
        },
      ],
    };

    snap = reduce(
      snap,
      evt("file.batch_proposed", { batch }, { turnId: "turn-edit" }),
    );

    expect(snap.state).toBe("awaiting_approval");
    expect(snap.fileChangeBatches).toHaveLength(1);
    expect(snap.fileChangeBatches[0]!.changes.map((c) => c.path)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("updates batch after partial apply and leaves no silent pending writes", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );

    const pending = {
      batchId: "batch-1",
      title: "Partial",
      status: "pending" as const,
      changes: [
        {
          changeId: "c1",
          path: "a.ts",
          kind: "create" as const,
          status: "pending" as const,
          selected: true,
          malformed: false,
        },
        {
          changeId: "c2",
          path: "b.ts",
          kind: "edit" as const,
          status: "pending" as const,
          selected: false,
          malformed: false,
        },
      ],
    };

    snap = reduce(snap, evt("file.batch_proposed", { batch: pending }));

    const resolved = {
      ...pending,
      status: "resolved" as const,
      changes: [
        { ...pending.changes[0]!, status: "applied" as const, selected: false },
        { ...pending.changes[1]!, status: "skipped" as const, selected: false },
      ],
    };

    snap = reduce(snap, evt("file.batch_updated", { batch: resolved }));

    expect(snap.fileChangeBatches[0]!.status).toBe("resolved");
    expect(snap.fileChangeBatches[0]!.changes.map((c) => c.status)).toEqual([
      "applied",
      "skipped",
    ]);
  });

  it("rejects pending file batches on cancel", () => {
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
          prompt: [{ type: "text", text: "edit" }],
        },
        { turnId: "turn-1" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "file.batch_proposed",
        {
          batch: {
            batchId: "batch-x",
            title: "Edit",
            status: "pending",
            changes: [
              {
                changeId: "c1",
                path: "a.ts",
                kind: "edit",
                status: "pending",
                selected: true,
                malformed: false,
              },
            ],
          },
        },
        { turnId: "turn-1" },
      ),
    );

    snap = reduce(
      snap,
      evt(
        "turn.cancelled",
        { turnId: "turn-1", stopReason: "cancelled" },
        { turnId: "turn-1" },
      ),
    );

    expect(snap.fileChangeBatches[0]!.status).toBe("resolved");
    expect(snap.fileChangeBatches[0]!.changes[0]!.status).toBe("rejected");
  });
});
