/**
 * Client-side ACP terminal/* implementation (framework-independent).
 * Spawns via an injected process factory — no Node imports here so the
 * frontend bundle can load types/engine code without child_process.
 */

import { redactSecrets } from "./redact";

export type TerminalEnvVar = { name: string; value: string };

export type TerminalCreateRequest = {
  sessionId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: TerminalEnvVar[];
  outputByteLimit?: number;
  /** Optional correlation when known from a tool call. */
  toolCallId?: string;
};

export type TerminalExitStatus = {
  exitCode: number | null;
  signal: string | null;
};

export type TerminalOutputSnapshot = {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus;
};

export type TerminalProcessHandle = {
  kill(signal?: string): void;
  onStdout(handler: (chunk: string) => void): void;
  onStderr(handler: (chunk: string) => void): void;
  onExit(handler: (status: TerminalExitStatus) => void): void;
  readonly pid: number | null;
};

export type SpawnTerminalProcess = (options: {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  /** When true, run via platform shell (for free-form command lines). */
  shell: boolean;
}) => TerminalProcessHandle;

export type TerminalBridgeHooks = {
  onStarted: (info: {
    terminalId: string;
    toolCallId?: string;
    command: string;
    args?: string[];
    cwd?: string;
  }) => void;
  onOutput: (info: {
    terminalId: string;
    chunk: string;
    snapshot: string;
    truncated: boolean;
  }) => void;
  onExited: (info: {
    terminalId: string;
    exitCode: number | null;
    signal: string | null;
  }) => void;
  onKilled: (info: {
    terminalId: string;
    reason: "user" | "agent" | "timeout" | "emergency_stop";
  }) => void;
  onReleased: (info: { terminalId: string }) => void;
  onFailure: (info: {
    terminalId?: string;
    code: string;
    message: string;
  }) => void;
};

type ManagedTerminal = {
  terminalId: string;
  toolCallId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null;
  signal: string | null;
  status: "running" | "exited" | "killed" | "released";
  proc: TerminalProcessHandle | null;
  waiters: Array<(status: TerminalExitStatus) => void>;
  killReason?: "user" | "agent" | "timeout" | "emergency_stop";
};

const DEFAULT_OUTPUT_LIMIT = 1_048_576;

/** Placeholder spawner for environments without a process host (browser UI). */
export function unavailableTerminalSpawner(): SpawnTerminalProcess {
  return () => {
    throw new Error(
      "Terminal process spawner not configured (Node/Tauri host required)",
    );
  };
}

/**
 * Manages in-process terminals for ACP terminal/* client methods.
 */
export class TerminalBridge {
  private terminals = new Map<string, ManagedTerminal>();
  private seq = 0;
  private readonly spawnProcess: SpawnTerminalProcess;
  private readonly hooks: TerminalBridgeHooks;
  private readonly baseEnv: NodeJS.ProcessEnv;
  private readonly defaultCwd: string;

  constructor(options: {
    spawnProcess?: SpawnTerminalProcess;
    hooks: TerminalBridgeHooks;
    baseEnv?: NodeJS.ProcessEnv;
    defaultCwd?: string;
  }) {
    this.spawnProcess =
      options.spawnProcess ?? unavailableTerminalSpawner();
    this.hooks = options.hooks;
    this.baseEnv = options.baseEnv ?? {};
    this.defaultCwd = options.defaultCwd ?? ".";
  }

  /** Number of non-released terminals (for cleanup tests). */
  get activeCount(): number {
    let n = 0;
    for (const t of this.terminals.values()) {
      if (t.status !== "released") n += 1;
    }
    return n;
  }

  get(terminalId: string): ManagedTerminal | undefined {
    return this.terminals.get(terminalId);
  }

