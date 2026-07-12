import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE,
  assertNoEmbeddedGrokEngine,
  describeWebView2BootstrapBehavior,
  tauriWindowsBundleFragment,
  validateWindowsDailyDriverBundle,
  type WindowsDailyDriverBundle,
} from "./windows-bundle";

describe("Windows daily-driver bundle policy", () => {
  it("defaults to current-user NSIS without admin and downloadBootstrapper WebView2", () => {
    const policy = DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE;
    expect(policy.targets).toEqual(["nsis"]);
    expect(policy.nsis.installMode).toBe("currentUser");
    expect(policy.nsis.requiresAdministrator).toBe(false);
    expect(policy.installRootHint).toBe("%LOCALAPPDATA%");
    expect(policy.webviewInstallMode.type).toBe("downloadBootstrapper");
    expect(policy.embedProprietaryEngine).toBe(false);
  });

  it("accepts a valid current-user NSIS + bootstrapper config", () => {
    const result = validateWindowsDailyDriverBundle({
      targets: ["nsis"],
      nsis: { installMode: "currentUser" },
      webviewInstallMode: { type: "downloadBootstrapper" },
      embedProprietaryEngine: false,
      externalBin: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.nsis.installMode).toBe("currentUser");
      expect(result.policy.nsis.requiresAdministrator).toBe(false);
    }
  });

  it("rejects per-machine install mode (requires admin)", () => {
    const result = validateWindowsDailyDriverBundle({
      targets: ["nsis"],
      nsis: { installMode: "perMachine" },
      webviewInstallMode: { type: "downloadBootstrapper" },
      embedProprietaryEngine: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("install_mode_requires_admin");
      expect(result.message).toMatch(/currentUser|administrator/i);
    }
  });

  it("rejects embedding proprietary grok engine in the GUI installer", () => {
    const result = validateWindowsDailyDriverBundle({
      targets: ["nsis"],
      nsis: { installMode: "currentUser" },
      webviewInstallMode: { type: "downloadBootstrapper" },
      embedProprietaryEngine: true,
      externalBin: ["binaries/grok"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("embedded_engine_forbidden");
      expect(result.message).toMatch(/must not embed|proprietary/i);
    }
  });

  it("detects grok-like paths in externalBin even when flag is false", () => {
    expect(
      assertNoEmbeddedGrokEngine({
        embedProprietaryEngine: false,
        externalBin: ["helpers/sidecar", "path/to/grok.exe"],
      }),
    ).toMatchObject({ ok: false, code: "embedded_engine_forbidden" });
  });

  it("describes WebView2 bootstrapper when runtime is present vs missing", () => {
    const present = describeWebView2BootstrapBehavior({
      mode: "downloadBootstrapper",
      runtimePresent: true,
    });
    expect(present.action).toBe("skip_bootstrap");
    expect(present.message).toMatch(/already present|already installed/i);

    const missing = describeWebView2BootstrapBehavior({
      mode: "downloadBootstrapper",
      runtimePresent: false,
    });
    expect(missing.action).toBe("download_and_run_bootstrapper");
    expect(missing.requiresNetwork).toBe(true);
    expect(missing.message).toMatch(/bootstrapper|download/i);
  });

  it("notes that skip mode never installs WebView2", () => {
    const behavior = describeWebView2BootstrapBehavior({
      mode: "skip",
      runtimePresent: false,
    });
    expect(behavior.action).toBe("none");
    expect(behavior.appWillFailWithoutRuntime).toBe(true);
  });

  it("round-trips the committed default policy shape used by tauri.conf.json", () => {
    const fromDefault: WindowsDailyDriverBundle = {
      targets: DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE.targets,
      nsis: { installMode: DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE.nsis.installMode },
      webviewInstallMode: {
        type: DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE.webviewInstallMode.type,
      },
      embedProprietaryEngine: false,
      externalBin: [],
    };
    const result = validateWindowsDailyDriverBundle(fromDefault);
    expect(result.ok).toBe(true);
  });

  it("emits a tauri bundle fragment for current-user NSIS", () => {
    const fragment = tauriWindowsBundleFragment();
    expect(fragment.targets).toBe("nsis");
    expect(fragment).toMatchObject({
      windows: {
        nsis: { installMode: "currentUser" },
        webviewInstallMode: { type: "downloadBootstrapper" },
      },
    });
  });
});
