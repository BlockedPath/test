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
  ToolKind,
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
import {
  TerminalBridge,
  type SpawnTerminalProcess,
  type TerminalCreateRequest,
} from "./terminal-bridge";

export type GrokAcpEngineDeps = {
  discovery: DiscoveryHost;
  identity: IdentityHost;
  spawn: SpawnEngine;
  /** Optional fixed engine path (skips discovery). */
  enginePath?: string;
  /** Skip identity checks (tests only). */
  skipIdentity?: boolean;
  requestTimeoutMs?: number;
  /** Injectable terminal process spawner (tests). */
  spawnTerminal?: SpawnTerminalProcess;
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
  private terminalBridge: TerminalBridge | null = null;
  private permissionWaiters = new Map<
    string,
    {
      resolve: (result: unknown) => void;
    }
  >();
  private permissionSeq = 0;
  private yoloEnabled = false;

  constructor(private readonly deps: GrokAcpEngineDeps) {
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 60_000;
  }

  /** Test/diagnostic access to the terminal bridge. */
  getTerminalBridge(): TerminalBridge | null {
    return this.terminalBridge;
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

    this.terminalBridge = new TerminalBridge({
      // Node/Tauri hosts inject spawnTerminal (createNodeTerminalSpawner).
      // Browser UI uses FakeAgentEngine and never reaches real terminals.
      spawnProcess: this.deps.spawnTerminal,
      defaultCwd: options.projectPath,
      baseEnv: (this.deps.discovery.env ?? {}) as NodeJS.ProcessEnv,
      hooks: {
        onStarted: (info) => {
          this.emit({
            type: "command.started",
            sessionId: this.sessionId || "pending",
            turnId: this.openTurnId ?? undefined,
            payload: info,
          });
        },
        onOutput: (info) => {
          this.emit({
            type: "command.output",
            sessionId: this.sessionId || "pending",
            turnId: this.openTurnId ?? undefined,
            payload: {
              terminalId: info.terminalId,
              chunk: info.chunk,
              snapshot: info.snapshot,
              truncated: info.truncated,
            },
          });
        },
        onExited: (info) => {
          this.emit({
            type: "command.exited",
            sessionId: this.sessionId || "pending",
            turnId: this.openTurnId ?? undefined,
            payload: info,
          });
        },
        onKilled: (info) => {
          this.emit({
            type: "command.killed",
            sessionId: this.sessionId || "pending",
            turnId: this.openTurnId ?? undefined,
            payload: info,
          });
        },
        onReleased: (info) => {
          this.emit({
            type: "command.released",
            sessionId: this.sessionId || "pending",
            turnId: this.openTurnId ?? undefined,
            payload: info,
          });
        },
        onFailure: (info) => {
          // Terminal failures are tool/command scoped — do not fault the Session.
          this.emit({
            type: "engine.stderr",
            sessionId: this.sessionId || "pending",
            turnId: this.openTurnId ?? undefined,
            payload: {
              text: redactSecrets(
                `[${info.code}] ${info.message}${
                  info.terminalId ? ` (${info.terminalId})` : ""
                }`,
              ),
              level: "error",
            },
          });
        },
      },
    });

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
    this.emit({
      type: "approval.resolved",
      sessionId: this.sessionId,
      turnId: this.openTurnId ?? undefined,
      payload: { requestId, outcome: decision, source: "user" },
    });
    const waiter = this.permissionWaiters.get(requestId);
    if (waiter) {
      this.permissionWaiters.delete(requestId);
      waiter.resolve({ outcome: decision });
    }
  }

  async setYolo(enabled: boolean): Promise<void> {
    this.assertSession();
    this.yoloEnabled = enabled;
    this.emit({
      type: "yolo.changed",
      sessionId: this.sessionId,
      payload: { enabled },
    });
  }

  async cancel(): Promise<void> {
    this.assertSession();
    // Always stop running commands, even if the prompt already finished.
    this.terminalBridge?.killAll("user");
    this.cancelPendingPermissions();
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

    this.terminalBridge?.killAll("emergency_stop");
    this.cancelPendingPermissions();

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
    this.terminalBridge?.disposeAll();
    this.terminalBridge = null;
    this.cancelPendingPermissions();
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

  private cancelPendingPermissions(): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      this.emit({
        type: "approval.resolved",
        sessionId: this.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: {
          requestId,
          outcome: { outcome: "cancelled" },
          source: "cancel",
        },
      });
      waiter.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.permissionWaiters.clear();
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
        rawInput?: unknown;
        rawOutput?: unknown;
        locations?: Array<{ path: string; line?: number }>;
        contentBlocks?: unknown[];
      };
    };
    const update = p?.update as
      | (NonNullable<typeof p.update> & { content?: unknown })
      | undefined;
    if (!update) {
      this.emit({
        type: "engine.unknown_update",
        sessionId: this.sessionId || "pending",
        payload: { raw: params },
      });
      return;
    }

    const kind = update.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const text =
        update.content &&
        typeof update.content === "object" &&
        "text" in update.content
          ? String((update.content as { text?: string }).text ?? "")
          : "";
      if (text) {
        this.emit({
          type: "assistant.message_chunk",
          sessionId: this.sessionId || p.sessionId || "pending",
          turnId: this.openTurnId ?? undefined,
          payload: {
            messageId: `asst-${this.openTurnId ?? "stream"}`,
            chunk: { type: "text", text },
          },
        });
        return;
      }
    }

    if (kind === "agent_thought_chunk") {
      const text =
        update.content &&
        typeof update.content === "object" &&
        "text" in update.content
          ? String((update.content as { text?: string }).text ?? "")
          : "";
      if (text) {
        this.emit({
          type: "assistant.thought_chunk",
          sessionId: this.sessionId || p.sessionId || "pending",
          turnId: this.openTurnId ?? undefined,
          payload: {
            chunk: { type: "text", text },
          },
        });
        return;
      }
    }

    if (kind === "tool_call" && update.toolCallId) {
      const toolContent = this.extractToolContent(update);
      this.emit({
        type: "tool.started",
        sessionId: this.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: {
          toolCallId: update.toolCallId,
          title: update.title ?? "tool",
          kind: (update.kind as ToolKind) || "other",
          status: (update.status as "pending") || "pending",
          rawInput: update.rawInput,
          locations: update.locations,
        },
      });
      if (toolContent.length) {
        this.emit({
          type: "tool.updated",
          sessionId: this.sessionId || "pending",
          turnId: this.openTurnId ?? undefined,
          payload: {
            toolCallId: update.toolCallId,
            content: toolContent,
          },
        });
      }
      return;
    }

    if (kind === "tool_call_update" && update.toolCallId) {
      const toolContent = this.extractToolContent(update);
      const status = update.status as
        | "pending"
        | "in_progress"
        | "completed"
        | "failed"
        | "cancelled"
        | undefined;
      this.emit({
        type: "tool.updated",
        sessionId: this.sessionId || "pending",
        turnId: this.openTurnId ?? undefined,
        payload: {
          toolCallId: update.toolCallId,
          status,
          title: update.title,
          content: toolContent.length ? toolContent : undefined,
          rawInput: update.rawInput,
          rawOutput: update.rawOutput,
          locations: update.locations,
        },
      });
      if (
        status === "completed" ||
        status === "failed" ||
        status === "cancelled"
      ) {
        this.emit({
          type: "tool.finished",
          sessionId: this.sessionId || "pending",
          turnId: this.openTurnId ?? undefined,
          payload: {
            toolCallId: update.toolCallId,
            status,
            content: toolContent.length ? toolContent : undefined,
            rawOutput: update.rawOutput,
          },
        });
      }
      return;
    }

    this.emit({
      type: "engine.unknown_update",
      sessionId: this.sessionId || "pending",
      payload: { raw: params },
    });
  }

  private extractToolContent(update: {
    content?: unknown;
    contentBlocks?: unknown[];
  }): unknown[] {
    if (Array.isArray(update.content)) return update.content;
    if (Array.isArray(update.contentBlocks)) return update.contentBlocks;
    return [];
  }

  private async onAgentRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (method.startsWith("terminal/")) {
      return this.handleTerminalMethod(method, params);
    }
    if (method.startsWith("fs/")) {
      // File tools land with the edits ticket; still surface unknown method cleanly.
      throw Object.assign(new Error(`unsupported client method ${method}`), {
        code: -32601,
      });
    }
    if (
      method === "session/request_permission" ||
      method.includes("permission")
    ) {
      return this.handlePermissionRequest(params);
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

  private handleTerminalMethod(method: string, params: unknown): unknown {
    if (!this.terminalBridge) {
      throw Object.assign(new Error("Terminal bridge not ready"), {
        code: -32000,
      });
    }
    const p = (params ?? {}) as TerminalCreateRequest & {
      terminalId?: string;
    };

    switch (method) {
      case "terminal/create":
        return this.terminalBridge.create({
          sessionId: p.sessionId,
          command: p.command,
          args: p.args,
          cwd: p.cwd || this.projectPath,
          env: p.env,
          outputByteLimit: p.outputByteLimit,
          toolCallId: p.toolCallId,
        });
      case "terminal/output":
        return this.terminalBridge.output(String(p.terminalId ?? ""));
      case "terminal/wait_for_exit":
        return this.terminalBridge.waitForExit(String(p.terminalId ?? ""));
      case "terminal/kill":
        return this.terminalBridge.kill(String(p.terminalId ?? ""), "agent");
      case "terminal/release":
        return this.terminalBridge.release(String(p.terminalId ?? ""));
      default:
        throw Object.assign(new Error(`unsupported terminal method ${method}`), {
          code: -32601,
        });
    }
  }

  private async handlePermissionRequest(params: unknown): Promise<unknown> {
    const p = params as {
      toolCall?: {
        toolCallId?: string;
        title?: string;
        kind?: ToolKind;
      };
      options?: Array<{
        optionId: string;
        name: string;
        kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
      }>;
    };

    const options = p.options ?? [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" as const },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" as const },
    ];
    this.permissionSeq += 1;
    const requestId = `perm-${this.permissionSeq}`;
    const toolCallId = p.toolCall?.toolCallId ?? "unknown";
    const kind = p.toolCall?.kind;
    const title = p.toolCall?.title;

    this.emit({
      type: "approval.requested",
      sessionId: this.sessionId || "pending",
      turnId: this.openTurnId ?? undefined,
      payload: {
        requestId,
        toolCallId,
        title,
        kind,
        options,
        preview: params,
      },
    });

    // YOLO auto-allows normal in-project commands/edits once (still audited).
    if (this.yoloEnabled || this.snapshot?.yoloEnabled) {
      const allow =
        options.find((o) => o.kind === "allow_once") ??
        options.find((o) => o.kind === "allow_always");
      if (allow) {
        this.emit({
          type: "approval.resolved",
          sessionId: this.sessionId || "pending",
          turnId: this.openTurnId ?? undefined,
          payload: {
            requestId,
            outcome: { outcome: "selected", optionId: allow.optionId },
            source: "yolo",
          },
        });
        return {
          outcome: { outcome: "selected", optionId: allow.optionId },
        };
      }
    }

    // Wait for the user via respondToApproval — keeps conversation state intact.
    return new Promise((resolve) => {
      this.permissionWaiters.set(requestId, { resolve });
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
