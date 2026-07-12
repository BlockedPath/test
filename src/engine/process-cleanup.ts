/**
 * Best-effort process-tree cleanup for Emergency Stop.
 * Windows uses taskkill /T /F; POSIX tries process-group then SIGKILL.
 * Incomplete cleanup is reported — never claimed as silent rollback.
 */

export type CleanupStatus = "clean" | "incomplete" | "orphans_possible";

export type ProcessTreeCleanupResult = {
  status: CleanupStatus;
  detail: string;
  /** PIDs that may still be alive after best-effort kill. */
  orphanPids: number[];
  rootPid: number | null;
};

export type ProcessCleanupHost = {
  platform: NodeJS.Platform | string;
  /**
   * Kill a process tree. Implementations may use taskkill, kill(-pgid), etc.
   * Return true when the kill command itself succeeded.
   */
  killTree: (pid: number) => Promise<{ ok: boolean; detail?: string }>;
  /** Probe whether a PID appears alive. Best-effort; false negatives possible. */
  isAlive?: (pid: number) => Promise<boolean>;
};

/**
 * Escalate termination of `rootPid` and descendants.
 * Always returns a structured result the UI can surface.
 */
export async function killProcessTree(
  rootPid: number | null | undefined,
  host: ProcessCleanupHost,
): Promise<ProcessTreeCleanupResult> {
  if (rootPid == null || !Number.isFinite(rootPid) || rootPid <= 0) {
    return {
      status: "clean",
      detail: "No engine process pid to clean up",
      orphanPids: [],
      rootPid: null,
    };
  }

  let killOk = false;
  let killDetail = "";
  try {
    const result = await host.killTree(rootPid);
    killOk = result.ok;
    killDetail = result.detail ?? "";
  } catch (err) {
    killOk = false;
    killDetail = err instanceof Error ? err.message : String(err);
  }

  const orphans: number[] = [];
  if (host.isAlive) {
    try {
      if (await host.isAlive(rootPid)) {
        orphans.push(rootPid);
      }
    } catch {
      // Probe failure → treat as possible orphan when kill failed.
      if (!killOk) orphans.push(rootPid);
    }
  }

  if (orphans.length > 0) {
    return {
      status: "orphans_possible",
      detail:
        killDetail ||
        `Process tree cleanup incomplete; possible orphan pid(s): ${orphans.join(", ")}`,
      orphanPids: orphans,
      rootPid,
    };
  }

  if (!killOk) {
    // Kill failed and we could not confirm a live orphan → incomplete.
    return {
      status: "incomplete",
      detail:
        killDetail ||
        `Process tree cleanup could not be confirmed for pid ${rootPid}`,
      orphanPids: [],
      rootPid,
    };
  }

  return {
    status: "clean",
    detail:
      killDetail ||
      (host.platform === "win32"
        ? `Terminated process tree via taskkill (pid ${rootPid})`
        : `Terminated process tree (pid ${rootPid})`),
    orphanPids: [],
    rootPid,
  };
}

/**
 * Build a Node-oriented cleanup host. Injectable for tests; production
 * uses taskkill on Windows and SIGTERM/SIGKILL on POSIX.
 */
export function createNodeProcessCleanupHost(options?: {
  platform?: NodeJS.Platform | string;
  execFile?: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string }>;
  kill?: (pid: number, signal?: string) => void;
}): ProcessCleanupHost {
  const platform = options?.platform ?? process.platform;
  const execFile = options?.execFile;
  const nodeKill = options?.kill ?? ((pid, signal) => process.kill(pid, signal as NodeJS.Signals));

  return {
    platform,
    async killTree(pid) {
      if (platform === "win32") {
        if (!execFile) {
          return {
            ok: false,
            detail: "Windows process-tree kill requires execFile (taskkill)",
          };
        }
        try {
          await execFile("taskkill", ["/PID", String(pid), "/T", "/F"]);
          return {
            ok: true,
            detail: `taskkill /T /F applied to pid ${pid}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // taskkill exit 128 often means process already gone — treat as clean.
          if (/not found|no running|exit code 128|ERROR: The process/i.test(msg)) {
            return { ok: true, detail: `Process ${pid} already exited` };
          }
          return { ok: false, detail: msg };
        }
      }

      // POSIX: try direct kill; process-group when pid is group leader.
      try {
        nodeKill(pid, "SIGTERM");
      } catch {
        /* ESRCH */
      }
      try {
        nodeKill(-pid, "SIGTERM");
      } catch {
        /* not a group leader / ESRCH */
      }
      try {
        nodeKill(pid, "SIGKILL");
      } catch {
        /* ESRCH */
      }
      try {
        nodeKill(-pid, "SIGKILL");
      } catch {
        /* ESRCH */
      }
      return {
        ok: true,
        detail: `POSIX SIGTERM/SIGKILL applied to pid ${pid} (and group if applicable)`,
      };
    },
    async isAlive(pid) {
      try {
        // signal 0 = existence check
        nodeKill(pid, 0 as unknown as string);
        return true;
      } catch {
        return false;
      }
    },
  };
}
