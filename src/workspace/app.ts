/**
 * Conversation-first workspace shell.
 * UI depends only on AgentEnginePort + SessionSnapshot projections.
 */

import type { AgentEnginePort } from "../engine/port";
import type {
  ApprovalOutcome,
  Message,
  PlanEntry,
  SessionSnapshot,
  StopReason,
  TerminalRecord,
  ToolCallRecord,
} from "../engine/types";

export type ConversationAppOptions = {
  /** Project folder for start / createSession. */
  projectPath?: string;
  /**
   * When set, automatically send this prompt after session create.
   * Pass null/undefined to skip (preferred for tests).
   */
  autoDemoPrompt?: string | null;
  /** Header subtitle; defaults to the conversation-workspace blurb. */
  subtitle?: string;
};

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

function stopReasonLabel(reason: StopReason | undefined): string {
  if (!reason) return "";
  switch (reason) {
    case "end_turn":
      return "Turn completed · success (end_turn)";
    case "cancelled":
      return "Turn cancelled · interrupted by user";
    case "max_tokens":
      return "Turn stopped · max_tokens";
    case "max_turn_requests":
      return "Turn stopped · max_turn_requests";
    case "refusal":
      return "Turn stopped · refusal";
    default:
      return `Turn stopped · ${reason}`;
  }
}

/**
 * Live conversation workspace driven by a real AgentEnginePort.
 * Renders SessionSnapshot: stream, plans, thoughts, tools, usage,
 * stop reasons, and recoverable errors — never TUI or ACP wire.
 */
