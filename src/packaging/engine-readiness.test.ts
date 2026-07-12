import { describe, expect, it } from "vitest";
import {
  ACQUISITION_HELP,
  EXPECTED_PUBLISHER,
  PINNED_ENGINE_VERSION,
} from "../engine/constants";
import type { DiscoveryHost } from "../engine/discovery";
import type { IdentityHost, SignatureIdentity } from "../engine/identity";
import { PE_MACHINE } from "./pe-architecture";
import {
  assessEngineReadiness,
  actionableMissingEngine,
} from "./engine-readiness";

function syntheticPe(machine: number, peOffset = 0x80): Uint8Array {
  const buf = new Uint8Array(peOffset + 32);
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  buf[0x3c] = peOffset & 0xff;
  buf[0x3d] = (peOffset >> 8) & 0xff;
  buf[peOffset] = 0x50;
  buf[peOffset + 1] = 0x45;
  buf[peOffset + 2] = 0x00;
  buf[peOffset + 3] = 0x00;
  buf[peOffset + 4] = machine & 0xff;
  buf[peOffset + 5] = (machine >> 8) & 0xff;
  buf[peOffset + 24] = 0x0b;
  buf[peOffset + 25] = 0x02;
  return buf;
}

function discoveryHost(files: Set<string>, env?: Record<string, string>): DiscoveryHost {
  return {
    platform: "win32",
    env: env ?? { USERPROFILE: "C:\\Users\\clean" },
    fileExists: (p) => files.has(p),
    joinPath: (...parts) => parts.join("\\"),
  };
}

function identityHost(overrides: {
  versionText?: string;
  signature?: SignatureIdentity;
  versionError?: Error;
}): IdentityHost {
  return {
    platform: "win32",
    readVersion: async () => {
      if (overrides.versionError) throw overrides.versionError;
      return overrides.versionText ?? `grok ${PINNED_ENGINE_VERSION} (abc) [stable]`;
    },
    readSignature: async () =>
      overrides.signature ?? {
        valid: true,
        publisher: `CN=${EXPECTED_PUBLISHER}, O=${EXPECTED_PUBLISHER}`,
        thumbprint: "C4550B58C79C51C04390FAC323E600A1459186EB",
      },
  };
}

const USER_BIN = "C:\\Users\\clean\\.grok\\bin\\grok.exe";

describe("actionableMissingEngine", () => {
  it("includes official PowerShell acquisition and pin version", () => {
    const failure = actionableMissingEngine(["C:\\Users\\clean\\.grok\\bin\\grok.exe"]);
    expect(failure.code).toBe("engine_missing");
    expect(failure.recoverySteps.some((s) => s.includes(ACQUISITION_HELP.windowsPowerShell))).toBe(
      true,
    );
    expect(failure.acquisition.pinVersion).toContain(PINNED_ENGINE_VERSION);
    expect(failure.cliFallback).toMatch(/CLI/i);
  });
});

