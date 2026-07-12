import { describe, expect, it } from "vitest";
import {
  parseEngineVersion,
  verifyEngineIdentity,
  versionMeetsMinimum,
  windowsAuthenticodeScript,
  type IdentityHost,
  type SignatureIdentity,
} from "./identity";
import { EXPECTED_PUBLISHER, PINNED_ENGINE_VERSION } from "./constants";

function identityHost(overrides: {
  versionText?: string;
  signature?: SignatureIdentity;
  requireThumbprint?: boolean;
  minimumVersion?: string;
  versionError?: Error;
}): IdentityHost {
  return {
    platform: "win32",
    requireThumbprint: overrides.requireThumbprint,
    minimumVersion: overrides.minimumVersion,
    readVersion: async () => {
      if (overrides.versionError) throw overrides.versionError;
      return overrides.versionText ?? "grok 0.2.93 (f00f96316d) [stable]";
    },
    readSignature: async () =>
      overrides.signature ?? {
        valid: true,
        publisher: `CN=${EXPECTED_PUBLISHER}, O=${EXPECTED_PUBLISHER}`,
        thumbprint: "C4550B58C79C51C04390FAC323E600A1459186EB",
      },
  };
}

describe("parseEngineVersion", () => {
  it("parses CLI --version output from the Windows spike", () => {
    const v = parseEngineVersion("grok 0.2.93 (f00f96316d) [stable]");
    expect(v.version).toBe("0.2.93");
  });
});

describe("windowsAuthenticodeScript", () => {
  it("emits a single-line command without breaking PowerShell hashtables", () => {
    const script = windowsAuthenticodeScript(
      "C:\\Users\\demo\\.grok\\bin\\grok.exe",
    );
    expect(script).toContain("Get-AuthenticodeSignature");
    expect(script).toContain("C:\\Users\\demo\\.grok\\bin\\grok.exe");
    // Multi-line `@{` + `;` join is invalid PowerShell — keep hashtable inline
    expect(script).not.toMatch(/@\{\s*;/);
    expect(script).toContain("[ordered]@{");
  });
});

describe("versionMeetsMinimum", () => {
  it("accepts equal and newer versions", () => {
    expect(versionMeetsMinimum("0.2.93", "0.2.93")).toBe(true);
    expect(versionMeetsMinimum("0.2.94", "0.2.93")).toBe(true);
    expect(versionMeetsMinimum("0.2.92", "0.2.93")).toBe(false);
  });
});

describe("verifyEngineIdentity", () => {
  it("passes for pinned version and valid publisher signature", async () => {
    const result = await verifyEngineIdentity(
      "C:\\Users\\demo\\.grok\\bin\\grok.exe",
      identityHost({}),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.version.version).toBe(PINNED_ENGINE_VERSION);
      expect(result.signature.valid).toBe(true);
    }
  });

  it("fails with actionable version_mismatch when too old", async () => {
    const result = await verifyEngineIdentity(
      "C:\\cli\\grok.exe",
      identityHost({ versionText: "grok 0.2.50 (abc) [stable]" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("version_mismatch");
      expect(result.message).toMatch(/0\.2\.50/);
      expect(result.message).toMatch(/0\.2\.93/);
    }
  });

  it("fails signature_invalid with actionable detail", async () => {
    const result = await verifyEngineIdentity(
      "C:\\cli\\grok.exe",
      identityHost({
        signature: {
          valid: false,
          detail: "Authenticode status: NotSigned",
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("signature_invalid");
      expect(result.message).toMatch(/NotSigned|invalid/i);
    }
  });

  it("fails publisher_mismatch for unexpected signer", async () => {
    const result = await verifyEngineIdentity(
      "C:\\cli\\grok.exe",
      identityHost({
        signature: {
          valid: true,
          publisher: "CN=Evil Corp",
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("publisher_mismatch");
      expect(result.message).toMatch(/Evil Corp/);
      expect(result.message).toMatch(/X\.AI LLC/);
    }
  });
});
