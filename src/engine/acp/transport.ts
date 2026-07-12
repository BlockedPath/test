/**
 * ACP stdio transport: newline-delimited JSON-RPC over duplex streams.
 */

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export type EngineProcessHandle = {
  /** Write one NDJSON line (trailing newline added if missing). */
  write(line: string): void;
  /** Subscribe to stdout lines (without newline). Returns unsubscribe. */
  onStdoutLine(handler: (line: string) => void): () => void;
  /** Subscribe to stderr text chunks. */
  onStderr(handler: (chunk: string) => void): () => void;
  /** Process exit. */
  onExit(
    handler: (info: { exitCode: number | null; signal: string | null }) => void,
  ): () => void;
  /** Best-effort terminate. */
  kill(signal?: string): void;
  readonly pid: number | null;
  readonly exited: boolean;
};

export type SpawnEngine = (plan: {
  command: string;
  args: string[];
  shell: false;
  env: Record<string, string | undefined>;
  windowsHide: true;
}) => EngineProcessHandle;
