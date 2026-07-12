/**
 * Conversation-first workspace shell.
 * UI depends only on AgentEnginePort + SessionSnapshot projections.
 */

import type { FileWriteHost } from "../edits";
import { formatChangeDiff, setChangeSelected } from "../edits";
import type { AgentEnginePort } from "../engine/port";
import type {
  FileChangeBatch,
  FileChangeRecord,
  Message,
  PlanEntry,
  SessionSnapshot,
  StopReason,
  ToolCallRecord,
} from "../engine/types";
import {
  applyBatch,
  deselectAllFiles,
  rejectBatch,
  selectAllFiles,
} from "./edit-review";

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
  /**
   * Host used to write approved file changes.
   * Required for Apply selected; reject works without it.
   */
  fileWriteHost?: FileWriteHost;
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
  private fileWriteHost: FileWriteHost | null;

  private messagesEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private engineHealthEl!: HTMLElement;
  private turnStatusEl!: HTMLElement;
  private thoughtPanelEl!: HTMLElement;
  private planPanelEl!: HTMLElement;
  private toolPanelEl!: HTMLElement;
  private usagePanelEl!: HTMLElement;
  private errorRecoveryEl!: HTMLElement;
  private errorDetailEl!: HTMLElement;
  private fileChangesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private emergencyBtn!: HTMLButtonElement;
  private yoloBtn!: HTMLButtonElement;
  private unsubSnapshot: (() => void) | null = null;
  /** Expanded change ids for full-diff review. */
  private expandedChanges = new Set<string>();
  private applying = false;

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
    this.fileWriteHost = options.fileWriteHost ?? null;
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

        <div id="turn-status" class="turn-status" data-testid="turn-status" aria-live="polite"></div>

        <section id="messages" class="messages" aria-live="polite" data-testid="messages"></section>

        <section
          id="file-changes"
          class="file-changes"
          data-testid="file-changes"
          aria-label="Proposed file changes"
        ></section>

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
    this.usagePanelEl = this.must("#usage-panel");
    this.errorRecoveryEl = this.must("#error-recovery");
    this.errorDetailEl = this.must("#error-detail");
    this.fileChangesEl = this.must("#file-changes");
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
    this.fileChangesEl.addEventListener("click", (e) =>
      void this.onFileChangesClick(e),
    );
    this.fileChangesEl.addEventListener("change", (e) =>
      void this.onFileChangesChange(e),
    );
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
    this.renderUsage(snap);
    this.renderMessages(snap.messages);
    this.renderFileChanges(snap.fileChangeBatches ?? []);
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

  private renderFileChanges(batches: FileChangeBatch[]): void {
    if (!batches.length) {
      this.fileChangesEl.innerHTML = "";
      this.fileChangesEl.classList.add("hidden");
      return;
    }
    this.fileChangesEl.classList.remove("hidden");
    this.fileChangesEl.innerHTML = batches
      .map((batch) => this.renderBatchCard(batch))
      .join("");
  }

  private renderBatchCard(batch: FileChangeBatch): string {
    const pending = batch.status === "pending";
    const rows = batch.changes
      .map((change) => this.renderChangeRow(batch.batchId, change, pending))
      .join("");
    const actions = pending
      ? `
        <div class="file-change-actions">
          <button type="button" class="btn ghost" data-testid="file-change-select-all" data-action="select-all" data-batch-id="${escapeHtml(batch.batchId)}">Select all</button>
          <button type="button" class="btn ghost" data-testid="file-change-deselect-all" data-action="deselect-all" data-batch-id="${escapeHtml(batch.batchId)}">Deselect all</button>
          <button type="button" class="btn secondary" data-testid="file-change-reject" data-action="reject-all" data-batch-id="${escapeHtml(batch.batchId)}">Reject all</button>
          <button type="button" class="btn primary" data-testid="file-change-apply" data-action="apply-selected" data-batch-id="${escapeHtml(batch.batchId)}" ${this.applying ? "disabled" : ""}>Apply selected</button>
        </div>
      `
      : `<div class="file-change-resolved-label">Review complete</div>`;

    return `
      <article
        class="file-change-batch"
        data-testid="file-change-batch"
        data-batch-id="${escapeHtml(batch.batchId)}"
        data-status="${escapeHtml(batch.status)}"
      >
        <header class="file-change-batch-header">
          <strong>${escapeHtml(batch.title)}</strong>
          <span class="file-change-batch-status" data-status="${escapeHtml(batch.status)}">${escapeHtml(batch.status)}</span>
        </header>
        <p class="file-change-hint">Review diffs, cherry-pick files, then apply only what you accept.</p>
        <ul class="file-change-list">${rows}</ul>
        ${actions}
      </article>
    `;
  }

  private renderChangeRow(
    batchId: string,
    change: FileChangeRecord,
    pending: boolean,
  ): string {
    const expanded = this.expandedChanges.has(change.changeId);
    const diffLines = formatChangeDiff(change);
    const inline = diffLines
      .slice(0, 8)
      .map((line) => {
        return `<div class="diff-line diff-${escapeHtml(line.type)}">${escapeHtml(line.text)}</div>`;
      })
      .join("");
    const full = expanded
      ? `<pre class="file-change-full-diff" data-testid="file-change-full-diff">${escapeHtml(
          diffLines.map((l) => l.text).join("\n"),
        )}</pre>`
      : "";
    const checkbox =
      pending && !change.malformed
        ? `<input
            type="checkbox"
            data-testid="file-change-select"
            data-action="toggle-select"
            data-batch-id="${escapeHtml(batchId)}"
            data-change-id="${escapeHtml(change.changeId)}"
            ${change.selected ? "checked" : ""}
            aria-label="Select ${escapeHtml(change.path)}"
          />`
        : `<span class="file-change-checkbox-spacer" aria-hidden="true"></span>`;

    const dest =
      change.kind === "move" && change.diff?.destinationPath
        ? ` → ${escapeHtml(change.diff.destinationPath)}`
        : "";
    const err = change.errorMessage
      ? `<div class="file-change-error">${escapeHtml(change.errorMessage)}</div>`
      : "";
    const malformed = change.malformed
      ? `<div class="file-change-error">${escapeHtml(change.malformedReason ?? "Malformed proposal")}</div>`
      : "";

    return `
      <li
        class="file-change-row"
        data-testid="file-change-row"
        data-change-id="${escapeHtml(change.changeId)}"
        data-status="${escapeHtml(change.status)}"
        data-kind="${escapeHtml(change.kind)}"
      >
        <div class="file-change-row-main">
          ${checkbox}
          <span class="file-change-kind">${escapeHtml(change.kind)}</span>
          <span class="file-change-path">${escapeHtml(change.path)}${dest}</span>
          <span class="file-change-status" data-status="${escapeHtml(change.status)}">${escapeHtml(change.status)}</span>
          <button
            type="button"
            class="btn ghost file-change-expand-btn"
            data-testid="file-change-expand"
            data-action="toggle-expand"
            data-change-id="${escapeHtml(change.changeId)}"
          >${expanded ? "Collapse" : "Expand"}</button>
        </div>
        ${malformed}
        ${err}
        <div class="file-change-inline-diff" data-testid="file-change-inline-diff">${inline}</div>
        ${full}
      </li>
    `;
  }

  private findBatch(batchId: string): FileChangeBatch | null {
    const snap = this.engine.getSnapshot();
    return snap?.fileChangeBatches.find((b) => b.batchId === batchId) ?? null;
  }

  private async publishBatchUpdate(batch: FileChangeBatch): Promise<void> {
    if (!this.engine.updateFileChangeBatch) {
      throw new Error("Engine does not support file-change batch updates");
    }
    await this.engine.updateFileChangeBatch(batch);
  }

  private async onFileChangesChange(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.dataset.action !== "toggle-select") return;
    const batchId = target.dataset.batchId;
    const changeId = target.dataset.changeId;
    if (!batchId || !changeId) return;
    const batch = this.findBatch(batchId);
    if (!batch || batch.status !== "pending") return;
    await this.publishBatchUpdate(
      setChangeSelected(batch, changeId, target.checked),
    );
  }

  private async onFileChangesClick(event: Event): Promise<void> {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const actionEl = target.closest("[data-action]") as HTMLElement | null;
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (!action) return;

    if (action === "toggle-expand") {
      const changeId = actionEl.dataset.changeId;
      if (!changeId) return;
      if (this.expandedChanges.has(changeId)) {
        this.expandedChanges.delete(changeId);
      } else {
        this.expandedChanges.add(changeId);
      }
      const snap = this.engine.getSnapshot();
      if (snap) this.renderFileChanges(snap.fileChangeBatches ?? []);
      return;
    }

    const batchId = actionEl.dataset.batchId;
    if (!batchId) return;
    const batch = this.findBatch(batchId);
    if (!batch || batch.status !== "pending") return;

    if (action === "select-all") {
      await this.publishBatchUpdate(selectAllFiles(batch));
      return;
    }
    if (action === "deselect-all") {
      await this.publishBatchUpdate(deselectAllFiles(batch));
      return;
    }
    if (action === "reject-all") {
      const rejected = rejectBatch(batch);
      await this.publishBatchUpdate(rejected);
      if (batch.requestId) {
        await this.engine.respondToApproval(batch.requestId, {
          outcome: "selected",
          optionId: "reject-once",
        });
      }
      return;
    }
    if (action === "apply-selected") {
      if (!this.fileWriteHost) {
        this.errorRecoveryEl.classList.remove("hidden");
        this.errorDetailEl.textContent =
          "No file write host configured; cannot apply edits.";
        return;
      }
      this.applying = true;
      try {
        const applied = await applyBatch(batch, this.fileWriteHost);
        await this.publishBatchUpdate(applied);
        if (batch.requestId) {
          await this.engine.respondToApproval(batch.requestId, {
            outcome: "selected",
            optionId: "allow-once",
          });
        }
      } catch (err) {
        this.errorRecoveryEl.classList.remove("hidden");
        this.errorDetailEl.textContent =
          err instanceof Error ? err.message : String(err);
      } finally {
        this.applying = false;
        const snap = this.engine.getSnapshot();
        if (snap) this.render(snap);
      }
    }
  }

  private renderComposerState(snap: SessionSnapshot): void {
    this.yoloBtn.textContent = snap.yoloEnabled ? "YOLO on" : "YOLO off";
    this.yoloBtn.classList.toggle("active", snap.yoloEnabled);

    const blocked = snap.state === "faulted" || snap.state === "disposed";
    const turnOpen =
      snap.state === "running" || snap.state === "cancelling";
    // Allow Send after a turn settles even if a file batch is still pending review.
    this.sendBtn.disabled = turnOpen || blocked || this.applying;
    this.inputEl.disabled = blocked;
    this.stopBtn.disabled = !(
      snap.state === "running" ||
      snap.state === "awaiting_approval" ||
      snap.state === "cancelling"
    );
    this.emergencyBtn.disabled = snap.state === "disposed";
    this.yoloBtn.disabled = blocked;
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
