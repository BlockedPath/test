import { describe, expect, it } from "vitest";
import {
  PERSONAL_V1_WALKTHROUGH,
  buildAcceptanceRecord,
  buildHostMeta,
  defaultGapsForHost,
  emptyScenarioResult,
  formatAcceptanceMarkdown,
  summarize,
} from "./index";

describe("acceptance record", () => {
  it("never marks ready when a fake_port scenario failed", () => {
    const scenarios = PERSONAL_V1_WALKTHROUGH.map((s) =>
      emptyScenarioResult(
        s,
        s.executionMode === "fake_port" ? "passed" : "unexecuted",
      ),
    );
    scenarios[1] = { ...scenarios[1]!, status: "failed", detail: "boom" };
    const summary = summarize(scenarios);
    expect(summary.readyForCoordinator).toBe(false);
    expect(summary.failed).toBe(1);
  });

  it("is ready when all fake_port scenarios pass and live install is unexecuted", () => {
    const scenarios = PERSONAL_V1_WALKTHROUGH.map((s) => {
      if (s.id === "windows_packaging_smoke_record") {
        return emptyScenarioResult(s, "passed", "Recorded honestly");
      }
      return emptyScenarioResult(
        s,
        s.executionMode === "fake_port" ? "passed" : "unexecuted",
        s.executionMode === "native_windows"
          ? "Requires native Windows"
          : undefined,
      );
    });
    const summary = summarize(scenarios);
    expect(summary.readyForCoordinator).toBe(true);
    expect(summary.failed).toBe(0);
    expect(summary.unexecuted).toBe(1); // fresh_install live path only
  });

  it("classifies WSL host and formats markdown with gaps", () => {
    const host = buildHostMeta({
      platform: "linux",
      arch: "x64",
      wslIndicator: "Linux version ... Microsoft ... WSL2",
      nodeVersion: "v22.0.0",
    });
    expect(host.environment).toBe("wsl");
    const record = buildAcceptanceRecord({
      host,
      git: { branch: "ticket-19-acceptance", commit: "abc1234" },
      scenarios: PERSONAL_V1_WALKTHROUGH.map((s) =>
        emptyScenarioResult(
          s,
          s.executionMode === "fake_port" ? "passed" : "unexecuted",
        ),
      ),
      gaps: defaultGapsForHost(host.environment),
    });
    const md = formatAcceptanceMarkdown(record);
    expect(md).toContain("ticket-19-acceptance");
    expect(md).toContain("native-windows-nsis-install");
    expect(md).toMatch(/out_of_scope/);
    expect(record.summary.readyForCoordinator).toBe(true);
  });
});
