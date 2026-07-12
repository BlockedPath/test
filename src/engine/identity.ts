/**
 * Version identity + publisher/signature checks before launch.
 */

import {
  EXPECTED_PUBLISHER,
  EXPECTED_SIGNER_THUMBPRINT,
  PINNED_ENGINE_VERSION,
} from "./constants";
import { redactSecrets } from "./redact";

export type VersionIdentity = {
  /** Raw `grok --version` text or version.json payload. */
  raw: string;
  /** Parsed semver-ish core, e.g. 0.2.93 */
  version: string | null;
};

export type SignatureIdentity = {
  valid: boolean;
  publisher?: string;
  thumbprint?: string;
  /** Platform note, e.g. skipped on non-Windows. */
  detail?: string;
};

export type IdentityCheckResult =
  | {
      ok: true;
      version: VersionIdentity;
      signature: SignatureIdentity;
      enginePath: string;
    }
  | {
      ok: false;
      code:
        | "version_mismatch"
        | "version_unreadable"
        | "signature_invalid"
        | "publisher_mismatch"
        | "thumbprint_mismatch";
      message: string;
      version?: VersionIdentity;
      signature?: SignatureIdentity;
      enginePath: string;
    };

export type IdentityHost = {
  platform: NodeJS.Platform | string;
  /** Run `exe --version` (or equivalent) and return stdout+stderr text. */
  readVersion: (enginePath: string) => Promise<string>;
  /** Windows Authenticode (or test double). */
  readSignature: (enginePath: string) => Promise<SignatureIdentity>;
  /**
   * When true, require exact thumbprint match (strict policy).
   * Default false — publisher + valid signature is enough for personal v1.
   */
  requireThumbprint?: boolean;
  /** Override minimum version (defaults to pin). */
  minimumVersion?: string;
};

/** Parse `grok 0.2.93 (f00f96316d) [stable]` or bare `0.2.93`. */
export function parseEngineVersion(raw: string): VersionIdentity {
  const cleaned = redactSecrets(raw.trim());
  const m =
    cleaned.match(/\bgrok\s+(v?)(\d+\.\d+\.\d+)\b/i) ||
    cleaned.match(/\b(v?)(\d+\.\d+\.\d+)\b/);
  return {
    raw: cleaned,
    version: m ? m[2]! : null,
  };
}

function parseSemver(v: string): [number, number, number] | null {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when actual >= minimum (semver major.minor.patch). */
export function versionMeetsMinimum(
  actual: string,
  minimum: string,
): boolean {
  const a = parseSemver(actual);
  const b = parseSemver(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! > b[i]!) return true;
    if (a[i]! < b[i]!) return false;
  }
  return true;
}

export async function verifyEngineIdentity(
  enginePath: string,
  host: IdentityHost,
): Promise<IdentityCheckResult> {
  const minimum = host.minimumVersion ?? PINNED_ENGINE_VERSION;

  let version: VersionIdentity;
  try {
    const raw = await host.readVersion(enginePath);
    version = parseEngineVersion(raw);
  } catch (err) {
    return {
      ok: false,
      code: "version_unreadable",
      message: redactSecrets(
        `Could not read engine version from ${enginePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
      enginePath,
    };
  }

  if (!version.version) {
    return {
      ok: false,
      code: "version_unreadable",
      message: `Engine version output was not parseable: ${version.raw.slice(0, 200)}`,
      version,
      enginePath,
    };
  }

  if (!versionMeetsMinimum(version.version, minimum)) {
    return {
      ok: false,
      code: "version_mismatch",
      message: `Engine ${version.version} is below required ${minimum}. Update the official Grok CLI, then retry.`,
      version,
      enginePath,
    };
  }

  const signature = await host.readSignature(enginePath);

  // Non-Windows (or test doubles that skip) may mark valid with a detail note.
  if (!signature.valid) {
    return {
      ok: false,
      code: "signature_invalid",
      message:
        signature.detail ||
        `Authenticode signature is missing or invalid for ${enginePath}`,
      version,
      signature,
      enginePath,
    };
  }

  if (
    signature.publisher &&
    !signature.publisher.includes(EXPECTED_PUBLISHER)
  ) {
    return {
      ok: false,
      code: "publisher_mismatch",
      message: `Unexpected publisher "${signature.publisher}". Expected ${EXPECTED_PUBLISHER}.`,
      version,
      signature,
      enginePath,
    };
  }

  if (
    host.requireThumbprint &&
    signature.thumbprint &&
    signature.thumbprint.toUpperCase() !== EXPECTED_SIGNER_THUMBPRINT
  ) {
    return {
      ok: false,
      code: "thumbprint_mismatch",
      message: `Signer thumbprint ${signature.thumbprint} does not match the pinned policy.`,
      version,
      signature,
      enginePath,
    };
  }

  return {
    ok: true,
    version,
    signature,
    enginePath,
  };
}

/**
 * Build a Windows PowerShell snippet that inspects Authenticode.
 * Used by the real host adapter — unit tests inject readSignature instead.
 *
 * Must be valid as a single `powershell -Command` string: avoid multi-line
 * hashtables split by `;` (that breaks `@{`).
 */
export function windowsAuthenticodeScript(enginePath: string): string {
  // Escape single quotes for PowerShell single-quoted string
  const escaped = enginePath.replace(/'/g, "''");
  return (
    `$sig = Get-AuthenticodeSignature -FilePath '${escaped}'; ` +
    `$cert = $sig.SignerCertificate; ` +
    `$o = [ordered]@{ Status = $sig.Status.ToString(); Publisher = $(if ($cert) { $cert.Subject } else { $null }); Thumbprint = $(if ($cert) { $cert.Thumbprint } else { $null }) }; ` +
    `$o | ConvertTo-Json -Compress`
  );
}
