/**
 * Real Grok CLI engine behind AgentEnginePort.
 * Discovers/verifies the binary, launches ACP over stdio, authenticates,
 * and creates sessions — emitting only normalized GuiEvents.
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
import {
  CLIENT_INFO,
  PINNED_ENGINE_VERSION,
} from "./constants";
import {
  discoverEngine,
  type DiscoveryHost,
  type DiscoveryResult,
} from "./discovery";
import {
  verifyEngineIdentity,
  type IdentityHost,
  type IdentityCheckResult,
} from "./identity";
import { planEngineSpawn, assertDirectSpawn } from "./spawn-plan";
import { JsonRpcClient, type RpcError } from "./acp/jsonrpc-client";
import type { EngineProcessHandle, SpawnEngine } from "./acp/transport";
import { redactSecrets, safeErrorMessage } from "./redact";

export type GrokAcpEngineDeps = {
  discovery: DiscoveryHost;
  identity: IdentityHost;
  spawn: SpawnEngine;
  /** Optional fixed engine path (skips discovery). */
  enginePath?: string;
  /** Skip identity checks (tests only). */
  skipIdentity?: boolean;
  requestTimeoutMs?: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function asContentBlocks(content: ContentBlock[] | string): ContentBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content;
}

type AuthMethod = { id: string; name?: string; description?: string };

/**
 * AgentEnginePort implementation backed by a supervised Grok CLI ACP process.
 */
export class GrokAcpEngine implements AgentEnginePort {
  private listeners = new Set<GuiEventListener>();
  private snapshotListeners = new Set<SnapshotListener>();
  private snapshot: SessionSnapshot | null = null;
  private eventSeq = 0;
  private projectPath = "";
  private sessionId = "";
  private started = false;
  private authenticated = false;
  private disposed = false;
  private openTurnId: string | null = null;
  private turnCounter = 0;
  private proc: EngineProcessHandle | null = null;
  private rpc: JsonRpcClient | null = null;
  private authMethods: AuthMethod[] = [];
  private engineVersion: string | undefined;
  private protocolVersion = 1;
  private authPolicy: StartOptions["authPolicy"] | undefined;
  private discoveryResult: DiscoveryResult | null = null;
  private identityResult: IdentityCheckResult | null = null;
  private readonly requestTimeoutMs: number;

  constructor(private readonly deps: GrokAcpEngineDeps) {
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 60_000;
  }

  /** Last discovery outcome (for UI acquisition guidance). */
  getDiscovery(): DiscoveryResult | null {
    return this.discoveryResult;
  }

  /** Last identity check (for diagnostics). */
  getIdentity(): IdentityCheckResult | null {
    return this.identityResult;
  }

  private nextEventId(): string {
    this.eventSeq += 1;
    return `acp-evt-${this.eventSeq}`;
  }

  private emit(
    partial: Omit<GuiEvent, "eventId" | "observedAt"> & {
      type: GuiEvent["type"];
    },
  ): void {
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

  private emitError(
    code: string,
    message: string,
    recoverable: boolean,
    cause?: string,
  ): void {
    this.emit({
      type: "engine.error",
      sessionId: this.sessionId || "pending",
      turnId: this.openTurnId ?? undefined,
      payload: {
        code,
        message: redactSecrets(message),
        recoverable,
        cause: cause ? redactSecrets(cause) : undefined,
      },
    });
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
    this.authPolicy = options.authPolicy;
    this.snapshot = createEmptySnapshot({
      sessionId: "pending",
      projectPath: options.projectPath,
    });

    // --- discover ---
    let enginePath = this.deps.enginePath;
    if (!enginePath) {
      this.discoveryResult = await discoverEngine(this.deps.discovery);
      if (this.discoveryResult.status === "missing") {
        const acq = this.discoveryResult.acquisition;
        this.emitError(
          "engine_missing",
          `${this.discoveryResult.message} Acquisition: ${acq.windowsPowerShell}`,
          true,
        );
        throw new Error(this.discoveryResult.message);
      }
      enginePath = this.discoveryResult.candidate.path;
    } else {
      this.discoveryResult = {
        status: "found",
        candidate: { path: enginePath, source: "configured" },
        alsoFound: [],
      };
    }

    // --- verify identity ---
    if (!this.deps.skipIdentity) {
      this.identityResult = await verifyEngineIdentity(
        enginePath,
        this.deps.identity,
      );
      if (!this.identityResult.ok) {
        this.emitError(
          this.identityResult.code,
          this.identityResult.message,
          true,
        );
        throw new Error(this.identityResult.message);
      }
      this.engineVersion =
        this.identityResult.version.version ?? PINNED_ENGINE_VERSION;
    }

    // --- spawn ACP stdio ---
    const plan = planEngineSpawn({
      enginePath,
      alwaysApprove: false,
      baseEnv: this.deps.discovery.env,
    });
    assertDirectSpawn(plan);

    this.proc = this.deps.spawn(plan);
    this.rpc = new JsonRpcClient(this.proc, {
      onNotification: (method, params) => this.onAgentNotification(method, params),
      onRequest: async (method, params) => this.onAgentRequest(method, params),
    });

    this.proc.onStderr((chunk) => {
      this.emit({
        type: "engine.stderr",
        sessionId: this.sessionId || "pending",
        payload: {
          text: redactSecrets(chunk),
          level: /error|fail/i.test(chunk) ? "error" : "info",
        },
      });
    });

    this.proc.onExit(({ exitCode, signal }) => {
      this.emit({
        type: "engine.exited",
        sessionId: this.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: { exitCode, signal },
      });
      if (!this.disposed) {
        this.emitError(
          "engine_exited",
          `Engine process exited (code=${exitCode ?? "null"}, signal=${signal ?? "null"})`,
          false,
        );
      }
    });

    // --- initialize ---
    try {
      const init = (await this.rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: CLIENT_INFO,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
            ...(options.capabilities ?? {}),
          },
        },
        this.requestTimeoutMs,
      )) as {
        protocolVersion?: number;
        authMethods?: AuthMethod[];
        _meta?: { agentVersion?: string };
        agentInfo?: { version?: string };
      };

