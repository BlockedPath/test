/**
 * Plan a direct (no-shell) spawn of the Grok engine in ACP stdio mode.
 */

import { ENGINE_STDIO_ARGS } from "./constants";

export type SpawnPlan = {
  /** Absolute path to the engine binary. */
  command: string;
  /** Argv after the command (never includes a shell). */
  args: string[];
  /** Always false — shell intermediary is forbidden. */
  shell: false;
  windowsHide: true;
  env: Record<string, string | undefined>;
};

export type SpawnPlanOptions = {
  enginePath: string;
  /**
   * When true, append `--always-approve` after `agent` (YOLO / spike path).
   * Product code should leave this false unless the Session has YOLO on
   * *and* the host elects process-level bypass.
   */
  alwaysApprove?: boolean;
  /** Extra env overrides (never include API keys in logs). */
  env?: Record<string, string | undefined>;
  /** Base env (defaults to empty — caller supplies process.env). */
  baseEnv?: Record<string, string | undefined>;
};

/**
 * Build argv for `grok.exe --no-auto-update agent [ --always-approve ] stdio`.
 */
export function planEngineSpawn(options: SpawnPlanOptions): SpawnPlan {
  const args: string[] = [...ENGINE_STDIO_ARGS];
  if (options.alwaysApprove) {
    // Insert after "agent"
    const agentIdx = args.indexOf("agent");
    if (agentIdx >= 0) {
      args.splice(agentIdx + 1, 0, "--always-approve");
    } else {
      args.push("--always-approve");
    }
  }

  return {
    command: options.enginePath,
    args,
    shell: false,
    windowsHide: true,
    env: {
      ...(options.baseEnv ?? {}),
      ...(options.env ?? {}),
      // Keep child terminal-agnostic
      TERM: options.env?.TERM ?? options.baseEnv?.TERM ?? "dumb",
    },
  };
}

/** Assert plan never routes through a shell. */
export function assertDirectSpawn(plan: SpawnPlan): void {
  if (plan.shell !== false) {
    throw new Error("Engine must be launched without a shell intermediary");
  }
  const lower = plan.command.toLowerCase();
  if (
    lower.endsWith("cmd.exe") ||
    lower.endsWith("powershell.exe") ||
    lower.endsWith("pwsh.exe") ||
    lower.endsWith("/sh") ||
    lower.endsWith("/bash") ||
    lower.endsWith("/zsh")
  ) {
    throw new Error(
      "Engine command must be grok.exe (or equivalent), not a shell",
    );
  }
}