export class ConversationApp {
  private engine: AgentEnginePort;
  private root: HTMLElement;
  private projectPath: string;
  private autoDemoPrompt: string | null;
  private subtitle: string;

  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private engineHealthEl!: HTMLElement;
  private turnStatusEl!: HTMLElement;
  private thoughtPanelEl!: HTMLElement;
  private planPanelEl!: HTMLElement;
  private toolPanelEl!: HTMLElement;
  private activityPanelEl!: HTMLElement;
  private approvalPanelEl!: HTMLElement;
  private usagePanelEl!: HTMLElement;
  private errorRecoveryEl!: HTMLElement;
  private errorDetailEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private emergencyBtn!: HTMLButtonElement;
  private yoloBtn!: HTMLButtonElement;
  private unsubSnapshot: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    engine: AgentEnginePort,
    options: ConversationAppOptions = {},
  ) {
    this.root = root;
    this.engine = engine;
    this.projectPath = options.projectPath ?? "/tmp/grok-gui-demo-project";
    this.autoDemoPrompt = options.autoDemoPrompt ?? null;
    this.subtitle =
      options.subtitle ?? "Conversation workspace · AgentEnginePort seam";
  }

  async mount(): Promise<void> {
    this.root.innerHTML = `
      <div class="workspace" data-testid="conversation-workspace">
        <header class="workspace-header">
          <div>
            <h1>Grok GUI</h1>
            <p class="subtitle" data-testid="project-path-label">${escapeHtml(this.subtitle)}</p>
          </div>
          <div class="header-meta">
            <span id="session-status" class="status-pill" data-testid="session-status">starting…</span>
            <span id="engine-health" class="engine-health" data-testid="engine-health" title="Engine version / protocol">engine —</span>
            <button type="button" id="yolo-btn" class="btn ghost" title="Toggle YOLO for this Session">YOLO off</button>
          </div>
        </header>

        <section
          id="error-recovery"
          class="error-recovery hidden"
          role="alert"
          data-testid="error-recovery"
        >
          <div class="error-recovery-body">
            <strong>Engine error</strong>
            <p id="error-detail" class="error-detail"></p>
            <p class="error-hint">Choose a recovery action. Nothing was rolled back on disk.</p>
          </div>
          <div class="error-recovery-actions">
            <button type="button" class="btn secondary" data-testid="recover-retry-engine" id="recover-retry">
              Retry engine
            </button>
            <button type="button" class="btn primary" data-testid="recover-reset-session" id="recover-reset">
              Reset Session
            </button>
            <button type="button" class="btn ghost" data-testid="recover-cli-fallback" id="recover-cli">
              CLI fallback
            </button>
          </div>
        </section>

        <section class="meta-panels" aria-label="Turn context">
          <div id="plan-panel" class="meta-panel hidden" data-testid="plan-panel">
            <header class="meta-panel-title">Plan</header>
            <ul class="plan-list"></ul>
          </div>
          <div id="thought-panel" class="meta-panel hidden" data-testid="thought-panel">
            <header class="meta-panel-title">Thoughts</header>
            <div class="thought-body"></div>
          </div>
          <div id="tool-panel" class="meta-panel hidden" data-testid="tool-panel">
            <header class="meta-panel-title">Tool activity</header>
            <ul class="tool-list"></ul>
          </div>
          <div id="usage-panel" class="meta-panel hidden" data-testid="usage-panel">
            <header class="meta-panel-title">Usage</header>
            <div class="usage-body"></div>
          </div>
        </section>

        <section
          id="approval-panel"
          class="approval-panel hidden"
          data-testid="approval-panel"
          aria-label="Pending approvals"
        ></section>

        <section
          id="activity-panel"
          class="activity-panel hidden"
          data-testid="activity-panel"
          aria-label="Activity panel"
        >
          <header class="activity-panel-title">Activity</header>
          <div class="activity-body" data-testid="activity-body"></div>
        </section>

        <div id="turn-status" class="turn-status" data-testid="turn-status" aria-live="polite"></div>

        <section id="messages" class="messages" aria-live="polite" data-testid="messages"></section>

        <footer class="composer">
          <textarea
            id="prompt-input"
            rows="3"
            placeholder="Describe a coding task…"
            data-testid="prompt-input"
            aria-label="Prompt"
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
    this.turnStatusEl = this.must("#turn-status");
    this.thoughtPanelEl = this.must("#thought-panel");
    this.planPanelEl = this.must("#plan-panel");
    this.toolPanelEl = this.must("#tool-panel");
    this.activityPanelEl = this.must("#activity-panel");
    this.approvalPanelEl = this.must("#approval-panel");
    this.usagePanelEl = this.must("#usage-panel");
    this.errorRecoveryEl = this.must("#error-recovery");
    this.errorDetailEl = this.must("#error-detail");
    this.inputEl = this.must("#prompt-input") as HTMLTextAreaElement;
    this.sendBtn = this.must("#send-btn") as HTMLButtonElement;
    this.stopBtn = this.must("#stop-btn") as HTMLButtonElement;
    this.emergencyBtn = this.must("#emergency-btn") as HTMLButtonElement;
    this.yoloBtn = this.must("#yolo-btn") as HTMLButtonElement;

    this.sendBtn.addEventListener("click", () => void this.onSend());
    this.stopBtn.addEventListener("click", () => void this.onStop());
    this.emergencyBtn.addEventListener("click", () => void this.onEmergency());
    this.yoloBtn.addEventListener("click", () => void this.onYolo());
    this.must("#recover-reset").addEventListener("click", () =>
      void this.onResetSession(),
    );
    this.must("#recover-retry").addEventListener("click", () =>
      void this.onRetryEngine(),
    );
    this.must("#recover-cli").addEventListener("click", () => this.onCliFallback());
    this.approvalPanelEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest("[data-approval-action]") as HTMLElement | null;
      if (!btn) return;
      const requestId = btn.dataset.requestId;
      const optionId = btn.dataset.optionId;
      const action = btn.dataset.approvalAction;
      if (!requestId) return;
      if (action === "reject") {
        void this.onApproval(requestId, {
          outcome: "selected",
          optionId: optionId ?? "reject-once",
        });
        return;
      }
      if (action === "allow" && optionId) {
        void this.onApproval(requestId, {
          outcome: "selected",
          optionId,
        });
      }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.onSend();
      }
    });

    this.unsubSnapshot =
      this.engine.subscribeSnapshot?.((snap) => this.render(snap)) ?? null;

    await this.engine.start({ projectPath: this.projectPath });
    await this.engine.createSession({ cwd: this.projectPath });

    const snap = this.engine.getSnapshot();
    if (snap) this.render(snap);

    if (this.autoDemoPrompt) {
      await this.engine.sendPrompt(this.autoDemoPrompt);
    }
  }

  /** Tear down DOM listeners owned by this app (engine left to caller). */
  unmount(): void {
    this.unsubSnapshot?.();
    this.unsubSnapshot = null;
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

    this.renderErrorRecovery(snap);
    this.renderTurnStatus(snap);
    this.renderPlan(snap.plan);
    this.renderThoughts(snap.messages);
    this.renderTools(snap.tools);
    this.renderApprovals(snap);
    this.renderActivity(snap);
    this.renderUsage(snap);
    this.renderMessages(snap.messages);
    this.renderComposerState(snap);
  }

  private renderErrorRecovery(snap: SessionSnapshot): void {
    if (snap.lastError) {
      this.errorRecoveryEl.classList.remove("hidden");
      const recoverability = snap.lastError.recoverable
        ? "recoverable"
        : "not recoverable";
      this.errorDetailEl.textContent = `${snap.lastError.code}: ${snap.lastError.message} (${recoverability})`;
    } else {
      this.errorRecoveryEl.classList.add("hidden");
      this.errorDetailEl.textContent = "";
    }
  }

  private renderTurnStatus(snap: SessionSnapshot): void {
    const reason = snap.turn?.stopReason;
    if (snap.state === "running") {
      this.turnStatusEl.textContent = "Turn in progress…";
      this.turnStatusEl.dataset.stopReason = "";
      return;
    }
    if (snap.state === "cancelling") {
      this.turnStatusEl.textContent = "Cancelling turn…";
      this.turnStatusEl.dataset.stopReason = "cancelling";
      return;
    }
    if (reason) {
      this.turnStatusEl.textContent = stopReasonLabel(reason);
      this.turnStatusEl.dataset.stopReason = reason;
      return;
    }
    this.turnStatusEl.textContent = "";
    this.turnStatusEl.dataset.stopReason = "";
  }

  private renderPlan(plan: PlanEntry[] | undefined): void {
    const list = this.planPanelEl.querySelector(".plan-list");
    if (!list) return;
    if (!plan || plan.length === 0) {
      this.planPanelEl.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    this.planPanelEl.classList.remove("hidden");
    list.innerHTML = plan
      .map((entry) => {
        const status = entry.status ?? "pending";
        const priority = entry.priority ? ` · ${entry.priority}` : "";
        return `<li data-status="${escapeHtml(status)}"><span class="plan-status">${escapeHtml(status)}</span> ${escapeHtml(entry.content)}${escapeHtml(priority)}</li>`;
      })
      .join("");
  }

  private renderThoughts(messages: Message[]): void {
    const body = this.thoughtPanelEl.querySelector(".thought-body");
    if (!body) return;
    const thoughts = messages.filter((m) => m.role === "thought");
    if (thoughts.length === 0) {
      this.thoughtPanelEl.classList.add("hidden");
      body.innerHTML = "";
      return;
    }
    this.thoughtPanelEl.classList.remove("hidden");
    body.innerHTML = thoughts
      .map((m) => {
        const streaming = m.streaming ? " streaming" : "";
        return `<div class="thought-chunk${streaming}" data-role="thought">${escapeHtml(textFromMessage(m))}</div>`;
      })
      .join("");
  }

  private renderTools(tools: Record<string, ToolCallRecord>): void {
    const list = this.toolPanelEl.querySelector(".tool-list");
    if (!list) return;
    const records = Object.values(tools);
    if (records.length === 0) {
      this.toolPanelEl.classList.add("hidden");
      list.innerHTML = "";
      return;
    }
    this.toolPanelEl.classList.remove("hidden");
    list.innerHTML = records
      .map((t) => {
        const locs =
          t.locations?.map((l) => l.path).join(", ") ?? "";
        const locBit = locs ? ` · ${escapeHtml(locs)}` : "";
        return `<li data-status="${escapeHtml(t.status)}" data-kind="${escapeHtml(t.kind)}"><span class="tool-kind">${escapeHtml(t.kind)}</span> ${escapeHtml(t.title)} <span class="tool-status">${escapeHtml(t.status)}</span>${locBit}</li>`;
      })
      .join("");
  }

  private renderApprovals(snap: SessionSnapshot): void {
    const pending = snap.pendingApprovals;
    if (!pending.length) {
      this.approvalPanelEl.classList.add("hidden");
      this.approvalPanelEl.innerHTML = "";
      return;
    }
    this.approvalPanelEl.classList.remove("hidden");
    this.approvalPanelEl.innerHTML = pending
      .map((a) => {
        const allow = a.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
        const reject = a.options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");
        const title = a.title ?? `Approve tool ${a.toolCallId}`;
        const kind = a.kind ? ` · ${a.kind}` : "";
        return `
          <article class="approval-card" data-testid="approval-card" data-request-id="${escapeHtml(a.requestId)}">
            <header class="approval-title">Approval required${escapeHtml(kind)}</header>
            <p class="approval-detail">${escapeHtml(title)}</p>
            <div class="approval-actions">
              ${
                allow
                  ? `<button type="button" class="btn primary" data-approval-action="allow" data-request-id="${escapeHtml(a.requestId)}" data-option-id="${escapeHtml(allow.optionId)}" data-testid="approval-allow">Allow</button>`
                  : ""
              }
              ${
                reject
                  ? `<button type="button" class="btn secondary" data-approval-action="reject" data-request-id="${escapeHtml(a.requestId)}" data-option-id="${escapeHtml(reject.optionId)}" data-testid="approval-deny">Deny</button>`
                  : ""
              }
            </div>
          </article>
        `;
      })
      .join("");
  }

  private renderActivity(snap: SessionSnapshot): void {
    const body = this.activityPanelEl.querySelector(".activity-body");
    if (!body) return;
    const terminals = Object.values(snap.terminals);
    if (terminals.length === 0) {
      this.activityPanelEl.classList.add("hidden");
      body.innerHTML = "";
      return;
    }
    this.activityPanelEl.classList.remove("hidden");
    body.innerHTML = terminals.map((t) => this.renderTerminalRow(t)).join("");
  }

  private renderTerminalRow(t: TerminalRecord): string {
    const args = t.args?.length ? ` ${t.args.map(escapeHtml).join(" ")}` : "";
    const cwd = t.cwd ? escapeHtml(t.cwd) : "—";
    const exit =
      t.exitCode !== undefined && t.exitCode !== null
        ? String(t.exitCode)
        : t.signal
          ? `signal ${escapeHtml(t.signal)}`
          : t.status === "running"
            ? "running"
            : "—";
    const failed =
      (typeof t.exitCode === "number" && t.exitCode !== 0) ||
      t.status === "killed";
    return `
      <article
        class="activity-command${failed ? " failed" : ""}"
        data-testid="activity-command"
        data-terminal-id="${escapeHtml(t.terminalId)}"
        data-status="${escapeHtml(t.status)}"
      >
        <header class="activity-command-meta">
          <span class="activity-label">command</span>
          <code class="activity-cmd">${escapeHtml(t.command)}${args}</code>
        </header>
        <div class="activity-command-scope"><span class="activity-label">cwd</span> ${cwd}</div>
        <div class="activity-command-exit"><span class="activity-label">exit</span> <span data-testid="activity-exit">${escapeHtml(exit)}</span> · ${escapeHtml(t.status)}</div>
        <pre class="activity-command-output" data-testid="activity-output">${escapeHtml(t.output || "(no output yet)")}</pre>
      </article>
    `;
  }

  private renderUsage(snap: SessionSnapshot): void {
    const body = this.usagePanelEl.querySelector(".usage-body");
    if (!body) return;
    if (!snap.usage) {
      this.usagePanelEl.classList.add("hidden");
      body.innerHTML = "";
      return;
    }
    this.usagePanelEl.classList.remove("hidden");
    const { used, size, cost } = snap.usage;
    const costBit = cost
      ? ` · ${cost.amount} ${cost.currency}`
      : "";
    body.textContent = `${used} / ${size} tokens${costBit}`;
  }

  private renderMessages(messages: Message[]): void {
    // Conversation stream: user + assistant (+ system). Thoughts live in thought-panel.
    const stream = messages.filter((m) => m.role !== "thought");
    this.messagesEl.innerHTML = stream
      .map((m) => {
        const role = escapeHtml(m.role);
        const body = escapeHtml(textFromMessage(m));
        const streaming = m.streaming ? " streaming" : "";
        return `
          <article class="message message-${role}${streaming}" data-role="${role}" data-message-id="${escapeHtml(m.messageId)}">
            <header class="message-role">${role}</header>
            <div class="message-body">${body}</div>
          </article>
        `;
      })
      .join("");

    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private renderComposerState(snap: SessionSnapshot): void {
    this.yoloBtn.textContent = snap.yoloEnabled ? "YOLO on" : "YOLO off";
    this.yoloBtn.classList.toggle("active", snap.yoloEnabled);

    const busy =
      snap.state === "running" ||
      snap.state === "awaiting_approval" ||
      snap.state === "cancelling";
    const blocked = snap.state === "faulted" || snap.state === "disposed";

    this.sendBtn.disabled = busy || blocked;
    this.inputEl.disabled = blocked;
    this.stopBtn.disabled = !busy;
    this.emergencyBtn.disabled = snap.state === "disposed";
    this.yoloBtn.disabled = blocked;
  }

  private async onApproval(
    requestId: string,
    decision: ApprovalOutcome,
  ): Promise<void> {
    try {
      await this.engine.respondToApproval(requestId, decision);
    } catch (err) {
      this.errorRecoveryEl.classList.remove("hidden");
      this.errorDetailEl.textContent =
        err instanceof Error ? err.message : String(err);
    }
  }

  private async onSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    try {
      await this.engine.sendPrompt(text);
    } catch (err) {
      this.errorRecoveryEl.classList.remove("hidden");
      this.errorDetailEl.textContent =
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

  private async onResetSession(): Promise<void> {
    try {
      await this.engine.createSession({ cwd: this.projectPath });
      const snap = this.engine.getSnapshot();
      if (snap) this.render(snap);
    } catch (err) {
      this.errorRecoveryEl.classList.remove("hidden");
      this.errorDetailEl.textContent =
        err instanceof Error ? err.message : String(err);
    }
  }

  private async onRetryEngine(): Promise<void> {
    try {
      // Soft recovery: open a fresh Session on the same port when possible.
      // Full process reacquire is engine-specific; createSession clears fault state.
      await this.engine.createSession({ cwd: this.projectPath });
      const snap = this.engine.getSnapshot();
      if (snap) this.render(snap);
    } catch (err) {
      this.errorRecoveryEl.classList.remove("hidden");
      this.errorDetailEl.textContent =
        err instanceof Error ? err.message : String(err);
    }
  }

  private onCliFallback(): void {
    this.errorDetailEl.textContent =
      "Use the Grok CLI fallback for repair: run `grok` in a terminal for this Project. The GUI did not roll back files.";
    this.errorRecoveryEl.classList.remove("hidden");
  }
}
