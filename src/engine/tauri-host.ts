/**
 * Tauri-backed hosts for GrokAcpEngine (discovery, identity, spawn, cleanup).
 * Safe for the WebView2 bundle — uses invoke/listen only, no node: builtins.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DiscoveryHost } from "./discovery";
import type { IdentityHost, SignatureIdentity } from "./identity";
import { windowsAuthenticodeScript } from "./identity";
import type { EngineProcessHandle, SpawnEngine } from "./acp/transport";
import type {
  SpawnTerminalProcess,
  TerminalProcessHandle,
} from "./terminal-bridge";
import type { ProcessCleanupHost } from "./process-cleanup";
import { EXPECTED_PUBLISHER } from "./constants";
import { redactSecrets } from "./redact";

type StreamEvent = { id: number; text: string };
type ExitEvent = {
  id: number;
  exitCode: number | null;
  signal: string | null;
};
type SpawnResult = { id: number; pid: number };
type ExecResult = { stdout: string; stderr: string; exitCode: number };

/** Env keys the child actually needs — avoid shipping the full Windows env blob. */
const ENGINE_ENV_ALLOW = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "USERPROFILE",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PUBLIC",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "COMMONPROGRAMFILES",
  "GROK_EXE",
  "GROK_PATH",
  "GROK_VERSION",
  "XAI_API_KEY",
  "TERM",
  "LANG",
  "OS",
]);

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

function slimEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (ENGINE_ENV_ALLOW.has(k) || k.startsWith("GROK_") || k.startsWith("XAI_")) {
      out[k] = v;
    }
  }
  if (!out.TERM) out.TERM = "dumb";
  return out;
}

export async function createTauriDiscoveryHost(): Promise<DiscoveryHost> {
  const envMap = await invoke<Record<string, string>>("host_env");
  const env: Record<string, string | undefined> = { ...envMap };
  const platform =
    /windows/i.test(env.OS || "") || env.USERPROFILE
      ? "win32"
      : "win32";

  return {
    platform,
    env,
    fileExists: (p) => invoke<boolean>("host_path_exists", { path: p }),
    joinPath: (...parts) => {
      // Windows join without collapsing drive prefixes (C:\ + .grok → C:\.grok).
      if (platform === "win32") {
        return parts
          .filter((p) => p.length > 0)
          .map((p, i) =>
            i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, ""),
          )
          .join("\\");
      }
      return parts
        .filter((p) => p.length > 0)
        .map((p, i) =>
          i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""),
        )
        .join("/");
    },
    which: (command) => invoke<string | null>("host_which", { command }),
  };
}

export function createTauriIdentityHost(): IdentityHost {
  return {
    platform: "win32",
    readVersion: async (enginePath) => {
      const result = await invoke<ExecResult>("host_exec", {
        program: enginePath,
        args: ["--version"],
        cwd: null,
      });
      return `${result.stdout}\n${result.stderr}`;
    },
    readSignature: async (enginePath) => {
      const script = windowsAuthenticodeScript(enginePath);
      try {
        const result = await invoke<ExecResult>("host_exec", {
          program: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", script],
          cwd: null,
        });
        const text = (result.stdout || "").replace(/^\uFEFF/, "").trim();
        const parsed = JSON.parse(text) as {
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
        } satisfies SignatureIdentity;
      } catch (err) {
        return {
          valid: false,
          detail: redactSecrets(
            err instanceof Error ? err.message : String(err),
          ),
        };
      }
    },
  };
}

/**
 * Engine process handle with:
 * 1. Event listeners registered *before* spawn (no lost lines)
 * 2. Serialized writes (no reordered JSON-RPC)
 * 3. Write queue until the process id is known
 */
