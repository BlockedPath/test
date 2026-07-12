import { describe, expect, it } from "vitest";
import { FakeAgentEngine } from "./fake-engine";
import type { GuiEvent } from "./types";

describe("FakeAgentEngine (AgentEnginePort seam)", () => {
  it("exposes startup, session lifecycle, prompt, and disposal operations", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0 });
    const events: GuiEvent["type"][] = [];
    engine.subscribe((e) => events.push(e.type));

    await engine.start({ projectPath: "/tmp/demo-project" });
    await engine.authenticate();
    const sessionId = await engine.createSession();
    expect(sessionId).toMatch(/^sess-fake-/);

    await engine.sendPrompt("Hello from the port test");
    // allow microtasks + zero-delay timers
    await new Promise((r) => setTimeout(r, 10));

    const snap = engine.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.state).toBe("idle");
    expect(snap!.messages.some((m) => m.role === "user")).toBe(true);
    expect(snap!.messages.some((m) => m.role === "assistant")).toBe(true);
    expect(
      snap!.messages
        .find((m) => m.role === "assistant")
        ?.content.some(
          (c) => c.type === "text" && c.text.includes("AgentEnginePort"),
        ),
    ).toBe(true);

    await engine.dispose();
    expect(engine.getSnapshot()?.state).toBe("disposed");

    expect(events).toContain("engine.started");
    expect(events).toContain("engine.authenticated");
    expect(events).toContain("session.created");
    expect(events).toContain("turn.started");
    expect(events).toContain("assistant.message_chunk");
    expect(events).toContain("turn.completed");
    expect(events).toContain("session.disposed");

    // Never expose ACP / TUI concepts on the public event stream
    for (const t of events) {
      expect(t).not.toMatch(/session\/|jsonrpc|tui/i);
    }
  });

  it("supports cancel and emergency stop operations", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 50 });
    await engine.start({ projectPath: "/tmp/demo" });
    await engine.createSession();

    const promptPromise = engine.sendPrompt("long running");
    await new Promise((r) => setTimeout(r, 20));
    await engine.cancel();
    await promptPromise;

    expect(engine.getSnapshot()?.state).toBe("idle");
    expect(engine.getSnapshot()?.turn?.stopReason).toBe("cancelled");

    const second = engine.sendPrompt("again");
    await new Promise((r) => setTimeout(r, 10));
    await engine.emergencyStop();
    await second;
    expect(engine.getSnapshot()?.state).toBe("faulted");
    expect(engine.getSnapshot()?.lastError?.code).toBe("emergency_stop");
  });

  it("supports approval response and yolo toggle on the port", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0 });
    await engine.start({ projectPath: "/tmp/demo" });
    await engine.createSession();

    // Drive approval via reducer by injecting through public send path is limited;
    // setYolo and respondToApproval must exist and update snapshot when events fire.
    await engine.setYolo(true);
    expect(engine.getSnapshot()?.yoloEnabled).toBe(true);

    // Synthesize an approval by using internal emit path via respond after manual event:
    // Port contract: respondToApproval is available even when no pending approval.
    await engine.respondToApproval("apr-x", {
      outcome: "selected",
      optionId: "allow-once",
    });
    // No throw = success for empty resolve; snapshot remains valid
    expect(engine.getSnapshot()?.state).toBe("idle");
  });
});
