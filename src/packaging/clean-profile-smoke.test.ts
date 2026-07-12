import { describe, expect, it } from "vitest";
import {
  CLEAN_PROFILE_SMOKE_STEPS,
  ENGINE_FAILURE_SCENARIOS,
  classifyHostEnvironment,
  planCleanProfileSmoke,
  skipLiveStepsOnNonWindows,
} from "./clean-profile-smoke";

describe("CLEAN_PROFILE_SMOKE_STEPS", () => {
  it("covers install, WebView2, engine, auth, project, and first session", () => {
    const ids = CLEAN_PROFILE_SMOKE_STEPS.map((s) => s.id);
    expect(ids).toEqual([
      "nsis_current_user_install",
      "webview2_bootstrap",
      "engine_discover_or_acquire",
      "engine_verify_pin",
      "cli_owned_auth",
      "project_open",
      "first_session_start",
    ]);
    for (const step of CLEAN_PROFILE_SMOKE_STEPS) {
      expect(step.requiresNativeWindows).toBe(true);
      expect(step.passCriteria.length).toBeGreaterThan(10);
    }
  });

  it("defines the engine failure matrix from packaging acceptance", () => {
    const codes = ENGINE_FAILURE_SCENARIOS.map((s) => s.expectedCode);
    expect(codes).toEqual([
      "engine_missing",
      "engine_stale",
      "wrong_architecture",
      "unsigned",
      "network_unavailable",
    ]);
    expect(ENGINE_FAILURE_SCENARIOS.every((s) => s.mustBeActionable)).toBe(true);
  });
});

describe("planCleanProfileSmoke", () => {
  it("allows live mode only on native Windows", () => {
    const plan = planCleanProfileSmoke({ platform: "win32" });
    expect(plan.mode).toBe("live");
    if (plan.mode === "live") {
      expect(plan.environment).toBe("native_windows");
      expect(plan.steps.length).toBe(CLEAN_PROFILE_SMOKE_STEPS.length);
    }
  });

  it("refuses to fake live packaging results on WSL", () => {
    const plan = planCleanProfileSmoke({
      platform: "linux",
      wslIndicator: "Linux version 6.6.0-microsoft-standard-WSL2",
    });
    expect(plan.mode).toBe("plan_only");
    if (plan.mode === "plan_only") {
      expect(plan.environment).toBe("wsl");
      expect(plan.reason).toMatch(/refusing to fake|native Windows/i);
    }
    const skipped = skipLiveStepsOnNonWindows(plan);
    expect(skipped.every((s) => s.status === "skipped")).toBe(true);
    expect(skipped.some((s) => s.detail.match(/fake|native Windows/i))).toBe(true);
  });

  it("classifies plain Linux as plan-only", () => {
    expect(classifyHostEnvironment({ platform: "linux", wslIndicator: "" })).toBe(
      "linux",
    );
    const plan = planCleanProfileSmoke({ platform: "linux", wslIndicator: "" });
    expect(plan.mode).toBe("plan_only");
  });
});
