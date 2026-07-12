/**
 * Recovery vertical slice (#17) — cancel, emergency stop, cleanup, restart.
 * Seams: AgentEnginePort (fake), reducer projections.
 */
import { describe, expect, it } from "vitest";
import { FakeAgentEngine } from "./fake-engine";
import { createEmptySnapshot, reduce } from "./reducer";
import type { GuiEvent, SessionSnapshot } from "./types";

function evt<T extends GuiEvent["type"]>(
  type: T,
  payload: Extract<GuiEvent, { type: T }>["payload"],
  extra: Partial<GuiEvent> = {},
): GuiEvent {
  return {
    type,
    eventId: `e-${Math.random().toString(36).slice(2)}`,
    observedAt: new Date().toISOString(),
    sessionId: "sess-1",
    ...extra,
    payload,
  } as GuiEvent;
}

async function settle(ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("Reducer: cancellation and emergency cleanup projections", () => {
  it("dismisses pending approvals and rejects file batches on cancel", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        { turnId: "t1", prompt: [{ type: "text", text: "edit" }] },
        { turnId: "t1" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "approval.requested",
        {
          requestId: "apr-1",
          toolCallId: "tool-1",
          title: "Apply edit",
          kind: "edit",
          options: [
            { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          ],
        },
        { turnId: "t1" },
      ),
    );
    snap = reduce(
      snap,
      evt(
        "file.batch_proposed",
        {
          batch: {
            batchId: "batch-1",
            title: "Edits",
            status: "pending",
            turnId: "t1",
            changes: [
              {
                changeId: "c1",
                path: "a.ts",
                kind: "edit",
                status: "pending",
                selected: true,
                malformed: false,
                diff: {
                  path: "a.ts",
                  oldText: "a",
                  newText: "b",
                },
              },
            ],
          },
        },
        { turnId: "t1" },
      ),
    );

    snap = reduce(
      snap,
      evt(
        "turn.cancelled",
        { turnId: "t1", stopReason: "cancelled" },
        { turnId: "t1" },
      ),
    );

    expect(snap.state).toBe("idle");
    expect(snap.turn?.stopReason).toBe("cancelled");
    expect(snap.pendingApprovals).toHaveLength(0);
    expect(snap.fileChangeBatches[0]?.status).toBe("resolved");
    expect(snap.fileChangeBatches[0]?.changes[0]?.status).toBe("rejected");
  });

  it("records cleanup phase with orphan possibility on emergency stop", () => {
    let snap = reduce(
      createEmptySnapshot({ sessionId: "sess-1", projectPath: "/proj" }),
      evt("session.created", { sessionId: "sess-1", cwd: "/proj" }),
    );
    snap = reduce(
      snap,
      evt(
        "turn.started",
        { turnId: "t1", prompt: [{ type: "text", text: "hang" }] },
        { turnId: "t1" },
      ),
    );
    snap = reduce(
      snap,
      evt("session.emergency_stop", {
        phase: "cancel",
      }),
    );
    expect(snap.state).toBe("cancelling");

    snap = reduce(
      snap,
      evt("session.emergency_stop", {
        phase: "kill",
        detail: "terminating engine process",
      }),
    );
    expect(snap.state).toBe("faulted");

    snap = reduce(
      snap,
      evt("session.emergency_stop", {
        phase: "cleanup",
        detail: "Possible orphan pid 4242",
        cleanupStatus: "orphans_possible",
        orphanPids: [4242],
      }),
    );

    expect(snap.cleanup?.status).toBe("orphans_possible");
    expect(snap.cleanup?.orphanPids).toEqual([4242]);
    expect(snap.cleanup?.detail).toMatch(/orphan|4242/i);
  });
});

