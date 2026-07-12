/**
 * Minimal conversation workspace.
 * UI talks only to AgentEnginePort and renders SessionSnapshot projections.
 */

import type { AgentEnginePort } from "./engine";
import { FakeAgentEngine } from "./engine";
import type { Message, SessionSnapshot } from "./engine/types";

const PROJECT_PATH = "/tmp/grok-gui-demo-project";

function textFromMessage(message: Message): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class ConversationApp {
  private engine: AgentEnginePort;
  private root: HTMLElement;
  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private engineHealthEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private emergencyBtn!: HTMLButtonElement;
  private yoloBtn!: HTMLButtonElement;

  constructor(root: HTMLElement, engine: AgentEnginePort) {
    this.root = root;
    this.engine = engine;
  }

  async mount(): Promise<void> {
    this.root.innerHTML = `
      <div class="workspace" data-testid="conversation-workspace">
        <header class="workspace-header">
          <div>
            <h1>Grok GUI</h1>
            <p class="subtitle">Conversation workspace · AgentEnginePort seam</p>
          </div>
          <div class="header-meta">
            <span id="session-status" class="status-pill" data-testid="session-status">starting…</span>
            <span id="engine-health" class="engine-health" data-testid="engine-health" title="Engine version / protocol">engine —</span>
            <button type="button" id="yolo-btn" class="btn ghost" title="Toggle YOLO for this Session">YOLO off</button>
          </div>
        </header>

        <section id="error-banner" class="error-banner hidden" role="alert"></section>

        <section id="messages" class="messages" aria-live="polite" data-testid="messages"></section>

        <footer class="composer">
          <textarea
            id="prompt-input"
            rows="3"
            placeholder="Describe a coding task…"
            data-testid="prompt-input"
          ></textarea>
          <div class="composer-actions">
            <button type="button" id="emergency-btn" class="btn danger" data-testid="emergency-stop">Emergency Stop</button>
            <button type="button" id="stop-btn" class="btn secondary" data-testid="stop" disabled>Stop</button>
            <button type="button" id="send-btn" class="btn primary" data-testid="send">Send</button>
          </div>
        </footer>
      </div>
    `;

    this.messagesEl = this.must("#messages");
    this.statusEl = this.must("#session-status");
    this.engineHealthEl = this.must("#engine-health");
    this.errorEl = this.must("#error-banner");
    this.inputEl = this.must("#prompt-input") as HTMLTextAreaElement;
    this.sendBtn = this.must("#send-btn") as HTMLButtonElement;
    this.stopBtn = this.must("#stop-btn") as HTMLButtonElement;
    this.emergencyBtn = this.must("#emergency-btn") as HTMLButtonElement;
    this.yoloBtn = this.must("#yolo-btn") as HTMLButtonElement;

    this.sendBtn.addEventListener("click", () => void this.onSend());
    this.stopBtn.addEventListener("click", () => void this.onStop());
    this.emergencyBtn.addEventListener("click", () => void this.onEmergency());
    this.yoloBtn.addEventListener("click", () => void this.onYolo());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.onSend();
      }
    });

    this.engine.subscribeSnapshot?.((snap) => this.render(snap));

    await this.engine.start({ projectPath: PROJECT_PATH });
    await this.engine.createSession({ cwd: PROJECT_PATH });

    const snap = this.engine.getSnapshot();
    if (snap) this.render(snap);

    // Auto-run one demo turn so launch shows a live vertical slice
    await this.engine.sendPrompt(
      "Show me a demo conversation through AgentEnginePort.",
    );
  }

  private must(selector: string): HTMLElement {
    const el = this.root.querySelector(selector);
    if (!el) throw new Error(`Missing element ${selector}`);
    return el as HTMLElement;
  }

  private render(snap: SessionSnapshot): void {
    this.statusEl.textContent = snap.state;
    this.statusEl.dataset.state = snap.state;

    const version = snap.engineVersion ?? "unknown";
    const protocol =
      snap.protocolVersion != null ? `acp/${snap.protocolVersion}` : "acp/?";
    this.engineHealthEl.textContent = `${version} · ${protocol}`;
    this.engineHealthEl.dataset.engineVersion = version;

    if (snap.lastError) {
      this.errorEl.classList.remove("hidden");
      this.errorEl.textContent = `${snap.lastError.code}: ${snap.lastError.message}`;
    } else {
      this.errorEl.classList.add("hidden");
      this.errorEl.textContent = "";
    }

    this.yoloBtn.textContent = snap.yoloEnabled ? "YOLO on" : "YOLO off";
    this.yoloBtn.classList.toggle("active", snap.yoloEnabled);

    const busy =
      snap.state === "running" ||
      snap.state === "awaiting_approval" ||
      snap.state === "cancelling";
    const blocked =
      snap.state === "faulted" || snap.state === "disposed";

    this.sendBtn.disabled = busy || blocked;
    this.inputEl.disabled = blocked;
    this.stopBtn.disabled = !busy;
    this.emergencyBtn.disabled = snap.state === "disposed";
    this.yoloBtn.disabled = blocked;

    this.messagesEl.innerHTML = snap.messages
      .map((m) => {
        const role = escapeHtml(m.role);
        const body = escapeHtml(textFromMessage(m));
        const streaming = m.streaming ? " streaming" : "";
        return `
          <article class="message message-${role}${streaming}" data-role="${role}">
            <header class="message-role">${role}</header>
            <div class="message-body">${body}</div>
          </article>
        `;
      })
      .join("");

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async onSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    try {
      await this.engine.sendPrompt(text);
    } catch (err) {
      this.errorEl.classList.remove("hidden");
      this.errorEl.textContent =
        err instanceof Error ? err.message : String(err);
    }
  }

  private async onStop(): Promise<void> {
    await this.engine.cancel();
  }

  private async onEmergency(): Promise<void> {
    await this.engine.emergencyStop();
  }

  private async onYolo(): Promise<void> {
    const snap = this.engine.getSnapshot();
    if (!snap) return;
    await this.engine.setYolo(!snap.yoloEnabled);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const root = document.querySelector("#app");
  if (!(root instanceof HTMLElement)) {
    throw new Error("#app root missing");
  }

  // Foundation ticket: wire the fake engine. Real ACP adapter is a later ticket.
  const engine: AgentEnginePort = new FakeAgentEngine({ streamDelayMs: 45 });
  const app = new ConversationApp(root, engine);
  void app.mount().catch((err) => {
    root.innerHTML = `<pre class="boot-error">${escapeHtml(
      err instanceof Error ? err.stack ?? err.message : String(err),
    )}</pre>`;
  });
});
