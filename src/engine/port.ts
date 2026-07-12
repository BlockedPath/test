/**
 * AgentEnginePort — the single application seam between UI and agent engine.
 *
 * The frontend depends only on this port and SessionSnapshot projections.
 * It must not consume ACP JSON-RPC or TUI output.
 */

import type {
  ApprovalOutcome,
  ContentBlock,
  CreateSessionOptions,
  GuiEvent,
  SessionSnapshot,
  StartOptions,
} from "./types";

export type GuiEventListener = (event: GuiEvent) => void;
export type SnapshotListener = (snapshot: SessionSnapshot) => void;

export interface AgentEnginePort {
  /** Spawn / initialize the agent engine for a Project. */
  start(options: StartOptions): Promise<void>;

  /** CLI-owned authentication negotiation. */
  authenticate(): Promise<void>;

  /** Create a new Session for the current Project. Returns sessionId. */
  createSession(options?: CreateSessionOptions): Promise<string>;

  /** Resume an existing Session when supported. */
  resumeSession(sessionId: string): Promise<void>;

  /** Submit a user prompt and open a turn. */
  sendPrompt(content: ContentBlock[] | string): Promise<void>;

  /** Resolve a pending approval request. */
  respondToApproval(
    requestId: string,
    decision: ApprovalOutcome,
  ): Promise<void>;

  /** Toggle YOLO policy for the current Session (GUI-side flag). */
  setYolo(enabled: boolean): Promise<void>;

  /** Cooperative cancellation of the open turn. */
  cancel(): Promise<void>;

  /** Escalate cancel → process kill → cleanup. */
  emergencyStop(): Promise<void>;

  /** Tear down the session and engine process. */
  dispose(): Promise<void>;

  /** Subscribe to the normalized GuiEvent stream. Returns unsubscribe. */
  subscribe(listener: GuiEventListener): () => void;

  /**
   * Optional snapshot subscription. Implementations that own a reducer
   * may emit projections here; pure-event adapters can leave this empty.
   */
  subscribeSnapshot?(listener: SnapshotListener): () => void;

  /** Current SessionSnapshot, or null before a session exists. */
  getSnapshot(): SessionSnapshot | null;
}
