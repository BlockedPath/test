/**
 * Windows daily-driver packaging policy for the Tauri NSIS shell.
 * Sources: docs/research/windows-desktop-stack.md, Tauri v2 Windows installer docs.
 *
 * The proprietary Grok CLI is never embedded; engine pin lives outside GUI updates.
 */

export type NsisInstallMode = "currentUser" | "perMachine" | "both";

export type WebView2InstallModeType =
  | "downloadBootstrapper"
  | "embedBootstrapper"
  | "offlineInstaller"
  | "fixedRuntime"
  | "skip";

export type WindowsDailyDriverBundle = {
  /** Bundle targets — v1 ships NSIS only for personal current-user installs. */
  targets: Array<"nsis" | "msi">;
  nsis: {
    installMode: NsisInstallMode;
  };
  webviewInstallMode: {
    type: WebView2InstallModeType;
    path?: string;
  };
  /** Must remain false — do not redistribute proprietary grok.exe in the GUI package. */
  embedProprietaryEngine: boolean;
  /** Tauri externalBin entries; must not include grok engine binaries. */
  externalBin?: string[];
};

export type ValidatedWindowsBundle = {
  targets: Array<"nsis" | "msi">;
  nsis: {
    installMode: "currentUser";
    requiresAdministrator: false;
  };
  webviewInstallMode: {
    type: WebView2InstallModeType;
    path?: string;
  };
  embedProprietaryEngine: false;
  externalBin: string[];
  installRootHint: "%LOCALAPPDATA%";
};

export type BundleValidationResult =
  | { ok: true; policy: ValidatedWindowsBundle }
  | {
      ok: false;
      code:
        | "install_mode_requires_admin"
        | "missing_nsis_target"
        | "embedded_engine_forbidden"
        | "invalid_webview_mode";
      message: string;
    };

/** Product default for personal Windows v1. */
export const DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE: ValidatedWindowsBundle = {
  targets: ["nsis"],
  nsis: {
    installMode: "currentUser",
    requiresAdministrator: false,
  },
  webviewInstallMode: {
    type: "downloadBootstrapper",
  },
  embedProprietaryEngine: false,
  externalBin: [],
  installRootHint: "%LOCALAPPDATA%",
};

const GROK_ENGINE_PATH_RE = /(^|[/\\])grok(\.exe)?$/i;

export function assertNoEmbeddedGrokEngine(input: {
  embedProprietaryEngine: boolean;
  externalBin?: string[];
}): BundleValidationResult {
  if (input.embedProprietaryEngine) {
    return {
      ok: false,
      code: "embedded_engine_forbidden",
      message:
        "GUI installer must not embed the proprietary Grok CLI. Acquire a pinned engine through the official Windows channel at first run.",
    };
  }
  for (const entry of input.externalBin ?? []) {
    if (GROK_ENGINE_PATH_RE.test(entry) || /grok\.exe/i.test(entry)) {
      return {
        ok: false,
        code: "embedded_engine_forbidden",
        message: `externalBin entry "${entry}" looks like the proprietary Grok engine and must not be packaged with the GUI.`,
      };
    }
  }
  return {
    ok: true,
    policy: {
      ...DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE,
      externalBin: [...(input.externalBin ?? [])],
    },
  };
}

/**
 * Validate the Windows packaging shape used by tauri.conf.json bundle.windows.
 */
export function validateWindowsDailyDriverBundle(
  input: WindowsDailyDriverBundle,
): BundleValidationResult {
  if (!input.targets.includes("nsis")) {
    return {
      ok: false,
      code: "missing_nsis_target",
      message:
        "Windows daily driver requires the NSIS target (-setup.exe) for current-user installs.",
    };
  }

  if (input.nsis.installMode !== "currentUser") {
    return {
      ok: false,
      code: "install_mode_requires_admin",
      message:
        `NSIS installMode "${input.nsis.installMode}" requires Administrator privileges. ` +
        `Use installMode "currentUser" so the app installs under %LOCALAPPDATA% without elevation.`,
    };
  }

  const allowedWebView: WebView2InstallModeType[] = [
    "downloadBootstrapper",
    "embedBootstrapper",
    "offlineInstaller",
    "fixedRuntime",
    "skip",
  ];
  if (!allowedWebView.includes(input.webviewInstallMode.type)) {
    return {
      ok: false,
      code: "invalid_webview_mode",
      message: `Unknown webviewInstallMode.type: ${String(input.webviewInstallMode.type)}`,
    };
  }

  const embedCheck = assertNoEmbeddedGrokEngine({
    embedProprietaryEngine: input.embedProprietaryEngine,
    externalBin: input.externalBin,
  });
  if (!embedCheck.ok) return embedCheck;

  return {
    ok: true,
    policy: {
      targets: input.targets.includes("msi")
        ? ["nsis", "msi"]
        : ["nsis"],
      nsis: {
        installMode: "currentUser",
        requiresAdministrator: false,
      },
      webviewInstallMode: {
        type: input.webviewInstallMode.type,
        path: input.webviewInstallMode.path,
      },
      embedProprietaryEngine: false,
      externalBin: [...(input.externalBin ?? [])],
      installRootHint: "%LOCALAPPDATA%",
    },
  };
}