  create(params: TerminalCreateRequest): { terminalId: string } {
    if (!params.command || typeof params.command !== "string") {
      this.hooks.onFailure({
        code: "terminal_malformed",
        message: "terminal/create requires a command string",
      });
      throw Object.assign(new Error("terminal/create requires a command string"), {
        code: -32602,
      });
    }

    this.seq += 1;
    const terminalId = `term-${this.seq}`;
    const args = params.args ?? [];
    const cwd = params.cwd || this.defaultCwd;
    const limit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT;
    // Free-form command lines (no argv) need a shell; structured argv does not.
    const shell = args.length === 0;

    const env: NodeJS.ProcessEnv = { ...this.baseEnv };
    if (params.env) {
      for (const { name, value } of params.env) {
        if (name) env[name] = value;
      }
    }

    const managed: ManagedTerminal = {
      terminalId,
      toolCallId: params.toolCallId,
      command: params.command,
      args: args.length ? args : undefined,
      cwd,
      output: "",
      truncated: false,
      outputByteLimit: limit,
      exitCode: null,
      signal: null,
      status: "running",
      proc: null,
      waiters: [],
    };
    this.terminals.set(terminalId, managed);

    this.hooks.onStarted({
      terminalId,
      toolCallId: params.toolCallId,
      command: params.command,
      args: managed.args,
      cwd,
    });

    try {
      const proc = this.spawnProcess({
        command: params.command,
        args,
        cwd,
        env,
        shell,
      });
      managed.proc = proc;

      const append = (chunk: string) => {
        if (managed.status === "released") return;
        const safe = redactSecrets(chunk);
        this.appendOutput(managed, safe);
        this.hooks.onOutput({
          terminalId,
          chunk: safe,
          snapshot: managed.output,
          truncated: managed.truncated,
        });
      };

      proc.onStdout(append);
      proc.onStderr(append);
      proc.onExit((status) => {
        if (managed.status === "released") return;
        managed.exitCode = status.exitCode;
        managed.signal = status.signal;
        if (managed.status === "running") {
          managed.status = "exited";
        }
        this.hooks.onExited({
          terminalId,
          exitCode: status.exitCode,
          signal: status.signal,
        });
        const waiters = managed.waiters;
        managed.waiters = [];
        for (const w of waiters) w(status);
      });
    } catch (err) {
      managed.status = "exited";
      managed.exitCode = 1;
      const message =
        err instanceof Error ? err.message : "Failed to spawn terminal command";
      this.appendOutput(managed, redactSecrets(message) + "\n");
      this.hooks.onFailure({
        terminalId,
        code: "terminal_spawn_failed",
        message,
      });
      this.hooks.onExited({
        terminalId,
        exitCode: 1,
        signal: null,
      });
      const waiters = managed.waiters;
      managed.waiters = [];
      for (const w of waiters) w({ exitCode: 1, signal: null });
    }

    return { terminalId };
  }

  output(terminalId: string): TerminalOutputSnapshot {
    const t = this.requireTerminal(terminalId, "terminal/output");
    const snap: TerminalOutputSnapshot = {
      output: t.output,
      truncated: t.truncated,
    };
    if (t.status !== "running") {
      snap.exitStatus = {
        exitCode: t.exitCode,
        signal: t.signal,
      };
    }
    return snap;
  }

  async waitForExit(terminalId: string): Promise<TerminalExitStatus> {
    const t = this.requireTerminal(terminalId, "terminal/wait_for_exit");
    if (t.status !== "running") {
      return { exitCode: t.exitCode, signal: t.signal };
    }
    return new Promise((resolve) => {
      t.waiters.push(resolve);
    });
  }

  kill(
    terminalId: string,
    reason: "user" | "agent" | "timeout" | "emergency_stop" = "agent",
  ): Record<string, never> {
    const t = this.requireTerminal(terminalId, "terminal/kill");
    if (t.status === "running") {
      t.killReason = reason;
      t.status = "killed";
      t.proc?.kill("SIGTERM");
      this.hooks.onKilled({ terminalId, reason });
    }
    return {};
  }

  release(terminalId: string): Record<string, never> {
    const t = this.terminals.get(terminalId);
    if (!t) {
      // Idempotent: already gone
      return {};
    }
    if (t.status === "running") {
      t.killReason = "agent";
      t.status = "killed";
      t.proc?.kill("SIGTERM");
      this.hooks.onKilled({ terminalId, reason: "agent" });
    }
    t.status = "released";
    t.proc = null;
    const waiters = t.waiters;
    t.waiters = [];
    for (const w of waiters) {
      w({ exitCode: t.exitCode, signal: t.signal ?? "SIGTERM" });
    }
    this.hooks.onReleased({ terminalId });
    return {};
  }

  /** Kill every running terminal (cancel / emergency stop / dispose). */
  killAll(reason: "user" | "agent" | "timeout" | "emergency_stop"): void {
    for (const t of this.terminals.values()) {
      if (t.status === "running") {
        this.kill(t.terminalId, reason);
      }
    }
  }

  /** Release all terminals and drop handles. */
  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) {
      this.release(id);
    }
    this.terminals.clear();
  }

  private requireTerminal(terminalId: string, method: string): ManagedTerminal {
    if (!terminalId || typeof terminalId !== "string") {
      this.hooks.onFailure({
        code: "terminal_malformed",
        message: `${method} requires terminalId`,
      });
      throw Object.assign(new Error(`${method} requires terminalId`), {
        code: -32602,
      });
    }
    const t = this.terminals.get(terminalId);
    if (!t || t.status === "released") {
      this.hooks.onFailure({
        terminalId,
        code: "terminal_not_found",
        message: `Unknown or released terminal ${terminalId}`,
      });
      throw Object.assign(
        new Error(`Unknown or released terminal ${terminalId}`),
        { code: -32000 },
      );
    }
    return t;
  }

  private appendOutput(t: ManagedTerminal, chunk: string): void {
    t.output += chunk;
    const bytes = Buffer.byteLength(t.output, "utf8");
    if (bytes > t.outputByteLimit) {
      t.truncated = true;
      // Truncate from the start at a character boundary.
      let drop = bytes - t.outputByteLimit;
      let i = 0;
      while (drop > 0 && i < t.output.length) {
        const code = t.output.charCodeAt(i);
        // Approximate UTF-16 code units; good enough for console output.
        drop -= code > 0x7f ? 2 : 1;
        i += 1;
      }
      t.output = t.output.slice(i);
    }
  }
}
