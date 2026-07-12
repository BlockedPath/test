/**
 * JSON-RPC 2.0 client over NDJSON lines (ACP stdio framing).
 */

import type {
  EngineProcessHandle,
  JsonRpcId,
  JsonRpcMessage,
} from "./transport";
import { redactDeep, redactSecrets, safeErrorMessage } from "../redact";

export type RpcError = Error & {
  code?: number;
  data?: unknown;
  rpc?: { code: number; message: string; data?: unknown };
};

export type IncomingRequestHandler = (
  method: string,
  params: unknown,
  id: JsonRpcId,
) => Promise<unknown> | unknown;

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private unsubs: Array<() => void> = [];
  private onNotification: (method: string, params: unknown) => void;
  private onRequest: IncomingRequestHandler;
  private closed = false;

  constructor(
    private readonly proc: EngineProcessHandle,
    options: {
      onNotification?: (method: string, params: unknown) => void;
      onRequest?: IncomingRequestHandler;
    } = {},
  ) {
    this.onNotification = options.onNotification ?? (() => {});
    this.onRequest =
      options.onRequest ??
      (async (method) => {
        throw Object.assign(new Error(`unsupported client method ${method}`), {
          code: -32601,
        });
      });

    this.unsubs.push(
      proc.onStdoutLine((line) => this.onLine(line)),
    );
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Surface as notification so bridge can emit engine.error
      this.onNotification("_grok_gui/parse_error", {
        line: redactSecrets(line.slice(0, 500)),
      });
      return;
    }

    // Response to our request
    if (
      "id" in message &&
      message.id !== undefined &&
      message.id !== null &&
      ("result" in message || "error" in message)
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message && message.error) {
        const err = new Error(
          redactSecrets(message.error.message || "RPC error"),
        ) as RpcError;
        err.code = message.error.code;
        err.data = message.error.data !== undefined
          ? redactDeep(message.error.data)
          : undefined;
        err.rpc = {
          code: message.error.code,
          message: redactSecrets(message.error.message),
          data: err.data,
        };
        pending.reject(err);
      } else {
        pending.resolve(
          "result" in message ? redactDeep(message.result) : undefined,
        );
      }
      return;
    }

    // Request or notification from agent
    if ("method" in message && typeof message.method === "string") {
      if ("id" in message && message.id !== undefined && message.id !== null) {
        void this.handleIncomingRequest(
          message.method,
          message.params,
          message.id,
        );
      } else {
        this.onNotification(message.method, message.params);
      }
    }
  }

  private async handleIncomingRequest(
    method: string,
    params: unknown,
    id: JsonRpcId,
  ): Promise<void> {
    try {
      const result = await this.onRequest(method, params, id);
      this.write({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? Number((err as { code: number }).code)
          : -32000;
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: Number.isFinite(code) ? code : -32000,
          message: safeErrorMessage(err),
        },
      });
    }
  }

  request(
    method: string,
    params?: unknown,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("JSON-RPC client is closed"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: Record<string, unknown>): void {
    this.proc.write(JSON.stringify(message) + "\n");
  }

  close(): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`RPC closed while waiting for id=${id}`));
    }
    this.pending.clear();
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }
}
