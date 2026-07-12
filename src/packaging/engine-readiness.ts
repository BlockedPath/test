/**
 * First-run engine readiness: discover → architecture → identity.
 * Surfaces actionable failures for a clean Windows user profile.
 */

import {
  ACQUISITION_HELP,
  PINNED_ENGINE_VERSION,
} from "../engine/constants";
import {
  discoverEngine,
  type DiscoveryHost,
  type DiscoveryResult,
  type EngineCandidate,
} from "../engine/discovery";
import {
  verifyEngineIdentity,
  type IdentityHost,
  type IdentityCheckResult,
  type SignatureIdentity,
  type VersionIdentity,
} from "../engine/identity";
import {
  architectureMatches,
  hostArchFromNodeArch,
  parsePeArchitecture,
  type HostArch,
  type PeMachine,
} from "./pe-architecture";

export type EngineReadinessFailureCode =
  | "engine_missing"
  | "engine_stale"
  | "version_unreadable"
  | "wrong_architecture"
  | "unsigned"
  | "publisher_mismatch"
  | "thumbprint_mismatch"
  | "acquisition_unavailable"
  | "network_unavailable";

export type ActionableEngineFailure = {
  code: EngineReadinessFailureCode;
  title: string;
  message: string;
  /** Ordered steps the user (or UI) can take. */
  recoverySteps: string[];
  acquisition: typeof ACQUISITION_HELP;
  /** Always offer CLI fallback for packaging-path failures. */
  cliFallback: string;
  details?: {
    enginePath?: string;
    searched?: string[];
    expectedVersion?: string;
    actualVersion?: string | null;
    engineArch?: PeMachine;
    hostArch?: HostArch;
    publisher?: string;
  };
};

export type EngineReady = {
  status: "ready";
  candidate: EngineCandidate;
  version: VersionIdentity;
  signature: SignatureIdentity;
  architecture: PeMachine;
  pinnedVersion: string;
  discovery: DiscoveryResult;
  identity: IdentityCheckResult & { ok: true };
};

export type EngineNotReady = {
  status: "not_ready";
  failure: ActionableEngineFailure;
  discovery?: DiscoveryResult;
  identity?: IdentityCheckResult;
};

export type EngineReadinessResult = EngineReady | EngineNotReady;

export type EngineReadinessHost = {
  discovery: DiscoveryHost;
  identity: IdentityHost;
  /** Host CPU arch (node `process.arch` or override). */
  hostArch: string;
  /**
   * Read PE bytes for architecture check. Optional — when omitted, arch check is skipped
   * (dev hosts / non-Windows may not need it).
   */
  readEngineBytes?: (enginePath: string) => Promise<Uint8Array> | Uint8Array;
  /**
   * When the engine is missing, optionally try official acquisition.
   * Return ok:false with network_unavailable / acquisition_unavailable codes.
   */
  attemptAcquisition?: () => Promise<
    | { ok: true }
    | {
        ok: false;
        code: "network_unavailable" | "acquisition_unavailable";
        message: string;
      }
  >;
  /** Override pinned minimum (defaults to PINNED_ENGINE_VERSION). */
  pinnedVersion?: string;
};

const CLI_FALLBACK =
  "Open a terminal and use the official Grok CLI directly until the GUI engine check succeeds.";

function baseAcquisition(): typeof ACQUISITION_HELP {
  return ACQUISITION_HELP;
}

