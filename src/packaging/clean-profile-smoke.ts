/**
 * Clean Windows user-profile smoke scenario definitions.
 *
 * Live install/auth/session steps require a real Windows profile and NSIS artifact.
 * On WSL/Linux these scenarios are unit-tested as pure plans — never reported as passed live.
 */

import { PINNED_ENGINE_VERSION } from "../engine/constants";
import type { EngineReadinessFailureCode } from "./engine-readiness";

export type SmokeStepId =
  | "nsis_current_user_install"
  | "webview2_bootstrap"
  | "engine_discover_or_acquire"
  | "engine_verify_pin"
  | "cli_owned_auth"
  | "project_open"
  | "first_session_start";

export type SmokeStepPlan = {
  id: SmokeStepId;
  title: string;
  requiresNativeWindows: boolean;
  requiresNsisArtifact: boolean;
  requiresNetwork: boolean;
  passCriteria: string;
};

/** Ordered personal v1 clean-profile path from issue #18 / packaging tests. */
export const CLEAN_PROFILE_SMOKE_STEPS: SmokeStepPlan[] = [
  {
    id: "nsis_current_user_install",
    title: "Install current-user NSIS setup without Administrator",
    requiresNativeWindows: true,
    requiresNsisArtifact: true,
    requiresNetwork: false,
    passCriteria:
      "App launches from %LOCALAPPDATA% after -setup.exe with installMode currentUser; no UAC elevation required.",
  },
  {
    id: "webview2_bootstrap",
    title: "WebView2 present or bootstrapper path",
    requiresNativeWindows: true,
    requiresNsisArtifact: false,
    requiresNetwork: true,
    passCriteria:
      "When runtime is present, bootstrap is skipped; when missing, downloadBootstrapper runs and the shell can open.",
  },
  {
    id: "engine_discover_or_acquire",
    title: "Discover or acquire pinned official engine",
    requiresNativeWindows: true,
    requiresNsisArtifact: false,
    requiresNetwork: true,
    passCriteria: `Pinned CLI ${PINNED_ENGINE_VERSION}+ is found under the user profile or acquired via official channel; never embedded in the GUI package.`,
  },
  {
    id: "engine_verify_pin",
    title: "Verify publisher, signature, version, architecture",
    requiresNativeWindows: true,
    requiresNsisArtifact: false,
    requiresNetwork: false,
    passCriteria:
      "Authenticode valid + X.AI LLC publisher + version meets pin + matching PE architecture.",
  },
  {
    id: "cli_owned_auth",
    title: "CLI-owned authentication",
    requiresNativeWindows: true,
    requiresNsisArtifact: false,
    requiresNetwork: true,
    passCriteria:
      "Auth completes through documented browser/device/API-key flow; GUI never scrapes tokens.",
  },
  {
    id: "project_open",
    title: "Open a Project folder",
    requiresNativeWindows: true,
    requiresNsisArtifact: false,
    requiresNetwork: false,
    passCriteria: "One local Project is selected and trust summary can be shown.",
  },
  {
    id: "first_session_start",
    title: "First Session startup",
    requiresNativeWindows: true,
    requiresNsisArtifact: false,
    requiresNetwork: true,
    passCriteria:
      "Session reaches idle/running via AgentEnginePort with engine version recorded; no silent engine drift.",
  },
];

export type FailureScenarioId =
  | "missing"
  | "stale"
  | "wrong_architecture"
  | "unsigned"
  | "network_unavailable";

export type FailureScenarioPlan = {
  id: FailureScenarioId;
  expectedCode: EngineReadinessFailureCode;
  description: string;
  mustBeActionable: true;
};

/** Failure matrix from packaging acceptance criteria. */
export const ENGINE_FAILURE_SCENARIOS: FailureScenarioPlan[] = [
  {
    id: "missing",
    expectedCode: "engine_missing",
    description: "No grok.exe on a clean profile",
    mustBeActionable: true,
  },
  {
    id: "stale",
    expectedCode: "engine_stale",
    description: "Installed CLI below pin",
    mustBeActionable: true,
  },
  {
    id: "wrong_architecture",
    expectedCode: "wrong_architecture",
    description: "arm64 binary on x64 host (or reverse)",
    mustBeActionable: true,
  },
  {
    id: "unsigned",
    expectedCode: "unsigned",
    description: "Missing or invalid Authenticode",
    mustBeActionable: true,
  },
  {
    id: "network_unavailable",
    expectedCode: "network_unavailable",
    description: "Official acquisition cannot reach the network",
    mustBeActionable: true,
  },
];

export type HostEnvironmentKind =
  | "native_windows"
  | "wsl"
  | "linux"
  | "darwin"
  | "unknown";

export function classifyHostEnvironment(input: {
  platform: string;
  /** Contents of /proc/version, WSL_DISTRO_NAME, or similar. Pure — no process.env reads. */
  wslIndicator?: string | null;
}): HostEnvironmentKind {
  if (input.platform === "win32") return "native_windows";
  const wsl = (input.wslIndicator ?? "").toLowerCase();
  if (
    input.platform === "linux" &&
    (wsl.includes("microsoft") || wsl.includes("wsl") || wsl.includes("wsl_distro"))
  ) {
    return "wsl";
  }
  if (input.platform === "linux") return "linux";
  if (input.platform === "darwin") return "darwin";
  return "unknown";
}

/** Build wslIndicator from the real process (for runners, not unit tests). */
export function detectWslIndicator(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WSL_DISTRO_NAME) return `wsl_distro:${env.WSL_DISTRO_NAME}`;
  try {
    // Lazy: callers on Linux can pass /proc/version themselves
    return env.WSL_INTEROP ? "wsl_interop" : "";
  } catch {
    return "";
  }
}

export type SmokeRunDecision =
  | {
      mode: "live";
      environment: "native_windows";
      steps: SmokeStepPlan[];
    }
  | {
      mode: "plan_only";
      environment: HostEnvironmentKind;
      reason: string;
      steps: SmokeStepPlan[];
    };

/**
 * Decide whether live clean-profile steps may run.
 * Never claims a live Windows install pass on WSL/Linux.
 */
export function planCleanProfileSmoke(input: {
  platform: string;
  wslIndicator?: string | null;
  nsisArtifactPath?: string | null;
}): SmokeRunDecision {
  const environment = classifyHostEnvironment(input);
  if (environment === "native_windows") {
    return {
      mode: "live",
      environment: "native_windows",
      steps: CLEAN_PROFILE_SMOKE_STEPS,
    };
  }
  return {
    mode: "plan_only",
    environment,
    reason:
      `Clean-profile NSIS install/auth/session smoke requires native Windows. ` +
      `Current host is ${environment}; refusing to fake live packaging results.`,
    steps: CLEAN_PROFILE_SMOKE_STEPS,
  };
}

export type SimulatedStepResult =
  | { id: SmokeStepId; status: "passed"; detail: string }
  | { id: SmokeStepId; status: "failed"; detail: string }
  | { id: SmokeStepId; status: "skipped"; detail: string };

/**
 * Map a plan-only host to skipped live steps (honest non-pass).
 */
export function skipLiveStepsOnNonWindows(
  decision: SmokeRunDecision,
): SimulatedStepResult[] {
  if (decision.mode === "live") {
    return decision.steps.map((s) => ({
      id: s.id,
      status: "skipped" as const,
      detail:
        "Live runner must execute this step on native Windows (not auto-passed).",
    }));
  }
  return decision.steps.map((s) => ({
    id: s.id,
    status: "skipped" as const,
    detail: decision.reason,
  }));
}
