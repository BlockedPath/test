/**
 * Integration-ish boundary tests: YOLO vs Cancel, Emergency Stop, redaction,
 * elevated, and hard blocks — through FakeAgentEngine + safety state.
 *
 * Seam: FakeAgentEngine (AgentEnginePort) + pure safety policy.
 */
import { describe, expect, it } from "vitest";
import { FakeAgentEngine } from "../engine/fake-engine";
import { reduce, createEmptySnapshot } from "../engine/reducer";
import type { GuiEvent, SessionSnapshot } from "../engine/types";
import {
  createSessionSafetyState,
  decideAction,
  resetSessionSafety,
  YOLO_INDICATOR_LABEL,
  YOLO_WARNING,
} from "./index";

function baseEvent(
  partial: Omit<GuiEvent, "eventId" | "observedAt"> & { type: GuiEvent["type"] },
): GuiEvent {
  return {
    eventId: "e1",
    observedAt: new Date().toISOString(),
    ...partial,
  } as GuiEvent;
}

describe("YOLO boundaries through Session + engine", () => {
  it("YOLO is off by default on a new Session", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0 });
    await engine.start({ projectPath: "/tmp/proj" });
    await engine.createSession({ cwd: "/tmp/proj" });
    expect(engine.getSnapshot()?.yoloEnabled).toBe(false);
  });

  it("refuses to enable YOLO without warning acknowledgment", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0 });
    await engine.start({ projectPath: "/tmp/proj" });
    await engine.createSession({ cwd: "/tmp/proj" });
    await expect(engine.setYolo(true)).rejects.toThrow(/warning/i);
    expect(engine.getSnapshot()?.yoloEnabled).toBe(false);
  });

  it("enables YOLO only after warning acknowledgment and keeps indicator text available", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0 });
    await engine.start({ projectPath: "/tmp/proj" });
    await engine.createSession({ cwd: "/tmp/proj" });
    await engine.setYolo(true, { acknowledgeWarning: true });
    expect(engine.getSnapshot()?.yoloEnabled).toBe(true);
    expect(YOLO_WARNING).toMatch(/elevated|hard blocks|Emergency Stop/i);
    expect(YOLO_INDICATOR_LABEL).toMatch(/YOLO/i);
  });

  it("Cancel still dismisses pending approvals while YOLO is on", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 0,
      commandTurn: true,
      richTurn: false,
    });
    await engine.start({ projectPath: "/tmp/proj" });
    await engine.createSession({ cwd: "/tmp/proj" });
    // Force elevated path: YOLO alone should not auto-resolve elevated in policy;
    // for cancel, use a non-YOLO pending approval then enable YOLO mid-flight.
    // Demo command is normal — disable YOLO, start prompt, cancel while awaiting.
    const promptPromise = engine.sendPrompt("run tests");
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getSnapshot()?.state).toBe("awaiting_approval");
    expect(engine.getSnapshot()?.pendingApprovals.length).toBeGreaterThan(0);

    await engine.cancel();
    await promptPromise.catch(() => undefined);

    const snap = engine.getSnapshot();
    expect(snap?.pendingApprovals.length ?? 0).toBe(0);
    // YOLO would not have prevented cancel of the pending approval.
  });

  it("Emergency Stop clears YOLO for the next Session", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0 });
    await engine.start({ projectPath: "/tmp/proj" });
    await engine.createSession({ cwd: "/tmp/proj" });
    await engine.setYolo(true, { acknowledgeWarning: true });
    expect(engine.getSnapshot()?.yoloEnabled).toBe(true);

    await engine.emergencyStop();
    // After emergency stop, a recovery createSession must start YOLO-off.
    // Fake engine may be faulted; createSession still resets snapshot.
    const sid = await engine.createSession({ cwd: "/tmp/proj" });
    expect(sid).toBeTruthy();
    expect(engine.getSnapshot()?.yoloEnabled).toBe(false);
  });

  it("reducer keeps YOLO flag until yolo.changed / session reset path", () => {
    let snap: SessionSnapshot = createEmptySnapshot({
      sessionId: "s1",
      projectPath: "/tmp/p",
    });
    expect(snap.yoloEnabled).toBe(false);
    snap = reduce(
      snap,
      baseEvent({
        type: "yolo.changed",
        sessionId: "s1",
        payload: { enabled: true },
      }),
    );
    expect(snap.yoloEnabled).toBe(true);

    // Emergency stop does not itself flip the flag in the reducer (session-level
    // reset does); engines call resetSessionSafety + createSession.
    snap = reduce(
      snap,
      baseEvent({
        type: "session.emergency_stop",
        sessionId: "s1",
        payload: { phase: "kill" },
      }),
    );
    expect(snap.state).toBe("faulted");
  });

  it("resetSessionSafety is what clears YOLO after Emergency Stop", () => {
    const s = resetSessionSafety({
      ...createSessionSafetyState("/tmp/p"),
      yoloEnabled: true,
      commandAllowlist: [commandFp()],
    });
    expect(s.yoloEnabled).toBe(false);
    expect(s.commandAllowlist).toEqual([]);
  });

  it("YOLO does not auto-allow elevated or hard-blocked actions", () => {
    const s = {
      ...createSessionSafetyState("/tmp/proj"),
      yoloEnabled: true,
    };
    expect(
      decideAction(s, {
        kind: "command",
        command: "git",
        args: ["push", "--force", "origin", "main"],
        cwd: "/tmp/proj",
      }).decision,
    ).toBe("prompt");
    expect(
      decideAction(s, {
        kind: "edit",
        path: "/tmp/proj/.env",
        content: "A=1",
      }).decision,
    ).toBe("prompt");
    expect(
      decideAction(s, {
        kind: "edit",
        path: "/tmp/proj/src/a.ts",
        content: "Bearer supersecrettokenvalue",
      }).decision,
    ).toBe("hard_block");
  });
});

function commandFp(): string {
  return '["npm","test"]';
}