describe("FakeAgentEngine: cooperative Cancel", () => {
  it("cancels mid-stream and marks the turn interrupted, not successful", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 40, richTurn: false });
    await engine.start({ projectPath: "/proj" });
    await engine.createSession();

    const promptP = engine.sendPrompt("stream a long answer");
    await settle(10);
    await engine.cancel();
    await promptP;

    const snap = engine.getSnapshot()!;
    expect(snap.turn?.stopReason).toBe("cancelled");
    expect(snap.state).toBe("idle");
    expect(snap.turn?.stopReason).not.toBe("end_turn");
  });

  it("dismisses pending approvals on cancel and prevents new tools from starting", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 30,
      richTurn: false,
      commandTurn: true,
    });
    const events: GuiEvent["type"][] = [];
    engine.subscribe((e) => events.push(e.type));

    await engine.start({ projectPath: "/proj" });
    await engine.createSession();

    const promptP = engine.sendPrompt("run something");
    await settle(5);
    // Wait until approval is pending
    await settle(20);
    expect(engine.getSnapshot()?.pendingApprovals.length ?? 0).toBeGreaterThan(0);

    await engine.cancel();
    await promptP;

    const snap = engine.getSnapshot()!;
    expect(snap.pendingApprovals).toHaveLength(0);
    expect(snap.turn?.stopReason).toBe("cancelled");
    expect(events).toContain("turn.cancel_requested");
    expect(events).toContain("approval.resolved");
    // No successful command completion after cancel
    const toolStatuses = Object.values(snap.tools).map((t) => t.status);
    expect(toolStatuses.every((s) => s !== "completed" || !s)).toBeTruthy();
    expect(
      Object.values(snap.tools).some(
        (t) => t.kind === "execute" && t.status === "cancelled",
      ),
    ).toBe(true);
  });

  it("stops a running command on cancel (command execution path)", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 50,
      richTurn: false,
      commandTurn: true,
      // Auto-allow so the command starts before we cancel
      autoAllowCommands: true,
    });
    await engine.start({ projectPath: "/proj" });
    await engine.createSession();

    const promptP = engine.sendPrompt("run and hang");
    await settle(30);
    // Command should have started
    const mid = engine.getSnapshot()!;
    const running = Object.values(mid.terminals).some((t) => t.status === "running");
    // If still at approval, allow then cancel; if running, cancel directly
    if (!running && mid.pendingApprovals.length > 0) {
      // autoAllow should have resolved; wait a bit more
      await settle(40);
    }

    await engine.cancel();
    await promptP;

    const snap = engine.getSnapshot()!;
    expect(snap.turn?.stopReason).toBe("cancelled");
    const terminals = Object.values(snap.terminals);
    if (terminals.length > 0) {
      expect(terminals.every((t) => t.status !== "running")).toBe(true);
      expect(terminals.some((t) => t.status === "killed")).toBe(true);
    }
  });

  it("rejects pending file-write review on cancel without claiming rollback", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 40,
      richTurn: false,
      proposeEditsOnPrompt: true,
    });
    await engine.start({ projectPath: "/proj" });
    await engine.createSession();

    const promptP = engine.sendPrompt("propose edits");
    await settle(20);
    expect(
      engine.getSnapshot()?.fileChangeBatches.some((b) => b.status === "pending"),
    ).toBe(true);

    await engine.cancel();
    await promptP;

    const snap = engine.getSnapshot()!;
    expect(snap.turn?.stopReason).toBe("cancelled");
    expect(snap.fileChangeBatches.every((b) => b.status !== "pending")).toBe(true);
    // Files were never claimed rolled back — batches are rejected, not applied
    expect(
      snap.fileChangeBatches.flatMap((b) => b.changes).every((c) => c.status !== "applied"),
    ).toBe(true);
  });
});