function createStreamingHandle(
  spawn: () => Promise<SpawnResult>,
): EngineProcessHandle {
  let id: number | null = null;
  let pid: number | null = null;
  let exited = false;
  let spawnError: Error | null = null;

  const stdoutHandlers = new Set<(line: string) => void>();
  const stderrHandlers = new Set<(chunk: string) => void>();
  const exitHandlers = new Set<
    (info: { exitCode: number | null; signal: string | null }) => void
  >();
  const unlisteners: UnlistenFn[] = [];

  /** Single-flight chain so writes stay in order. */
  let gate: Promise<void> = Promise.resolve();

  const ready: Promise<void> = (async () => {
    // Listen first so early stdout is never dropped.
    unlisteners.push(
      await listen<StreamEvent>("engine-stdout", (event) => {
        if (id == null || event.payload.id !== id) return;
        for (const h of stdoutHandlers) h(event.payload.text);
      }),
    );
    unlisteners.push(
      await listen<StreamEvent>("engine-stderr", (event) => {
        if (id == null || event.payload.id !== id) return;
        for (const h of stderrHandlers) h(event.payload.text);
      }),
    );
    unlisteners.push(
      await listen<ExitEvent>("engine-exit", (event) => {
        if (id == null || event.payload.id !== id) return;
        exited = true;
        for (const h of exitHandlers) {
          h({
            exitCode: event.payload.exitCode ?? null,
            signal: event.payload.signal ?? null,
          });
        }
        for (const u of unlisteners) void u();
      }),
    );

    try {
      const result = await spawn();
      id = result.id;
      pid = result.pid;
    } catch (err) {
      spawnError =
        err instanceof Error ? err : new Error(String(err));
      exited = true;
      const msg = spawnError.message;
      for (const h of stderrHandlers) h(msg);
      for (const h of exitHandlers) {
        h({ exitCode: null, signal: null });
      }
      throw spawnError;
    }
  })();

  // Kick the chain so spawn starts immediately.
  gate = ready.catch(() => {
    /* surfaced on write / exit handlers */
  });

  const enqueueWrite = (line: string): void => {
    gate = gate
      .then(async () => {
        await ready;
        const err = spawnError;
        if (err) throw err;
        if (id == null || exited) {
          throw new Error("Engine process is not available for write");
        }
        await invoke("engine_write", { id, line });
      })
      .catch((err: unknown) => {
        // Keep chain alive for subsequent writes, but surface via stderr.
        const msg = err instanceof Error ? err.message : String(err);
        for (const h of stderrHandlers) h(`[engine_write] ${msg}`);
      });
  };

  return {
    get pid() {
      return pid;
    },
    get exited() {
      return exited;
    },
    write(line: string) {
      enqueueWrite(line);
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
    kill() {
      gate = gate.then(async () => {
        try {
          await ready;
        } catch {
          return;
        }
        if (id == null) return;
        await invoke("engine_kill", { id });
      });
    },
  };
}

export async function createTauriSpawnEngine(): Promise<SpawnEngine> {
  return (plan) => {
    const env = slimEnv(plan.env ?? {});
    return createStreamingHandle(() =>
      invoke<SpawnResult>("engine_spawn", {
        command: plan.command,
        args: plan.args,
        env,
      }),
    );
  };
}

export function createTauriTerminalSpawner(): SpawnTerminalProcess {
  return ({ command, args, cwd, env, shell }) => {
    const envMap = slimEnv((env ?? {}) as Record<string, string | undefined>);
    let id: number | null = null;
    let pid: number | null = null;
    let exited = false;
    const unlisteners: UnlistenFn[] = [];
    const stdoutHandlers = new Set<(chunk: string) => void>();
    const stderrHandlers = new Set<(chunk: string) => void>();
    const exitHandlers = new Set<
      (info: { exitCode: number | null; signal: string | null }) => void
    >();

    const boot = (async () => {
      unlisteners.push(
        await listen<StreamEvent>("engine-stdout", (event) => {
          if (id == null || event.payload.id !== id) return;
          for (const h of stdoutHandlers) h(event.payload.text + "\n");
        }),
      );
      unlisteners.push(
        await listen<StreamEvent>("engine-stderr", (event) => {
          if (id == null || event.payload.id !== id) return;
          for (const h of stderrHandlers) h(event.payload.text);
        }),
      );
      unlisteners.push(
        await listen<ExitEvent>("engine-exit", (event) => {
          if (id == null || event.payload.id !== id) return;
          exited = true;
          for (const h of exitHandlers) {
            h({
              exitCode: event.payload.exitCode ?? null,
              signal: event.payload.signal ?? null,
            });
          }
          for (const u of unlisteners) void u();
        }),
      );

      const result = await invoke<SpawnResult>("terminal_spawn", {
        command,
        args,
        cwd: cwd ?? null,
        env: envMap,
        shell: Boolean(shell),
      });
      id = result.id;
      pid = result.pid;
    })().catch((err) => {
      exited = true;
      const msg = err instanceof Error ? err.message : String(err);
      for (const h of stderrHandlers) h(msg);
      for (const h of exitHandlers) h({ exitCode: null, signal: null });
    });

    void boot;

    const handle: TerminalProcessHandle = {
      get pid() {
        return pid;
      },
      kill() {
        void boot.then(() => {
          if (id != null && !exited) void invoke("engine_kill", { id });
        });
      },
      onStdout(handler) {
        stdoutHandlers.add(handler);
      },
      onStderr(handler) {
        stderrHandlers.add(handler);
      },
      onExit(handler) {
        exitHandlers.add(handler);
      },
    };
    return handle;
  };
}

export function createTauriProcessCleanupHost(): ProcessCleanupHost {
  return {
    platform: "win32",
    async killTree(pid) {
      try {
        const ok = await invoke<boolean>("host_taskkill", { pid });
        return {
          ok,
          detail: ok
            ? `taskkill /T /F applied to pid ${pid}`
            : `taskkill reported failure for pid ${pid}`,
        };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export const TAURI_EXPECTED_PUBLISHER = EXPECTED_PUBLISHER;
