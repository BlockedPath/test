import { describe, expect, it } from "vitest";
import { PINNED_ENGINE_VERSION } from "../engine/constants";
import {
  DEFAULT_UPDATE_POLICY,
  assertNoSilentEngineDrift,
  validateUpdatePolicy,
} from "./update-policy";

describe("DEFAULT_UPDATE_POLICY", () => {
  it("keeps GUI updates optional and engine pin independent", () => {
    expect(DEFAULT_UPDATE_POLICY.gui.channel).toBe("manual_reinstall");
    expect(DEFAULT_UPDATE_POLICY.gui.enabled).toBe(false);
    expect(DEFAULT_UPDATE_POLICY.engine.pinnedVersion).toBe(PINNED_ENGINE_VERSION);
    expect(DEFAULT_UPDATE_POLICY.engine.autoUpdateWhileSupervised).toBe(false);
    expect(DEFAULT_UPDATE_POLICY.engine.independentOfGuiVersion).toBe(true);
    expect(validateUpdatePolicy(DEFAULT_UPDATE_POLICY)).toEqual({ ok: true });
  });
});

describe("assertNoSilentEngineDrift", () => {
  it("accepts stable engine across GUI-only relaunch", () => {
    const result = assertNoSilentEngineDrift({
      previousRecordedEngineVersion: PINNED_ENGINE_VERSION,
      currentEngineVersion: PINNED_ENGINE_VERSION,
      guiVersionChanged: true,
      pinBeforeGuiUpdate: PINNED_ENGINE_VERSION,
      pinAfterGuiUpdate: PINNED_ENGINE_VERSION,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects engine pin change bundled with a GUI update", () => {
    const result = assertNoSilentEngineDrift({
      previousRecordedEngineVersion: "0.2.93",
      currentEngineVersion: "0.2.93",
      guiVersionChanged: true,
      pinBeforeGuiUpdate: "0.2.93",
      pinAfterGuiUpdate: "0.3.0",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pin_changed_with_gui");
      expect(result.message).toMatch(/independent/i);
    }
  });

  it("rejects engine below pin after GUI update (no silent upgrade path)", () => {
    const result = assertNoSilentEngineDrift({
      previousRecordedEngineVersion: "0.2.90",
      currentEngineVersion: "0.2.90",
      pinnedVersion: "0.2.93",
      guiVersionChanged: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("engine_below_pin");
      expect(result.message).toMatch(/do not upgrade the engine/i);
    }
  });

  it("rejects silent engine version change during GUI update", () => {
    const result = assertNoSilentEngineDrift({
      previousRecordedEngineVersion: "0.2.93",
      currentEngineVersion: "0.2.99",
      guiVersionChanged: true,
      pinBeforeGuiUpdate: "0.2.93",
      pinAfterGuiUpdate: "0.2.93",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("silent_engine_drift");
      expect(result.message).toMatch(/explicit pin/i);
    }
  });
});
