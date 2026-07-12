/**
 * Node.js host adapters for discovery, identity, and process spawn.
 * Used by tests and any Node-side runner; Tauri will mirror these in Rust.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiscoveryHost } from "./discovery";
import type { IdentityHost, SignatureIdentity } from "./identity";
import type { EngineProcessHandle, SpawnEngine } from "./acp/transport";
import type {
  SpawnTerminalProcess,
  TerminalProcessHandle,
} from "./terminal-bridge";
import { EXPECTED_PUBLISHER } from "./constants";
import { windowsAuthenticodeScript } from "./identity";
import { redactSecrets } from "./redact";

const execFileAsync = promisify(execFile);

export function createNodeDiscoveryHost(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): DiscoveryHost {
  return {
    platform,
    env,
    fileExists: (p) => existsSync(p),
    joinPath: (...parts) => join(...parts),
    which: async (command) => {
      try {
        const bin = platform === "win32" ? "where" : "which";
        const { stdout } = await execFileAsync(bin, [command], {
          env: env as NodeJS.ProcessEnv,
          timeout: 5_000,
        });
        const first = stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean);
        return first ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function createNodeIdentityHost(options?: {
  requireThumbprint?: boolean;
  minimumVersion?: string;
  /** When not win32, treat signature as skipped-valid for local dev. */
  allowUnsignedNonWindows?: boolean;
}): IdentityHost {
  const allowUnsigned = options?.allowUnsignedNonWindows ?? true;
  return {
    platform: process.platform,
    requireThumbprint: options?.requireThumbprint,
    minimumVersion: options?.minimumVersion,
    readVersion: async (enginePath) => {
      const { stdout, stderr } = await execFileAsync(
        enginePath,
        ["--version"],
        {
          timeout: 15_000,
          windowsHide: true,
        },
      );
      return `${stdout}\n${stderr}`;
    },
    readSignature: async (enginePath) => {
      if (process.platform !== "win32") {
        if (allowUnsigned) {
          return {
            valid: true,
            publisher: EXPECTED_PUBLISHER,
            detail: "Signature check skipped on non-Windows host",
          } satisfies SignatureIdentity;
        }
        return {
          valid: false,
          detail: "Authenticode verification requires Windows",
        };
      }
      return readWindowsAuthenticode(enginePath);
    },
  };
}

async function readWindowsAuthenticode(
  enginePath: string,
): Promise<SignatureIdentity> {
  const script = windowsAuthenticodeScript(enginePath);
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 30_000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout) as {
      Status?: string;
      Publisher?: string | null;
      Thumbprint?: string | null;
    };
    const status = parsed.Status ?? "";
    const valid = status === "Valid";
    return {
      valid,
      publisher: parsed.Publisher ?? undefined,
      thumbprint: parsed.Thumbprint ?? undefined,
      detail: valid ? undefined : `Authenticode status: ${status}`,
    };
  } catch (err) {
    return {
      valid: false,
      detail: redactSecrets(
        err instanceof Error ? err.message : String(err),
      ),
    };
  }
}

/**
 * Node process spawner for ACP terminal/* commands.
 * Kept out of the browser bundle (import only from Node/Tauri hosts).
 */
export function createNodeTerminalSpawner(): SpawnTerminalProcess {
  return ({ command, args, cwd, env, shell }) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handle: TerminalProcessHandle = {
      pid: child.pid ?? null,
      kill(signal?: string) {
        try {
          if (!child.killed) {
            child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM");
          }
        } catch {
          /* already dead */
        }
      },
      onStdout(handler) {
        child.stdout?.on("data", (buf: Buffer) =>
          handler(buf.toString("utf8")),
        );
      },
      onStderr(handler) {
        child.stderr?.on("data", (buf: Buffer) =>
          handler(buf.toString("utf8")),
        );
      },
      onExit(handler) {
        child.on("exit", (code, signal) => {
          handler({
            exitCode: code,
            signal: signal ?? null,
          });
        });
        child.on("error", () => {
          handler({
            exitCode: null,
            signal: null,
          });
        });
      },
    };
    return handle;
  };
}

export const nodeSpawnEngine: SpawnEngine = (plan) => {
  const child = spawn(plan.command, plan.args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: plan.windowsHide,
    env: plan.env as NodeJS.ProcessEnv,
  });

  let exited = false;
  const stdoutHandlers = new Set<(line: string) => void>();
  const stderrHandlers = new Set<(chunk: string) => void>();
  const exitHandlers = new Set<
    (info: { exitCode: number | null; signal: string | null }) => void
  >();

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    for (const h of stdoutHandlers) h(line);
  });
  child.stderr?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8");
    for (const h of stderrHandlers) h(text);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    const info = {
      exitCode: code,
      signal: signal ?? null,
    };
    for (const h of exitHandlers) h(info);
  });

  const handle: EngineProcessHandle = {
    get pid() {
      return child.pid ?? null;
    },
    get exited() {
      return exited;
    },
    write(line: string) {
      if (!child.stdin || child.stdin.destroyed) return;
      child.stdin.write(line.endsWith("\n") ? line : `${line}\n`);
    },
    onStdoutLine(handler) {
      stdoutHandlers.add(handler);
      return () => stdoutHandlers.delete(handler);
    },
    onStderr(handler) {
      stderrHandlers.add(handler);
      return () => stderrHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    kill(signal = "SIGTERM") {
      if (!exited) {
        try {
          child.kill(signal as NodeJS.Signals);
        } catch {
          /* ignore */
        }
      }
    },
  };

  return handle;
};
