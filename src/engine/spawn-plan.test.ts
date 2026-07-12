import { describe, expect, it } from "vitest";
import { assertDirectSpawn, planEngineSpawn } from "./spawn-plan";

describe("planEngineSpawn", () => {
  it("launches grok.exe --no-auto-update agent stdio without a shell", () => {
    const plan = planEngineSpawn({
      enginePath: "C:\\Users\\demo\\.grok\\bin\\grok.exe",
    });
    expect(plan.shell).toBe(false);
    expect(plan.windowsHide).toBe(true);
    expect(plan.command).toBe("C:\\Users\\demo\\.grok\\bin\\grok.exe");
    expect(plan.args).toEqual(["--no-auto-update", "agent", "stdio"]);
    assertDirectSpawn(plan);
  });

  it("inserts --always-approve after agent when requested", () => {
    const plan = planEngineSpawn({
      enginePath: "/usr/bin/grok",
      alwaysApprove: true,
    });
    expect(plan.args).toEqual([
      "--no-auto-update",
      "agent",
      "--always-approve",
      "stdio",
    ]);
  });

  it("rejects shell commands as the engine binary", () => {
    const plan = planEngineSpawn({ enginePath: "C:\\Windows\\System32\\cmd.exe" });
    expect(() => assertDirectSpawn(plan)).toThrow(/not a shell/i);
  });
});
