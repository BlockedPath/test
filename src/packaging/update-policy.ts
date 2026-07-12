/**
 * GUI update channel vs engine pin — must stay independent.
 * A GUI update must never silently change or accept a drifted engine pin.
 */

import { PINNED_ENGINE_VERSION } from "../engine/constants";
import { versionMeetsMinimum } from "../engine/identity";

export type GuiUpdateChannel =
  | "manual_reinstall"
  | "tauri_updater"
  | "disabled";

export type EnginePinPolicy = {
  /** App-controlled minimum version; not derived from GUI package version. */
  pinnedVersion: string;
  /** CLI background auto-update is disabled while the GUI supervises the engine. */
  autoUpdateWhileSupervised: false;
  /** Engine pin is independent of GUI semver. */
  independentOfGuiVersion: true;
  /** How the pin is recorded after a successful readiness check. */
  recordField: "engineVersion";
};

export type PackagingUpdatePolicy = {
  gui: {
    channel: GuiUpdateChannel;
    /** Optional for personal v1 — reinstall NSIS manually. */
    enabled: boolean;
    artifactHint: "nsis-setup.exe";
  };
  engine: EnginePinPolicy;
};

/** Product default: no silent GUI auto-update; engine pin is separate. */
export const DEFAULT_UPDATE_POLICY: PackagingUpdatePolicy = {
  gui: {
    channel: "manual_reinstall",
    enabled: false,
    artifactHint: "nsis-setup.exe",
  },
  engine: {
    pinnedVersion: PINNED_ENGINE_VERSION,
    autoUpdateWhileSupervised: false,
    independentOfGuiVersion: true,
    recordField: "engineVersion",
  },
};

export type DriftCheckResult =
  | {
      ok: true;
      engineVersion: string;
      guiVersion?: string;
      note: string;
    }
  | {
      ok: false;
      code: "silent_engine_drift" | "engine_below_pin" | "pin_changed_with_gui";
      message: string;
    };

/**
 * After a GUI update (or relaunch), ensure the engine pin did not silently change
 * and the discovered engine still meets the app-controlled pin.
 */
export function assertNoSilentEngineDrift(input: {
  /** Engine version recorded before GUI update / previous session. */
  previousRecordedEngineVersion: string | null;
  /** Engine version observed now. */
  currentEngineVersion: string;
  /** App pin (defaults to product pin). */
  pinnedVersion?: string;
  /** True when the GUI package version changed since last run. */
  guiVersionChanged: boolean;
  /** If set, the pin stored in app config after a GUI update. */
  pinAfterGuiUpdate?: string;
  /** Pin that was in effect before the GUI update. */
  pinBeforeGuiUpdate?: string;
}): DriftCheckResult {
  const pin = input.pinnedVersion ?? PINNED_ENGINE_VERSION;

  if (
    input.guiVersionChanged &&
    input.pinBeforeGuiUpdate != null &&
    input.pinAfterGuiUpdate != null &&
    input.pinBeforeGuiUpdate !== input.pinAfterGuiUpdate
  ) {
    return {
      ok: false,
      code: "pin_changed_with_gui",
      message:
        `GUI update changed the engine pin from ${input.pinBeforeGuiUpdate} to ${input.pinAfterGuiUpdate}. ` +
        `Engine pin must be independent of GUI updates.`,
    };
  }

  if (!versionMeetsMinimum(input.currentEngineVersion, pin)) {
    return {
      ok: false,
      code: "engine_below_pin",
      message:
        `Engine ${input.currentEngineVersion} is below app pin ${pin}. ` +
        `GUI updates do not upgrade the engine — install the pinned CLI separately.`,
    };
  }

  if (
    input.previousRecordedEngineVersion &&
    input.previousRecordedEngineVersion !== input.currentEngineVersion &&
    input.guiVersionChanged
  ) {
    // Engine version changed across a GUI-only update without an explicit pin flow.
    // Accept only if still >= pin, but flag silent drift when it moved without acquisition.
    return {
      ok: false,
      code: "silent_engine_drift",
      message:
        `Engine version changed from ${input.previousRecordedEngineVersion} to ${input.currentEngineVersion} ` +
        `during a GUI update. Engine acquisition must be an explicit pin/verify step, not a side effect of updating the shell.`,
    };
  }

  return {
    ok: true,
    engineVersion: input.currentEngineVersion,
    note:
      "Engine pin is independent of GUI updates; --no-auto-update remains required at spawn.",
  };
}

/**
 * Validate that a packaging update policy keeps channels separate.
 */
export function validateUpdatePolicy(
  policy: PackagingUpdatePolicy,
): { ok: true } | { ok: false; message: string } {
  if (policy.engine.autoUpdateWhileSupervised !== false) {
    return {
      ok: false,
      message:
        "Engine auto-update while supervised must be false (spawn with --no-auto-update).",
    };
  }
  if (policy.engine.independentOfGuiVersion !== true) {
    return {
      ok: false,
      message: "Engine pin must be independent of GUI version.",
    };
  }
  if (!policy.engine.pinnedVersion) {
    return { ok: false, message: "Engine pin version is required." };
  }
  return { ok: true };
}
