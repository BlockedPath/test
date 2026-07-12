/**
 * Fake AgentEnginePort used for UI development and seam tests.
 * Emits normalized GuiEvents only — never ACP wire messages.
 */

import type { AgentEnginePort, GuiEventListener, SnapshotListener } from "./port";
import { createEmptySnapshot, reduce } from "./reducer";
import type {
  ApprovalOutcome,
  ContentBlock,
  CreateSessionOptions,
  GuiEvent,
  SessionSnapshot,
  StartOptions,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function asContentBlocks(content: ContentBlock[] | string): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

export type FakeEngineOptions = {
  /** Delay between streamed assistant chunks (ms). Default 40. */
  streamDelayMs?: number;
  /**
   * When true, sendPrompt faults the engine instead of streaming a demo turn.
   * Useful for faulted-state demos/tests.
   */
  faultOnPrompt?: boolean;
};

/**
 * In-process fake that drives a demo conversation through GuiEvents
 * into a SessionSnapshot via the shared reducer.
 */
export class FakeAgentEngine implements AgentEnginePort {
  private listeners = new Set<GuiEventListener>();
  private snapshotListeners = new Set<SnapshotListener>();
  private snapshot: SessionSnapshot | null = null;
  private eventSeq = 0;
  private projectPath = "";
  private sessionId = "";
  private started = false;
  private authenticated = false;
  private disposed = false;
  private turnCounter = 0;
  private openTurnId: string | null = null;
  private cancelRequested = false;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private streamWaiters: Array<() => void> = [];
  private readonly streamDelayMs: number;
  private readonly faultOnPrompt: boolean;

  constructor(options: FakeEngineOptions = {}) {
    this.streamDelayMs = options.streamDelayMs ?? 40;
    this.faultOnPrompt = options.faultOnPrompt ?? false;
  }

  private nextEventId(): string {
    this.eventSeq += 1;
    return `fake-evt-${this.eventSeq}`;
  }

  private emit(partial: Omit<GuiEvent, "eventId" | "observedAt"> & {
    type: GuiEvent["type"];
  }): void {
    if (this.disposed && partial.type !== "session.disposed") {
      return;
    }
    const event = {
      ...partial,
      eventId: this.nextEventId(),
      observedAt: nowIso(),
    } as GuiEvent;

    if (this.snapshot) {
      this.snapshot = reduce(this.snapshot, event);
      for (const l of this.snapshotListeners) l(this.snapshot);
    }

    for (const l of this.listeners) l(event);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers = this.timers.filter((x) => x !== t);
        this.streamWaiters = this.streamWaiters.filter((w) => w !== resolve);
        resolve();
      }, ms);
      this.timers.push(t);
      this.streamWaiters.push(resolve);
    });
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const waiters = this.streamWaiters;
    this.streamWaiters = [];
    // Resolve so in-flight streamDemoTurn does not hang forever.
    for (const resolve of waiters) resolve();
  }

  subscribe(listener: GuiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSnapshot(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    if (this.snapshot) listener(this.snapshot);
    return () => this.snapshotListeners.delete(listener);
  }

  getSnapshot(): SessionSnapshot | null {
    return this.snapshot;
  }

  async start(options: StartOptions): Promise<void> {
    this.assertNotDisposed();
    this.projectPath = options.projectPath;
    this.started = true;
    this.snapshot = createEmptySnapshot({
      sessionId: "pending",
      projectPath: options.projectPath,
    });
    this.emit({
      type: "engine.started",
      sessionId: "pending",
      payload: {
        engineVersion: "fake-0.1.0",
        protocolVersion: 1,
        cwd: options.projectPath,
      },
    });
  }

  async authenticate(): Promise<void> {
    this.assertStarted();
    this.authenticated = true;
    this.emit({
      type: "engine.authenticated",
      sessionId: this.sessionId || "pending",
      payload: { methodId: "fake-cached" },
    });
  }

  async createSession(options?: CreateSessionOptions): Promise<string> {
    this.assertStarted();
    if (!this.authenticated) {
      await this.authenticate();
    }
    this.sessionId = `sess-fake-${Date.now()}`;
    const cwd = options?.cwd ?? this.projectPath;
    // Reset conversation state but keep engine identity from start().
    this.snapshot = this.resetSnapshot(this.sessionId, cwd);
    this.emit({
      type: "session.created",
      sessionId: this.sessionId,
      payload: { sessionId: this.sessionId, cwd },
    });
    return this.sessionId;
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.assertStarted();
    this.sessionId = sessionId;
    this.snapshot = this.resetSnapshot(sessionId, this.projectPath);
    this.emit({
      type: "session.resumed",
      sessionId,
      payload: { sessionId, cwd: this.projectPath, replayed: false },
    });
  }

  /** Fresh session projection, preserving engine/protocol version from start. */
  private resetSnapshot(sessionId: string, projectPath: string): SessionSnapshot {
    const prev = this.snapshot;
    return {
      ...createEmptySnapshot({ sessionId, projectPath }),
      engineVersion: prev?.engineVersion,
      protocolVersion: prev?.protocolVersion,
    };
  }

  async sendPrompt(content: ContentBlock[] | string): Promise<void> {
    this.assertSession();
    if (this.openTurnId) {
      throw new Error("A prompt turn is already in flight");
    }
    if (this.snapshot?.state === "faulted" || this.snapshot?.state === "disposed") {
      throw new Error(`Cannot send prompt while session is ${this.snapshot.state}`);
    }

    const prompt = asContentBlocks(content);
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    this.openTurnId = turnId;
    this.cancelRequested = false;

    this.emit({
      type: "turn.started",
      sessionId: this.sessionId,
      turnId,
      payload: { turnId, prompt },
    });

    if (this.faultOnPrompt) {
      this.emit({
        type: "engine.error",
        sessionId: this.sessionId,
        turnId,
        payload: {
          code: "fake_fault",
          message: "Fake engine was configured to fault on prompt",
          recoverable: true,
        },
      });
      this.openTurnId = null;
      return;
    }

    await this.streamDemoTurn(turnId, prompt);
  }

  /**
   * Streams a small demo assistant reply so the UI can render through
   * SessionSnapshot without a real CLI.
   */
  private async streamDemoTurn(
    turnId: string,
    prompt: ContentBlock[],
  ): Promise<void> {
    const userText =
      prompt
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("") || "(empty prompt)";

    const chunks = [
      "Got it. ",
      "I'm the **fake** agent engine behind `AgentEnginePort`. ",
      `You said: “${userText.slice(0, 120)}”. `,
      "This turn is normalized GuiEvents reduced into a SessionSnapshot — no ACP wire, no TUI.",
    ];

    const messageId = `asst-${turnId}`;
    for (const text of chunks) {
      if (this.cancelRequested || this.disposed) break;
      await this.delay(this.streamDelayMs);
      if (this.cancelRequested || this.disposed) break;
      this.emit({
        type: "assistant.message_chunk",
        sessionId: this.sessionId,
        turnId,
        payload: { messageId, chunk: { type: "text", text } },
      });
    }

    // Emergency stop / dispose may have already terminalized the session.
    const terminal =
      this.disposed ||
      this.snapshot?.state === "faulted" ||
      this.snapshot?.state === "disposed";

    if (!terminal) {
      if (this.cancelRequested) {
        this.emit({
          type: "turn.cancelled",
          sessionId: this.sessionId,
          turnId,
          payload: { turnId, stopReason: "cancelled" },
        });
      } else {
        this.emit({
          type: "turn.completed",
          sessionId: this.sessionId,
          turnId,
          payload: { turnId, stopReason: "end_turn" },
        });
      }
    }
    this.openTurnId = null;
  }

  async respondToApproval(
    requestId: string,
    decision: ApprovalOutcome,
  ): Promise<void> {
    this.assertSession();
    this.emit({
      type: "approval.resolved",
      sessionId: this.sessionId,
      turnId: this.openTurnId ?? undefined,
      payload: {
        requestId,
        outcome: decision,
        source: "user",
      },
    });
  }

  async setYolo(enabled: boolean): Promise<void> {
    this.assertSession();
    this.emit({
      type: "yolo.changed",
      sessionId: this.sessionId,
      payload: { enabled },
    });
  }

  async cancel(): Promise<void> {
    this.assertSession();
    if (!this.openTurnId) return;
    this.cancelRequested = true;
    this.emit({
      type: "turn.cancel_requested",
      sessionId: this.sessionId,
      turnId: this.openTurnId,
      payload: { turnId: this.openTurnId, reason: "user" },
    });
  }

  async emergencyStop(): Promise<void> {
    this.assertStarted();
    const turnId = this.openTurnId ?? undefined;
    this.cancelRequested = true;
    this.clearTimers();

    this.emit({
      type: "session.emergency_stop",
      sessionId: this.sessionId || "pending",
      turnId,
      payload: { phase: "cancel" },
    });
    this.emit({
      type: "session.emergency_stop",
      sessionId: this.sessionId || "pending",
      turnId,
      payload: { phase: "kill", detail: "fake process terminated" },
    });
    this.emit({
      type: "engine.exited",
      sessionId: this.sessionId || "pending",
      turnId,
      payload: { exitCode: null, signal: "SIGKILL" },
    });
    this.emit({
      type: "engine.error",
      sessionId: this.sessionId || "pending",
      turnId,
      payload: {
        code: "emergency_stop",
        message: "Emergency stop terminated the fake engine",
        recoverable: false,
      },
    });
    this.openTurnId = null;
  }

  async dispose(): Promise<void> {
    this.clearTimers();
    this.cancelRequested = true;
    const sid = this.sessionId || "pending";
    this.emit({
      type: "session.disposed",
      sessionId: sid,
      payload: { reason: "user" },
    });
    this.disposed = true;
    this.started = false;
    this.openTurnId = null;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("Engine is disposed");
  }

  private assertStarted(): void {
    this.assertNotDisposed();
    if (!this.started) throw new Error("Engine has not been started");
  }

  private assertSession(): void {
    this.assertStarted();
    if (!this.sessionId || !this.snapshot) {
      throw new Error("No active session");
    }
  }
}
