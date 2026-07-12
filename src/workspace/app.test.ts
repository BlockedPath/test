/**
 * @vitest-environment happy-dom
 *
 * UI behavior tests at the workspace boundary.
 * Drive ConversationApp with FakeAgentEngine; assert external DOM behavior only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentEngine } from "../engine/fake-engine";
import { ConversationApp } from "./app";

async function flush(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("ConversationApp (workspace UI × FakeAgentEngine)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    root.id = "app";
    document.body.appendChild(root);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mount(
    engine: FakeAgentEngine,
    options?: { projectPath?: string; autoDemoPrompt?: string | null },
  ): Promise<ConversationApp> {
    const app = new ConversationApp(root, engine, {
      projectPath: options?.projectPath ?? "/tmp/demo-project",
      autoDemoPrompt: options?.autoDemoPrompt ?? null,
    });
    await app.mount();
    return app;
  }

  it("renders conversation as the primary surface with a usable prompt composer", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0 });
    await mount(engine);

    expect(root.querySelector('[data-testid="conversation-workspace"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="messages"]')).toBeTruthy();
    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement | null;
    const send = root.querySelector(
      '[data-testid="send"]',
    ) as HTMLButtonElement | null;
    expect(input).toBeTruthy();
    expect(send).toBeTruthy();
    expect(input!.disabled).toBe(false);
    expect(send!.disabled).toBe(false);
  });

  it("streams assistant text incrementally while remaining readable", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 25, richTurn: false });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;

    input.value = "Stream please";
    send.click();

    await flush(35);
    const mid = textOf(root.querySelector('[data-testid="messages"]'));
    expect(mid.length).toBeGreaterThan(0);
    // User prompt visible while assistant may still be streaming
    expect(mid).toMatch(/Stream please/);

    await flush(200);
    const final = textOf(root.querySelector('[data-testid="messages"]'));
    expect(final).toMatch(/AgentEnginePort|fake/i);
    const assistant = root.querySelector(
      '[data-testid="messages"] [data-role="assistant"]',
    );
    expect(assistant).toBeTruthy();
    expect(assistant!.classList.contains("streaming")).toBe(false);
  });

  it("presents plans, thoughts, tool activity, usage, and final responses distinctly", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0, richTurn: true });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "Explore the project";
    send.click();
    await flush(50);

    // Final assistant answer
    const assistant = root.querySelector('[data-role="assistant"]');
    expect(assistant).toBeTruthy();
    expect(textOf(assistant)).toMatch(/fake|AgentEnginePort|Explore/i);

    // Thoughts are distinct from final answer
    const thought = root.querySelector('[data-testid="thought-panel"]');
    expect(thought).toBeTruthy();
    expect(textOf(thought)).toMatch(/thinking|plan|read/i);

    // Plan panel
    const plan = root.querySelector('[data-testid="plan-panel"]');
    expect(plan).toBeTruthy();
    expect(textOf(plan)).toMatch(/Inspect|Summarize|Respond/i);

    // Tool activity
    const tools = root.querySelector('[data-testid="tool-panel"]');
    expect(tools).toBeTruthy();
    expect(textOf(tools)).toMatch(/read|list|file/i);

    // Usage
    const usage = root.querySelector('[data-testid="usage-panel"]');
    expect(usage).toBeTruthy();
    expect(textOf(usage)).toMatch(/\d+/);
  });

  it("shows turn completion stop reasons and distinguishes cancellation from success", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0, richTurn: false });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "finish cleanly";
    send.click();
    await flush(30);

    const turnStatus = root.querySelector('[data-testid="turn-status"]');
    expect(turnStatus).toBeTruthy();
    expect(textOf(turnStatus)).toMatch(/end_turn|completed|success/i);
    expect(textOf(turnStatus)).not.toMatch(/cancell/i);

    // Cancel path: longer stream
    const engine2 = new FakeAgentEngine({ streamDelayMs: 40, richTurn: false });
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
    await mount(engine2);

    const input2 = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send2 = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    const stop = root.querySelector('[data-testid="stop"]') as HTMLButtonElement;

    input2.value = "long running cancel me";
    send2.click();
    await flush(20);
    expect(stop.disabled).toBe(false);
    stop.click();
    await flush(120);

    const cancelled = root.querySelector('[data-testid="turn-status"]');
    expect(textOf(cancelled)).toMatch(/cancell/i);
    expect(textOf(cancelled)).not.toMatch(/end_turn|success/i);
  });

  it("shows recoverable engine errors with actionable recovery controls", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0, faultOnPrompt: true });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "this will fault";
    send.click();
    await flush(20);

    const recovery = root.querySelector('[data-testid="error-recovery"]');
    expect(recovery).toBeTruthy();
    expect(textOf(recovery)).toMatch(/fake_fault|fault/i);

    expect(root.querySelector('[data-testid="recover-reset-session"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="recover-retry-engine"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="recover-cli-fallback"]')).toBeTruthy();

    // Reset Session restores a usable session
    const reset = root.querySelector(
      '[data-testid="recover-reset-session"]',
    ) as HTMLButtonElement;
    reset.click();
    await flush(20);

    const status = textOf(root.querySelector('[data-testid="session-status"]'));
    expect(status).toMatch(/idle/i);
    expect(
      root.querySelector('[data-testid="error-recovery"]')?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("submits composer text through the engine and clears the input", async () => {
    const engine = new FakeAgentEngine({ streamDelayMs: 0, richTurn: false });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "  Hello workspace  ";
    send.click();
    await flush(30);

    expect(input.value).toBe("");
    expect(textOf(root.querySelector('[data-testid="messages"]'))).toMatch(
      /Hello workspace/,
    );
    expect(engine.getSnapshot()?.messages.some((m) => m.role === "user")).toBe(
      true,
    );
  });

  it("prompts for project-local commands and shows Activity panel output after approve", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 0,
      richTurn: false,
      commandTurn: true,
    });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "run echo please";
    send.click();
    await flush(30);

    // Approval required before execution
    const approval = root.querySelector('[data-testid="approval-panel"]');
    expect(approval).toBeTruthy();
    expect(approval!.classList.contains("hidden")).toBe(false);
    expect(textOf(approval)).toMatch(/command|echo|SPIKE/i);

    // Conversation still shows the user prompt (state preserved)
    expect(textOf(root.querySelector('[data-testid="messages"]'))).toMatch(
      /run echo please/,
    );

    const allow = root.querySelector(
      '[data-testid="approval-allow"]',
    ) as HTMLButtonElement;
    expect(allow).toBeTruthy();
    allow.click();
    await flush(40);

    const activity = root.querySelector('[data-testid="activity-panel"]');
    expect(activity).toBeTruthy();
    expect(activity!.classList.contains("hidden")).toBe(false);
    expect(textOf(root.querySelector('[data-testid="activity-command"]'))).toMatch(
      /echo|SPIKE_TERM_OK/i,
    );
    expect(textOf(root.querySelector('[data-testid="activity-output"]'))).toMatch(
      /SPIKE_TERM_OK/,
    );
    expect(textOf(root.querySelector('[data-testid="activity-exit"]'))).toMatch(
      /0/,
    );

    // Output remains after turn completes
    await flush(40);
    expect(textOf(root.querySelector('[data-testid="activity-output"]'))).toMatch(
      /SPIKE_TERM_OK/,
    );
    expect(engine.getSnapshot()?.state).toBe("idle");
  });

  it("allows denying a command without losing conversation state", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 0,
      richTurn: false,
      commandTurn: true,
    });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "maybe run something dangerous";
    send.click();
    await flush(30);

    const deny = root.querySelector(
      '[data-testid="approval-deny"]',
    ) as HTMLButtonElement;
    deny.click();
    await flush(50);

    expect(textOf(root.querySelector('[data-testid="messages"]'))).toMatch(
      /maybe run something dangerous/,
    );
    // No command output after deny
    const activity = root.querySelector('[data-testid="activity-panel"]');
    expect(
      !activity || activity.classList.contains("hidden"),
    ).toBe(true);
  });

  it("shows nonzero command failures in the Activity panel", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 0,
      richTurn: false,
      commandTurn: true,
      commandFail: true,
    });
    await mount(engine);

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "run failing command";
    send.click();
    await flush(20);
    (root.querySelector('[data-testid="approval-allow"]') as HTMLButtonElement).click();
    await flush(40);

    const cmd = root.querySelector('[data-testid="activity-command"]');
    expect(cmd?.classList.contains("failed")).toBe(true);
    expect(textOf(root.querySelector('[data-testid="activity-exit"]'))).toMatch(
      /1/,
    );
    expect(textOf(root.querySelector('[data-testid="activity-output"]'))).toMatch(
      /fail/i,
    );
  });
});