export type WebView2BootstrapBehavior = {
  mode: WebView2InstallModeType;
  runtimePresent: boolean;
  action: "skip_bootstrap" | "download_and_run_bootstrapper" | "run_embedded" | "none";
  requiresNetwork: boolean;
  appWillFailWithoutRuntime: boolean;
  message: string;
};

/**
 * Documented installer behavior for WebView2 given mode + runtime presence.
 * Does not probe the OS — callers supply runtimePresent from a host check.
 */
export function describeWebView2BootstrapBehavior(input: {
  mode: WebView2InstallModeType;
  runtimePresent: boolean;
}): WebView2BootstrapBehavior {
  const { mode, runtimePresent } = input;

  if (mode === "skip") {
    return {
      mode,
      runtimePresent,
      action: "none",
      requiresNetwork: false,
      appWillFailWithoutRuntime: !runtimePresent,
      message: runtimePresent
        ? "WebView2 runtime is present; installer skips installation (mode=skip)."
        : "WebView2 runtime is missing and mode=skip does not install it. The app will fail to launch until WebView2 is installed manually.",
    };
  }

  if (runtimePresent) {
    return {
      mode,
      runtimePresent: true,
      action: "skip_bootstrap",
      requiresNetwork: false,
      appWillFailWithoutRuntime: false,
      message:
        "WebView2 runtime is already present (Windows 10 April 2018+ / Windows 11). Bootstrapper is not run.",
    };
  }

  if (mode === "downloadBootstrapper") {
    return {
      mode,
      runtimePresent: false,
      action: "download_and_run_bootstrapper",
      requiresNetwork: true,
      appWillFailWithoutRuntime: false,
      message:
        "WebView2 runtime is missing. NSIS will download and run the official bootstrapper (requires network), then continue the current-user install.",
    };
  }

  if (mode === "embedBootstrapper") {
    return {
      mode,
      runtimePresent: false,
      action: "run_embedded",
      requiresNetwork: true,
      appWillFailWithoutRuntime: false,
      message:
        "WebView2 runtime is missing. Installer runs the embedded bootstrapper (~1.8MB); network still required for the runtime payload.",
    };
  }

  if (mode === "offlineInstaller" || mode === "fixedRuntime") {
    return {
      mode,
      runtimePresent: false,
      action: "run_embedded",
      requiresNetwork: false,
      appWillFailWithoutRuntime: false,
      message:
        "WebView2 runtime is missing. Installer uses the offline/fixed embedded WebView2 package (no network required for the runtime).",
    };
  }

  return {
    mode,
    runtimePresent,
    action: "none",
    requiresNetwork: false,
    appWillFailWithoutRuntime: !runtimePresent,
    message: `Unhandled WebView2 mode: ${mode}`,
  };
}

/**
 * Shape written into tauri.conf.json under bundle (Windows section nested).
 * Pure data for tests that assert config file policy without parsing JSON schema.
 */
export function tauriWindowsBundleFragment(
  policy: ValidatedWindowsBundle = DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE,
): Record<string, unknown> {
  return {
    active: true,
    targets: policy.targets.length === 1 ? policy.targets[0] : policy.targets,
    windows: {
      nsis: {
        installMode: policy.nsis.installMode,
      },
      webviewInstallMode: {
        type: policy.webviewInstallMode.type,
        ...(policy.webviewInstallMode.path
          ? { path: policy.webviewInstallMode.path }
          : {}),
      },
    },
  };
}
