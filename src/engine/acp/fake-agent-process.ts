/**
 * In-process fake ACP agent for bridge contract tests.
 * Speaks NDJSON JSON-RPC like grok agent stdio.
 */

import type { EngineProcessHandle } from "./transport";
import { EventEmitter } from "node:events";

export type FakeAgentBehavior = {
  agentVersion?: string;
  protocolVersion?: number;
  authMethods?: Array<{ id: string; name: string; description?: string }>;
  /** Force authenticate to fail with this method id map. */
  authFailures?: Record<string, { code: number; message: string }>;
  /** Fail initialize with an RPC error. */
  failInitialize?: { code: number; message: string };
  /** Emit this on stderr after start. */
  stderrOnStart?: string;
  /** Exit after N ms (null = stay alive). */
  exitAfterMs?: number | null;
  exitCode?: number;
  /** Session id to return from session/new. */
  sessionId?: string;
};

/**
 * Duplex fake process: client writes lines; agent responds on stdout.
 */
export class FakeAcpAgentProcess implements EngineProcessHandle {
  private readonly bus = new EventEmitter();
  private buffer = "";
  private _exited = false;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly behavior: Required<
    Pick<
      FakeAgentBehavior,
      | "agentVersion"
      | "protocolVersion"
      | "authMethods"
      | "sessionId"
      | "exitCode"
    >
  > &
    FakeAgentBehavior;
  private nextServerId = 10_000;
  readonly pid = 4242;

  constructor(behavior: FakeAgentBehavior = {}) {
    this.behavior = {
      agentVersion: behavior.agentVersion ?? "0.2.93",
      protocolVersion: behavior.protocolVersion ?? 1,
      authMethods: behavior.authMethods ?? [
        {
          id: "cached_token",
          name: "cached_token",
          description: "Cached token from ~/.grok/auth.json",
        },
        {
          id: "grok.com",
          name: "Grok",
          description: "Sign in with Grok",
        },
        {
          id: "xai.api_key",
          name: "API Key",
          description: "XAI_API_KEY",
        },
      ],
      sessionId: behavior.sessionId ?? "sess-fake-acp-1",
      exitCode: behavior.exitCode ?? 0,
      ...behavior,
    };

    if (behavior.stderrOnStart) {
      // Defer so the client can attach onStderr after spawn returns.
      setTimeout(() => this.emitStderr(behavior.stderrOnStart!), 0);
    }
    if (behavior.exitAfterMs != null) {
      this.exitTimer = setTimeout(() => {
        this.finish(behavior.exitCode ?? 0, null);
      }, behavior.exitAfterMs);
    }
  }

  get exited(): boolean {
    return this._exited;
  }

  write(line: string): void {
    if (this._exited) return;
    this.buffer += line;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const one = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (one.trim()) this.handleClientLine(one);
    }
  }

  onStdoutLine(handler: (line: string) => void): () => void {
    this.bus.on("stdout", handler);
    return () => this.bus.off("stdout", handler);
  }

  onStderr(handler: (chunk: string) => void): () => void {
    this.bus.on("stderr", handler);
    return () => this.bus.off("stderr", handler);
  }

  onExit(
    handler: (info: { exitCode: number | null; signal: string | null }) => void,
  ): () => void {
    this.bus.on("exit", handler);
    return () => this.bus.off("exit", handler);
  }

  kill(_signal?: string): void {
    this.finish(null, "SIGTERM");
  }

  /** Test helper: push a server→client request. */
  requestFromAgent(method: string, params: unknown): number {
    const id = this.nextServerId++;
    this.emitStdout({ jsonrpc: "2.0", id, method, params });
    return id;
  }

  /** Test helper: push a notification. */
  notifyFromAgent(method: string, params: unknown): void {
    this.emitStdout({ jsonrpc: "2.0", method, params });
  }

  private emitStdout(msg: unknown): void {
    this.bus.emit("stdout", JSON.stringify(msg));
  }

  private emitStderr(text: string): void {
    this.bus.emit("stderr", text);
  }

  private finish(exitCode: number | null, signal: string | null): void {
    if (this._exited) return;
    this._exited = true;
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.bus.emit("exit", { exitCode, signal });
  }

  private handleClientLine(line: string): void {
    let msg: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      this.emitStderr(`parse error: ${line.slice(0, 80)}\n`);
      return;
    }

    // Client responses to our requests — ignore for fake
    if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
      return;
    }

    if (!msg.method) return;

    const id = msg.id;
    if (id === undefined) {
      // notifications
      return;
    }

    void this.dispatch(msg.method, msg.params, id);
  }

  private dispatch(
    method: string,
    params: unknown,
    id: number | string,
  ): void {
    try {
      if (method === "initialize") {
        if (this.behavior.failInitialize) {
          this.emitStdout({
            jsonrpc: "2.0",
            id,
            error: this.behavior.failInitialize,
          });
          return;
        }
        this.emitStdout({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: this.behavior.protocolVersion,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: false, embeddedContext: true },
            },
            authMethods: this.behavior.authMethods,
            _meta: {
              agentVersion: this.behavior.agentVersion,
              defaultAuthMethodId: this.behavior.authMethods[0]?.id,
            },
          },
        });
        return;
      }

      if (method === "authenticate") {
        const methodId =
          params &&
          typeof params === "object" &&
          "methodId" in params
            ? String((params as { methodId: string }).methodId)
            : "";
        const failure = this.behavior.authFailures?.[methodId];
        if (failure) {
          this.emitStdout({
            jsonrpc: "2.0",
            id,
            error: failure,
          });
          return;
        }
        this.emitStdout({
          jsonrpc: "2.0",
          id,
          result: { ok: true },
        });
        return;
      }

      if (method === "session/new") {
        this.emitStdout({
          jsonrpc: "2.0",
          id,
          result: {
            sessionId: this.behavior.sessionId,
            _meta: {
              currentWorkingDirectory:
                params &&
                typeof params === "object" &&
                "cwd" in params
                  ? (params as { cwd: string }).cwd
                  : "",
            },
          },
        });
        return;
      }

      if (method === "session/prompt") {
        const sessionId =
          params &&
          typeof params === "object" &&
          "sessionId" in params
            ? (params as { sessionId: string }).sessionId
            : this.behavior.sessionId;
        this.notifyFromAgent("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from fake acp" },
          },
        });
        this.emitStdout({
          jsonrpc: "2.0",
          id,
          result: { stopReason: "end_turn" },
        });
        return;
      }

      if (method === "session/cancel") {
        this.emitStdout({ jsonrpc: "2.0", id, result: {} });
        return;
      }

      this.emitStdout({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch (err) {
      this.emitStdout({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