      this.protocolVersion = init.protocolVersion ?? 1;
      this.authMethods = init.authMethods ?? [];
      this.engineVersion =
        init._meta?.agentVersion ??
        init.agentInfo?.version ??
        this.engineVersion ??
        PINNED_ENGINE_VERSION;
    } catch (err) {
      const msg = safeErrorMessage(err);
      this.emitError("initialize_failed", msg, true);
      await this.teardownProcess();
      throw new Error(msg);
    }

    this.started = true;
    this.emit({
      type: "engine.started",
      sessionId: "pending",
      payload: {
        engineVersion: this.engineVersion,
        protocolVersion: this.protocolVersion,
        cwd: options.projectPath,
      },
    });
  }

  async authenticate(): Promise<void> {
    this.assertStarted();
    if (!this.rpc) throw new Error("No RPC client");

    const methodId = this.pickAuthMethod();
    try {
      await this.rpc.request(
        "authenticate",
        { methodId, _meta: { headless: true } },
        this.requestTimeoutMs,
      );
    } catch (err) {
      const rpc = err as RpcError;
      const code = this.authFailureCode(methodId, rpc);
      const message = this.authFailureMessage(methodId, rpc);
      this.emitError(code, message, true);
      throw new Error(message);
    }

    this.authenticated = true;
    this.emit({
      type: "engine.authenticated",
      sessionId: this.sessionId || "pending",
      payload: { methodId },
    });
  }

  private pickAuthMethod(): string {
    const ids = new Set(this.authMethods.map((m) => m.id));
    const policy = this.authPolicy;

    if (policy === "browser" && ids.has("grok.com")) return "grok.com";
    if (policy === "device") {
      if (ids.has("device_code")) return "device_code";
      if (ids.has("device-code")) return "device-code";
    }
    if (policy === "api_key" && ids.has("xai.api_key")) return "xai.api_key";
    if (policy === "cached" && ids.has("cached_token")) return "cached_token";

    // Prefer non-interactive when available
    if (ids.has("cached_token")) return "cached_token";
    if (ids.has("xai.api_key")) return "xai.api_key";
    if (ids.has("grok.com")) return "grok.com";
    if (ids.has("device_code") || ids.has("device-code")) {
      return ids.has("device_code") ? "device_code" : "device-code";
    }
    const first = this.authMethods[0]?.id;
    if (first) return first;
    // Fall back to cached even if not advertised (some CLIs accept it)
    return "cached_token";
  }

  private authFailureCode(methodId: string, err: RpcError): string {
    const msg = (err.message || "").toLowerCase();
    if (methodId === "grok.com" || /browser|oidc|login/.test(msg)) {
      return "auth_browser_failed";
    }
    if (/device/.test(methodId) || /device/.test(msg)) {
      return "auth_device_code_failed";
    }
    if (methodId.includes("api_key") || /api.?key/.test(msg)) {
      return "auth_api_key_failed";
    }
    if (methodId === "cached_token" || /cached|token|auth\.json/.test(msg)) {
      return "auth_cached_failed";
    }
    return "auth_failed";
  }

  private authFailureMessage(methodId: string, err: RpcError): string {
    const base = safeErrorMessage(err);
    switch (methodId) {
      case "grok.com":
        return `Browser authentication failed (${methodId}). ${base} Try CLI: grok login`;
      case "device_code":
      case "device-code":
        return `Device-code authentication failed. ${base} Try CLI: grok login --device-auth`;
      case "xai.api_key":
        return `API key authentication failed. ${base} Set XAI_API_KEY in the environment (never paste keys into the GUI).`;
      case "cached_token":
        return `Cached CLI credentials were rejected. ${base} Run grok login, then retry.`;
      default:
        return `Authentication failed (${methodId}). ${base}`;
    }
  }

  async createSession(options?: CreateSessionOptions): Promise<string> {
    this.assertStarted();
    if (!this.rpc) throw new Error("No RPC client");
    if (!this.authenticated) {
      await this.authenticate();
    }

    const cwd = options?.cwd ?? this.projectPath;
    try {
      const result = (await this.rpc.request(
        "session/new",
        { cwd, mcpServers: [] },
        this.requestTimeoutMs,
      )) as { sessionId?: string };

      if (!result.sessionId) {
        throw new Error("session/new returned no sessionId");
      }

      this.sessionId = result.sessionId;
      this.snapshot = {
        ...createEmptySnapshot({
          sessionId: this.sessionId,
          projectPath: cwd,
        }),
        engineVersion: this.engineVersion,
        protocolVersion: this.protocolVersion,
      };

      this.emit({
        type: "session.created",
        sessionId: this.sessionId,
        payload: {
          sessionId: this.sessionId,
          cwd,
        },
      });

      return this.sessionId;
    } catch (err) {
      const msg = safeErrorMessage(err);
      this.emitError("session_create_failed", msg, true);
      throw new Error(msg);
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.assertStarted();
    // Full loadSession support is CLI-dependent; emit resumed with best effort.
    this.sessionId = sessionId;
    this.snapshot = {
      ...createEmptySnapshot({
        sessionId,
        projectPath: this.projectPath,
      }),
      engineVersion: this.engineVersion,
      protocolVersion: this.protocolVersion,
    };
    this.emit({
      type: "session.resumed",
      sessionId,
      payload: { sessionId, cwd: this.projectPath, replayed: false },
    });
  }

  async sendPrompt(content: ContentBlock[] | string): Promise<void> {
    this.assertSession();
    if (!this.rpc) throw new Error("No RPC client");
    if (this.openTurnId) {
      throw new Error("A prompt turn is already in flight");
    }
    if (
      this.snapshot?.state === "faulted" ||
      this.snapshot?.state === "disposed"
    ) {
      throw new Error(`Cannot send prompt while session is ${this.snapshot.state}`);
    }

    const prompt = asContentBlocks(content);
    this.turnCounter += 1;
    const turnId = `turn-${this.turnCounter}`;
    this.openTurnId = turnId;

    this.emit({
      type: "turn.started",
      sessionId: this.sessionId,
      turnId,
      payload: { turnId, prompt },
    });

    try {
      const result = (await this.rpc.request(
        "session/prompt",
        {
          sessionId: this.sessionId,
          prompt: prompt.map((b) =>
            b.type === "text" ? { type: "text", text: b.text } : b,
          ),
        },
        this.requestTimeoutMs,
      )) as { stopReason?: string };

      const stop = (result.stopReason ?? "end_turn") as
        | "end_turn"
        | "max_tokens"
        | "max_turn_requests"
        | "refusal"
        | "cancelled";

      if (stop === "cancelled") {
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
          payload: { turnId, stopReason: stop },
        });
      }
    } catch (err) {
      this.emitError("prompt_failed", safeErrorMessage(err), true);
    } finally {
      this.openTurnId = null;
    }
  }

  async respondToApproval(
    requestId: string,
    decision: ApprovalOutcome,
  ): Promise<void> {
    this.assertSession();
    // Permission responses are correlated at the JSON-RPC layer when the
    // agent issues session/request_permission; this path covers GUI-driven resolve.
    this.emit({
      type: "approval.resolved",
      sessionId: this.sessionId,
      turnId: this.openTurnId ?? undefined,
      payload: { requestId, outcome: decision, source: "user" },
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
    if (!this.openTurnId || !this.rpc) return;
    this.emit({
      type: "turn.cancel_requested",
      sessionId: this.sessionId,
      turnId: this.openTurnId,
      payload: { turnId: this.openTurnId, reason: "user" },
    });
    this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  async emergencyStop(): Promise<void> {
    this.assertStarted();
    const turnId = this.openTurnId ?? undefined;
    this.emit({
      type: "session.emergency_stop",
      sessionId: this.sessionId || "pending",
      turnId,
      payload: { phase: "cancel" },
    });

    try {
      this.rpc?.notify("session/cancel", {
        sessionId: this.sessionId || undefined,
      });
    } catch {
      /* ignore */
    }

    this.emit({
      type: "session.emergency_stop",
      sessionId: this.sessionId || "pending",
      turnId,
      payload: { phase: "kill", detail: "terminating engine process" },
    });

    this.proc?.kill("SIGTERM");
    this.openTurnId = null;

    this.emitError(
      "emergency_stop",
      "Emergency stop terminated the engine process",
      false,
    );
  }

  async dispose(): Promise<void> {
    const sid = this.sessionId || "pending";
    await this.teardownProcess();
    this.emit({
      type: "session.disposed",
      sessionId: sid,
      payload: { reason: "user" },
    });
    this.disposed = true;
    this.started = false;
    this.openTurnId = null;
  }

  private async teardownProcess(): Promise<void> {
    this.rpc?.close();
    this.rpc = null;
    if (this.proc && !this.proc.exited) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
  }

  private onAgentNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.mapSessionUpdate(params);
      return;
    }
    if (method === "_grok_gui/parse_error") {
      this.emitError(
        "protocol_parse_error",
        "Failed to parse ACP stdout line",
        true,
        typeof params === "object" && params && "line" in params
          ? String((params as { line: string }).line)
          : undefined,
      );
      return;
    }
    // Tolerate vendor / unknown notifications
    this.emit({
      type: "engine.unknown_update",
      sessionId: this.sessionId || "pending",
      payload: { raw: { method, params } },
    });
  }

  private mapSessionUpdate(params: unknown): void {
    const p = params as {
      sessionId?: string;
      update?: {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
        toolCallId?: string;
        title?: string;
        kind?: string;
        status?: string;
      };
    };
    const update = p?.update;
    if (!update) {
      this.emit({
        type: "engine.unknown_update",
        sessionId: this.sessionId || "pending",
        payload: { raw: params },
      });
      return;
    }

    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk" && update.content?.text != null) {
      this.emit({
        type: "assistant.message_chunk",
        sessionId: this.sessionId || p.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: {
          messageId: `asst-${this.openTurnId ?? "stream"}`,
          chunk: { type: "text", text: update.content.text },
        },
      });
      return;
    }

    if (kind === "agent_thought_chunk" && update.content?.text != null) {
      this.emit({
        type: "assistant.thought_chunk",
        sessionId: this.sessionId || p.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: {
          chunk: { type: "text", text: update.content.text },
        },
      });
      return;
    }

    if (kind === "tool_call" && update.toolCallId) {
      this.emit({
        type: "tool.started",
        sessionId: this.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: {
          toolCallId: update.toolCallId,
          title: update.title ?? "tool",
          kind: (update.kind as "other") || "other",
          status: (update.status as "pending") || "pending",
        },
      });
      return;
    }

    this.emit({
      type: "engine.unknown_update",
      sessionId: this.sessionId || "pending",
      payload: { raw: params },
    });
  }

  private async onAgentRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    // Minimal stubs — full fs/terminal bridges land with later tickets.
    if (method.startsWith("fs/")) {
      throw Object.assign(new Error(`unsupported client method ${method}`), {
        code: -32601,
      });
    }
    if (method.startsWith("terminal/")) {
      throw Object.assign(new Error(`unsupported client method ${method}`), {
        code: -32601,
      });
    }
    if (
      method === "session/request_permission" ||
      method.includes("permission")
    ) {
      // Default deny until UI approval path is wired; still emit event.
      const p = params as {
        toolCall?: { toolCallId?: string; title?: string };
        options?: Array<{
          optionId: string;
          name: string;
          kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
        }>;
      };
      const requestId = `perm-${this.eventSeq + 1}`;
      this.emit({
        type: "approval.requested",
        sessionId: this.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: {
          requestId,
          toolCallId: p.toolCall?.toolCallId ?? "unknown",
          title: p.toolCall?.title,
          options: p.options ?? [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      return {
        outcome: { outcome: "selected", optionId: "reject-once" },
      };
    }

    // Unknown vendor methods: tolerate without crashing
    this.emit({
      type: "engine.unknown_update",
      sessionId: this.sessionId || "pending",
      payload: { raw: { method, params } },
    });
    throw Object.assign(new Error(`unsupported client method ${method}`), {
      code: -32601,
    });
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
