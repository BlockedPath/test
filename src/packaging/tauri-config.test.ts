/**
 * Assert the committed tauri.conf.json matches the Windows daily-driver policy.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE,
  tauriWindowsBundleFragment,
  validateWindowsDailyDriverBundle,
} from "./windows-bundle";

const here = dirname(fileURLToPath(import.meta.url));
const tauriConfPath = join(here, "../../src-tauri/tauri.conf.json");

describe("committed tauri.conf.json Windows packaging", () => {
  it("matches current-user NSIS + downloadBootstrapper policy", () => {
    const raw = JSON.parse(readFileSync(tauriConfPath, "utf8")) as {
      bundle?: {
        active?: boolean;
        targets?: string | string[];
        windows?: {
          nsis?: { installMode?: string };
          webviewInstallMode?: { type?: string; path?: string };
        };
      };
    };

    expect(raw.bundle?.active).toBe(true);

    const targets = raw.bundle?.targets;
    const targetList = Array.isArray(targets)
      ? targets
      : targets === "nsis"
        ? ["nsis"]
        : targets === "all"
          ? ["nsis"] // product policy still requires nsis among all — reject pure all without windows block
          : [String(targets)];

    // Prefer explicit nsis; "all" alone is not the daily-driver policy
    expect(targetList.includes("nsis") || targets === "nsis").toBe(true);
    expect(targets === "all").toBe(false);

    const windows = raw.bundle?.windows;
    expect(windows).toBeDefined();
    expect(windows?.nsis?.installMode).toBe("currentUser");
    expect(windows?.webviewInstallMode?.type).toBe("downloadBootstrapper");

    const asPolicy = {
      targets: (Array.isArray(targets) ? targets : [targets === "all" ? "nsis" : targets]).filter(
        (t): t is "nsis" | "msi" => t === "nsis" || t === "msi",
      ),
      nsis: { installMode: "currentUser" as const },
      webviewInstallMode: {
        type: "downloadBootstrapper" as const,
      },
      embedProprietaryEngine: false,
      externalBin: [] as string[],
    };

    const result = validateWindowsDailyDriverBundle(asPolicy);
    expect(result.ok).toBe(true);
  });

  it("tauriWindowsBundleFragment matches the default product policy", () => {
    const fragment = tauriWindowsBundleFragment(DEFAULT_WINDOWS_DAILY_DRIVER_BUNDLE);
    expect(fragment).toMatchObject({
      active: true,
      targets: "nsis",
      windows: {
        nsis: { installMode: "currentUser" },
        webviewInstallMode: { type: "downloadBootstrapper" },
      },
    });
  });
});
