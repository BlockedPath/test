import { describe, expect, it, vi } from "vitest";
import {
  TerminalBridge,
  type SpawnTerminalProcess,
  type TerminalProcessHandle,
} from "./terminal-bridge";

function createFakeSpawner(options?: {
  output?: string;
  exitCode?: number;
  signal?: string | null;
  hang?: boolean;
  failSpawn?: boolean;
}): {
  spawn: SpawnTerminalProcess;
  kills: string[];
  lastOpts: {
    command: string;
    args: string[];
    cwd?: string;
    shell: boolean;
  } | null;
} {
  const kills: string[] = [];
  let lastOpts: {
    command: string;
    args: string[];
    cwd?: string;
    shell: boolean;
  } | null = null;

  const spawn: SpawnTerminalProcess = (opts) => {
    lastOpts = {
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      shell: opts.shell,
    };
    if (options?.failSpawn) {
      throw new Error("spawn failed: ENOENT");
    }

    let exitHandler: ((s: { exitCode: number | null; signal: string | null }) => void) | null =
      null;
    let stdoutHandler: ((c: string) => void) | null = null;
    let stderrHandler: ((c: string) => void) | null = null;
    let killed = false;

    const handle: TerminalProcessHandle = {
      pid: 999,
      kill(signal) {
        kills.push(signal ?? "SIGTERM");
        if (killed) return;
        killed = true;
        queueMicrotask(() => {
          exitHandler?.({
            exitCode: null,
            signal: signal ?? "SIGTERM",
          });
        });
      },
      onStdout(h) {
        stdoutHandler = h;
      },
      onStderr(h) {
        stderrHandler = h;
      },
      onExit(h) {
        exitHandler = h;
        if (!options?.hang) {
          queueMicrotask(() => {
            if (killed) return;
            stdoutHandler?.(options?.output ?? "ok\n");
            stderrHandler?.("");
            exitHandler?.({
              exitCode: options?.exitCode ?? 0,
              signal: options?.signal ?? null,
            });
          });
        }
      },
    };
    return handle;
  };

  return { spawn, kills, get lastOpts() { return lastOpts; } };
}

function hooksRecorder() {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    events,
    hooks: {
      onStarted: (p: unknown) => events.push({ type: "started", payload: p }),
      onOutput: (p: unknown) => events.push({ type: "output", payload: p }),
      onExited: (p: unknown) => events.push({ type: "exited", payload: p }),
      onKilled: (p: unknown) => events.push({ type: "killed", payload: p }),
      onReleased: (p: unknown) => events.push({ type: "released", payload: p }),
      onFailure: (p: unknown) => events.push({ type: "failure", payload: p }),
    },
  };
}

describe("TerminalBridge", () => {
  it("runs a successful command with live output and exit code 0", async () => {
    const { spawn } = createFakeSpawner({ output: "SPIKE_TERM_OK\n", exitCode: 0 });
    const rec = hooksRecorder();
    const bridge = new TerminalBridge({
      spawnProcess: spawn,
      hooks: rec.hooks,
      defaultCwd: "/proj",
    });

    const { terminalId } = bridge.create({
      command: "echo",
      args: ["SPIKE_TERM_OK"],
      cwd: "/proj",
    });

    const exit = await bridge.waitForExit(terminalId);
    expect(exit.exitCode).toBe(0);
    const out = bridge.output(terminalId);
    expect(out.output).toContain("SPIKE_TERM_OK");
    expect(out.exitStatus?.exitCode).toBe(0);

    expect(rec.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["started", "output", "exited"]),
    );
    bridge.release(terminalId);
    expect(bridge.get(terminalId)?.status).toBe("released");
    // Output remains after release
    expect(bridge.get(terminalId)?.output).toContain("SPIKE_TERM_OK");
  });

  it("records nonzero exits as command failures", async () => {
    const { spawn } = createFakeSpawner({ output: "boom\n", exitCode: 2 });
    const rec = hooksRecorder();
    const bridge = new TerminalBridge({
      spawnProcess: spawn,
      hooks: rec.hooks,
    });

    const { terminalId } = bridge.create({
      command: "false",
      args: [],
    });
    const exit = await bridge.waitForExit(terminalId);
    expect(exit.exitCode).toBe(2);
    const exited = rec.events.find((e) => e.type === "exited");
    expect(exited?.payload).toMatchObject({ exitCode: 2 });
  });

  it("rejects malformed terminal/create without a command", () => {
    const rec = hooksRecorder();
    const bridge = new TerminalBridge({
      spawnProcess: createFakeSpawner().spawn,
      hooks: rec.hooks,
    });
    expect(() =>
      bridge.create({ command: "" as unknown as string }),
    ).toThrow(/command/i);
    expect(rec.events.some((e) => e.type === "failure")).toBe(true);
  });

  it("rejects output/wait for unknown terminal ids", async () => {
    const rec = hooksRecorder();
    const bridge = new TerminalBridge({
      spawnProcess: createFakeSpawner().spawn,
      hooks: rec.hooks,
    });
    expect(() => bridge.output("missing")).toThrow(/Unknown or released/);
    await expect(bridge.waitForExit("missing")).rejects.toThrow(
      /Unknown or released/,
    );
  });

  it("kills running commands and cleans up on killAll/disposeAll", async () => {
    const fake = createFakeSpawner({ hang: true });
    const rec = hooksRecorder();
    const bridge = new TerminalBridge({
      spawnProcess: fake.spawn,
      hooks: rec.hooks,
    });

    const a = bridge.create({ command: "sleep", args: ["30"] });
    const b = bridge.create({ command: "sleep", args: ["30"] });
    expect(bridge.activeCount).toBe(2);

    bridge.kill(a.terminalId, "user");
    await vi.waitFor(() => {
      expect(bridge.get(a.terminalId)?.status).toBe("killed");
    });
    expect(fake.kills.length).toBeGreaterThan(0);

    bridge.killAll("emergency_stop");
    bridge.disposeAll();
    expect(bridge.activeCount).toBe(0);
    expect(bridge.get(b.terminalId)).toBeUndefined();
  });

  it("uses shell for free-form command lines without args", () => {
    const fake = createFakeSpawner({ hang: true });
    const rec = hooksRecorder();
    const bridge = new TerminalBridge({
      spawnProcess: fake.spawn,
      hooks: rec.hooks,
    });
    bridge.create({ command: "echo SPIKE_TERM_OK" });
    expect(fake.lastOpts?.shell).toBe(true);
    expect(fake.lastOpts?.args).toEqual([]);

    bridge.create({ command: "echo", args: ["hi"] });
    expect(fake.lastOpts?.shell).toBe(false);
    bridge.disposeAll();
  });

  it("surfaces spawn failures without leaving a hanging waiter", async () => {
    const { spawn } = createFakeSpawner({ failSpawn: true });
    const rec = hooksRecorder();
    const bridge = new TerminalBridge({
      spawnProcess: spawn,
      hooks: rec.hooks,
    });
    const { terminalId } = bridge.create({ command: "missing-bin", args: [] });
    const exit = await bridge.waitForExit(terminalId);
    expect(exit.exitCode).toBe(1);
    expect(rec.events.some((e) => e.type === "failure")).toBe(true);
    expect(rec.events.some((e) => e.type === "exited")).toBe(true);
  });
});