describe("FakeAgentEngine: Emergency Stop and recovery", () => {
  it("escalates cancel → kill → cleanup and surfaces incomplete cleanup", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 80,
      richTurn: false,
      // Force incomplete cleanup for the test
      emergencyCleanupStatus: "orphans_possible",
      emergencyOrphanPids: [9001],
    });
    const events: GuiEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.start({ projectPath: "/proj" });
    await engine.createSession();
    const promptP = engine.sendPrompt("hung turn");
    await settle(10);
    await engine.emergencyStop();
    await promptP.catch(() => undefined);

    const phases = events
      .filter((e) => e.type === "session.emergency_stop")
      .map((e) => (e as Extract<GuiEvent, { type: "session.emergency_stop" }>).payload.phase);
    expect(phases).toEqual(expect.arrayContaining(["cancel", "kill", "cleanup"]));

    const snap = engine.getSnapshot()!;
    expect(snap.state).toBe("faulted");
    expect(snap.lastError?.code).toBe("emergency_stop");
    expect(snap.cleanup?.status).toBe("orphans_possible");
    expect(snap.cleanup?.orphanPids).toContain(9001);
    // Explicitly denies silent rollback rather than claiming one.
    expect(snap.cleanup?.detail ?? "").toMatch(/Nothing was rolled back/i);
  });

  it("starts new and resumed Sessions with YOLO disabled after Emergency Stop", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0, richTurn: false });
    await engine.start({ projectPath: "/proj" });
    await engine.createSession();
    await engine.setYolo(true, { acknowledgeWarning: true });
    expect(engine.getSnapshot()?.yoloEnabled).toBe(true);
    expect(engine.getSafetyState().yoloEnabled).toBe(true);

    await engine.emergencyStop();
    expect(engine.getSnapshot()?.yoloEnabled).toBe(false);
    expect(engine.getSafetyState().yoloEnabled).toBe(false);

    const newId = await engine.createSession();
    expect(newId).toBeTruthy();
    expect(engine.getSnapshot()?.yoloEnabled).toBe(false);
    expect(engine.getSafetyState().yoloEnabled).toBe(false);
    expect(engine.getSnapshot()?.state).toBe("idle");
    expect(engine.getSnapshot()?.lastError).toBeUndefined();

    await engine.setYolo(true, { acknowledgeWarning: true });
    await engine.emergencyStop();
    await engine.resumeSession("sess-resumed-after-estop");
    expect(engine.getSnapshot()?.yoloEnabled).toBe(false);
    expect(engine.getSafetyState().yoloEnabled).toBe(false);
  });

  it("allows Retry engine / Reset Session after emergency fault", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 20, richTurn: false });
    await engine.start({ projectPath: "/proj" });
    await engine.createSession();
    const promptP = engine.sendPrompt("go");
    await settle(5);
    await engine.emergencyStop();
    await promptP.catch(() => undefined);
    expect(engine.getSnapshot()?.state).toBe("faulted");

    // Reset Session → usable again
    await engine.createSession();
    expect(engine.getSnapshot()?.state).toBe("idle");
    await engine.sendPrompt("after reset");
    await settle(10);
    expect(engine.getSnapshot()?.turn?.stopReason).toBe("end_turn");
  });

  it("handles hung-process style emergency stop without hanging the port", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 5_000,
      richTurn: false,
      hangTurn: true,
    });
    await engine.start({ projectPath: "/proj" });
    await engine.createSession();

    const promptP = engine.sendPrompt("this hangs until emergency");
    await settle(20);
    expect(engine.getSnapshot()?.state).toBe("running");

    const t0 = Date.now();
    await engine.emergencyStop();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000);

    await promptP.catch(() => undefined);
    expect(engine.getSnapshot()?.state).toBe("faulted");
    expect(engine.getSnapshot()?.lastError?.code).toBe("emergency_stop");
  });
});

describe("Reducer: session.created clears fault for recovery", () => {
  it("clears lastError and cleanup when a new session is created", () => {
    let snap: SessionSnapshot = {
      ...createEmptySnapshot({ sessionId: "old", projectPath: "/proj" }),
      state: "faulted",
      lastError: {
        code: "emergency_stop",
        message: "stopped",
        recoverable: true,
      },
      cleanup: {
        status: "orphans_possible",
        detail: "pid 1",
        orphanPids: [1],
      },
      yoloEnabled: true,
    };
    snap = reduce(
      snap,
      evt("session.created", { sessionId: "new", cwd: "/proj" }),
    );
    expect(snap.state).toBe("idle");
    expect(snap.lastError).toBeUndefined();
    expect(snap.cleanup).toBeUndefined();
    // YOLO is engine-owned via yolo.changed; createSession implementations
    // emit yolo off separately — reducer leaves flag unless event says so.
  });
});