export function actionableMissingEngine(
  searched: string[],
  options?: { afterAcquisitionAttempt?: boolean; networkMessage?: string },
): ActionableEngineFailure {
  if (options?.networkMessage) {
    return {
      code: "network_unavailable",
      title: "Engine download unavailable",
      message: options.networkMessage,
      recoverySteps: [
        "Check network connectivity.",
        `Install the pinned CLI offline when possible: set GROK_VERSION=${PINNED_ENGINE_VERSION} then run the official installer.`,
        `Or: ${ACQUISITION_HELP.npmAlternative}`,
        CLI_FALLBACK,
      ],
      acquisition: baseAcquisition(),
      cliFallback: CLI_FALLBACK,
      details: { searched, expectedVersion: PINNED_ENGINE_VERSION },
    };
  }

  return {
    code: "engine_missing",
    title: "Grok CLI not found",
    message:
      "No supported Grok Build CLI was found on this profile. The GUI installer does not embed the proprietary engine.",
    recoverySteps: [
      `Run in PowerShell: ${ACQUISITION_HELP.windowsPowerShell}`,
      ACQUISITION_HELP.pinVersion,
      `Confirm the binary at ${ACQUISITION_HELP.defaultBinaryHint}`,
      "Relaunch Grok GUI to re-run discovery and verification.",
      CLI_FALLBACK,
    ],
    acquisition: baseAcquisition(),
    cliFallback: CLI_FALLBACK,
    details: {
      searched,
      expectedVersion: PINNED_ENGINE_VERSION,
    },
  };
}

export function actionableFromIdentity(
  identity: IdentityCheckResult & { ok: false },
): ActionableEngineFailure {
  const acquisition = baseAcquisition();
  const path = identity.enginePath;

  switch (identity.code) {
    case "version_mismatch":
      return {
        code: "engine_stale",
        title: "Engine version is below the pin",
        message: identity.message,
        recoverySteps: [
          `Install or upgrade to Grok CLI ${PINNED_ENGINE_VERSION} or newer via the official channel.`,
          ACQUISITION_HELP.pinVersion,
          `npm alternative: ${ACQUISITION_HELP.npmAlternative}`,
          "Do not rely on CLI background auto-update while the GUI supervises the engine.",
          CLI_FALLBACK,
        ],
        acquisition,
        cliFallback: CLI_FALLBACK,
        details: {
          enginePath: path,
          expectedVersion: PINNED_ENGINE_VERSION,
          actualVersion: identity.version?.version ?? null,
        },
      };
    case "version_unreadable":
      return {
        code: "version_unreadable",
        title: "Could not read engine version",
        message: identity.message,
        recoverySteps: [
          "Confirm the path points at the official grok.exe, not a shim or empty file.",
          "Reinstall the official Grok CLI, then retry.",
          CLI_FALLBACK,
        ],
        acquisition,
        cliFallback: CLI_FALLBACK,
        details: { enginePath: path },
      };
    case "signature_invalid":
      return {
        code: "unsigned",
        title: "Engine signature is missing or invalid",
        message: identity.message,
        recoverySteps: [
          "Delete untrusted copies of grok.exe.",
          "Reinstall from the official PowerShell or npm channel only.",
          "Refuse to launch binaries without a valid Authenticode signature on Windows.",
          CLI_FALLBACK,
        ],
        acquisition,
        cliFallback: CLI_FALLBACK,
        details: { enginePath: path, publisher: identity.signature?.publisher },
      };
    case "publisher_mismatch":
      return {
        code: "publisher_mismatch",
        title: "Unexpected engine publisher",
        message: identity.message,
        recoverySteps: [
          "The binary is signed by an unexpected publisher.",
          "Remove it and install only the official X.AI LLC Grok CLI.",
          CLI_FALLBACK,
        ],
        acquisition,
        cliFallback: CLI_FALLBACK,
        details: { enginePath: path, publisher: identity.signature?.publisher },
      };
    case "thumbprint_mismatch":
      return {
        code: "thumbprint_mismatch",
        title: "Signer thumbprint does not match policy",
        message: identity.message,
        recoverySteps: [
          "A strict thumbprint pin rejected this binary (possible cert rotation).",
          "Confirm you have the official channel binary, then update the pin policy if the publisher is still X.AI LLC.",
          CLI_FALLBACK,
        ],
        acquisition,
        cliFallback: CLI_FALLBACK,
        details: { enginePath: path },
      };
  }
}

