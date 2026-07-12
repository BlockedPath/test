import { describe, expect, it } from "vitest";
import { discoverEngine, type DiscoveryHost } from "./discovery";
import { ACQUISITION_HELP, PINNED_ENGINE_VERSION } from "./constants";

function host(overrides: Partial<DiscoveryHost> & {
  files?: Set<string>;
}): DiscoveryHost {
  const files = overrides.files ?? new Set<string>();
  return {
    platform: overrides.platform ?? "win32",
    env: overrides.env ?? {
      USERPROFILE: "C:\\Users\\demo",
    },
    fileExists: (p) => files.has(p),
    joinPath: (...parts) => parts.join("\\"),
    which: overrides.which,
  };
}

describe("discoverEngine", () => {
  it("finds the default Windows user bin path", async () => {
    const path = `C:\\Users\\demo\\.grok\\bin\\grok.exe`;
    const result = await discoverEngine(
      host({ files: new Set([path]) }),
    );
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.candidate.path).toBe(path);
      expect(result.candidate.source).toBe("user_bin");
    }
  });

  it("prefers GROK_EXE over the default user bin", async () => {
    const envPath = "D:\\tools\\grok.exe";
    const userBin = `C:\\Users\\demo\\.grok\\bin\\grok.exe`;
    const result = await discoverEngine(
      host({
        env: { USERPROFILE: "C:\\Users\\demo", GROK_EXE: envPath },
        files: new Set([envPath, userBin]),
      }),
    );
    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.candidate.path).toBe(envPath);
      expect(result.candidate.source).toBe("env");
    }
  });

  it("returns official acquisition guidance when missing", async () => {
    const result = await discoverEngine(host({ files: new Set() }));
    expect(result.status).toBe("missing");
    if (result.status === "missing") {
      expect(result.acquisition.windowsPowerShell).toBe(
        ACQUISITION_HELP.windowsPowerShell,
      );
      expect(result.acquisition.pinVersion).toContain(PINNED_ENGINE_VERSION);
      expect(result.message).toMatch(/No supported Grok Build CLI/i);
      expect(result.searched.length).toBeGreaterThan(0);
    }
  });
});