describe("assessEngineReadiness", () => {
  it("is ready when discover + x64 PE + pin/signature pass", async () => {
    const result = await assessEngineReadiness({
      discovery: discoveryHost(new Set([USER_BIN])),
      identity: identityHost({}),
      hostArch: "x64",
      readEngineBytes: async () => syntheticPe(PE_MACHINE.AMD64),
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.candidate.path).toBe(USER_BIN);
      expect(result.version.version).toBe(PINNED_ENGINE_VERSION);
      expect(result.architecture).toBe("x64");
      expect(result.pinnedVersion).toBe(PINNED_ENGINE_VERSION);
    }
  });

  it("fails engine_missing with acquisition help on clean profile", async () => {
    const result = await assessEngineReadiness({
      discovery: discoveryHost(new Set()),
      identity: identityHost({}),
      hostArch: "x64",
    });
    expect(result.status).toBe("not_ready");
    if (result.status === "not_ready") {
      expect(result.failure.code).toBe("engine_missing");
      expect(result.failure.message).toMatch(/not found|not embed/i);
      expect(result.failure.recoverySteps.length).toBeGreaterThan(2);
      expect(result.failure.acquisition.windowsPowerShell).toBe(
        ACQUISITION_HELP.windowsPowerShell,
      );
    }
  });

  it("fails engine_stale with upgrade steps when version is below pin", async () => {
    const result = await assessEngineReadiness({
      discovery: discoveryHost(new Set([USER_BIN])),
      identity: identityHost({ versionText: "grok 0.2.50 (old) [stable]" }),
      hostArch: "x64",
      readEngineBytes: async () => syntheticPe(PE_MACHINE.AMD64),
    });
    expect(result.status).toBe("not_ready");
    if (result.status === "not_ready") {
      expect(result.failure.code).toBe("engine_stale");
      expect(result.failure.message).toMatch(/0\.2\.50/);
      expect(result.failure.recoverySteps.join(" ")).toMatch(/0\.2\.93|pin|upgrade/i);
    }
  });

  it("fails unsigned when Authenticode is invalid", async () => {
    const result = await assessEngineReadiness({
      discovery: discoveryHost(new Set([USER_BIN])),
      identity: identityHost({
        signature: { valid: false, detail: "Authenticode status: NotSigned" },
      }),
      hostArch: "x64",
      readEngineBytes: async () => syntheticPe(PE_MACHINE.AMD64),
    });
    expect(result.status).toBe("not_ready");
    if (result.status === "not_ready") {
      expect(result.failure.code).toBe("unsigned");
      expect(result.failure.recoverySteps.join(" ")).toMatch(/official|Authenticode/i);
    }
  });

  it("fails wrong_architecture for arm64 engine on x64 host", async () => {
    const result = await assessEngineReadiness({
      discovery: discoveryHost(new Set([USER_BIN])),
      identity: identityHost({}),
      hostArch: "x64",
      readEngineBytes: async () => syntheticPe(PE_MACHINE.ARM64),
    });
    expect(result.status).toBe("not_ready");
    if (result.status === "not_ready") {
      expect(result.failure.code).toBe("wrong_architecture");
      expect(result.failure.message).toMatch(/arm64/i);
      expect(result.failure.message).toMatch(/x64/i);
      expect(result.failure.recoverySteps.join(" ")).toMatch(/x64|install/i);
    }
  });

  it("fails network_unavailable when acquisition cannot reach the network", async () => {
    const result = await assessEngineReadiness({
      discovery: discoveryHost(new Set()),
      identity: identityHost({}),
      hostArch: "x64",
      attemptAcquisition: async () => ({
        ok: false,
        code: "network_unavailable",
        message:
          "Could not reach https://x.ai/cli to download the pinned Grok CLI (network offline or blocked).",
      }),
    });
    expect(result.status).toBe("not_ready");
    if (result.status === "not_ready") {
      expect(result.failure.code).toBe("network_unavailable");
      expect(result.failure.recoverySteps.join(" ")).toMatch(/network|offline|GROK_VERSION/i);
    }
  });

  it("re-discovers after successful acquisition", async () => {
    const files = new Set<string>();
    const result = await assessEngineReadiness({
      discovery: discoveryHost(files),
      identity: identityHost({}),
      hostArch: "x64",
      readEngineBytes: async () => syntheticPe(PE_MACHINE.AMD64),
      attemptAcquisition: async () => {
        files.add(USER_BIN);
        return { ok: true };
      },
    });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.candidate.path).toBe(USER_BIN);
    }
  });

  it("fails publisher_mismatch with unexpected signer", async () => {
    const result = await assessEngineReadiness({
      discovery: discoveryHost(new Set([USER_BIN])),
      identity: identityHost({
        signature: { valid: true, publisher: "CN=Evil Corp" },
      }),
      hostArch: "x64",
      readEngineBytes: async () => syntheticPe(PE_MACHINE.AMD64),
    });
    expect(result.status).toBe("not_ready");
    if (result.status === "not_ready") {
      expect(result.failure.code).toBe("publisher_mismatch");
      expect(result.failure.message).toMatch(/Evil Corp|X\.AI LLC/i);
    }
  });
});