export function actionableWrongArchitecture(input: {
  enginePath: string;
  engineArch: PeMachine;
  hostArch: HostArch;
}): ActionableEngineFailure {
  return {
    code: "wrong_architecture",
    title: "Engine architecture does not match this PC",
    message: `Found ${input.engineArch} binary at ${input.enginePath}, but this host is ${input.hostArch}.`,
    recoverySteps: [
      `Install the ${input.hostArch} Windows build of Grok CLI ${PINNED_ENGINE_VERSION}.`,
      `Official install: ${ACQUISITION_HELP.windowsPowerShell}`,
      "Remove the wrong-architecture binary from the discovery path so it is not preferred.",
      CLI_FALLBACK,
    ],
    acquisition: baseAcquisition(),
    cliFallback: CLI_FALLBACK,
    details: {
      enginePath: input.enginePath,
      engineArch: input.engineArch,
      hostArch: input.hostArch,
      expectedVersion: PINNED_ENGINE_VERSION,
    },
  };
}

/**
 * Assess whether the pinned engine is ready for the first Session on this profile.
 */
export async function assessEngineReadiness(
  host: EngineReadinessHost,
): Promise<EngineReadinessResult> {
  const pinned = host.pinnedVersion ?? PINNED_ENGINE_VERSION;
  const discovery = await discoverEngine(host.discovery);

  if (discovery.status === "missing") {
    if (host.attemptAcquisition) {
      const acq = await host.attemptAcquisition();
      if (acq.ok) {
        // Re-discover after successful acquisition
        const again = await discoverEngine(host.discovery);
        if (again.status === "found") {
          return continueWithCandidate(again, again.candidate, host, pinned);
        }
      } else if (acq.code === "network_unavailable") {
        return {
          status: "not_ready",
          failure: actionableMissingEngine(discovery.searched, {
            networkMessage: acq.message,
          }),
          discovery,
        };
      } else {
        return {
          status: "not_ready",
          failure: {
            code: "acquisition_unavailable",
            title: "Could not acquire the official engine",
            message: acq.message,
            recoverySteps: [
              ACQUISITION_HELP.pinVersion,
              `Try: ${ACQUISITION_HELP.windowsPowerShell}`,
              `Or: ${ACQUISITION_HELP.npmAlternative}`,
              CLI_FALLBACK,
            ],
            acquisition: baseAcquisition(),
            cliFallback: CLI_FALLBACK,
            details: {
              searched: discovery.searched,
              expectedVersion: pinned,
            },
          },
          discovery,
        };
      }
    }

    return {
      status: "not_ready",
      failure: actionableMissingEngine(discovery.searched),
      discovery,
    };
  }

  return continueWithCandidate(discovery, discovery.candidate, host, pinned);
}

async function continueWithCandidate(
  discovery: DiscoveryResult & { status: "found" },
  candidate: EngineCandidate,
  host: EngineReadinessHost,
  pinned: string,
): Promise<EngineReadinessResult> {
  const hostArch = hostArchFromNodeArch(host.hostArch);

  if (host.readEngineBytes) {
    try {
      const bytes = await host.readEngineBytes(candidate.path);
      const pe = parsePeArchitecture(bytes);
      if (pe.ok && !architectureMatches(pe.machine, hostArch)) {
        return {
          status: "not_ready",
          failure: actionableWrongArchitecture({
            enginePath: candidate.path,
            engineArch: pe.machine,
            hostArch,
          }),
          discovery,
        };
      }
      // not_pe / truncated: fall through to identity which will also fail usefully
    } catch {
      // Identity step will surface version_unreadable if the path is bad
    }
  }

  const identityHost: IdentityHost = {
    ...host.identity,
    minimumVersion: host.identity.minimumVersion ?? pinned,
  };
  const identity = await verifyEngineIdentity(candidate.path, identityHost);

  if (!identity.ok) {
    return {
      status: "not_ready",
      failure: actionableFromIdentity(identity),
      discovery,
      identity,
    };
  }

  let architecture: PeMachine = "unknown";
  if (host.readEngineBytes) {
    try {
      const bytes = await host.readEngineBytes(candidate.path);
      const pe = parsePeArchitecture(bytes);
      if (pe.ok) architecture = pe.machine;
    } catch {
      /* leave unknown */
    }
  }

  return {
    status: "ready",
    candidate,
    version: identity.version,
    signature: identity.signature,
    architecture,
    pinnedVersion: pinned,
    discovery,
    identity,
  };
}
