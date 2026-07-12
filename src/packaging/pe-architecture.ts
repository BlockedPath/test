/**
 * PE architecture inspection for wrong-architecture engine failures.
 * Pure parsing of the DOS/PE headers — no native Windows APIs required.
 */

export type PeMachine =
  | "x86"
  | "x64"
  | "arm"
  | "arm64"
  | "unknown";

export type PeArchitectureResult =
  | {
      ok: true;
      machine: PeMachine;
      machineCode: number;
      isPE32Plus: boolean;
    }
  | {
      ok: false;
      code: "not_pe" | "truncated_header" | "unreadable";
      message: string;
    };

/** IMAGE_FILE_MACHINE_* values */
export const PE_MACHINE = {
  I386: 0x014c,
  AMD64: 0x8664,
  ARM: 0x01c0,
  ARMNT: 0x01c4,
  ARM64: 0xaa64,
} as const;

export function machineFromCode(code: number): PeMachine {
  switch (code) {
    case PE_MACHINE.I386:
      return "x86";
    case PE_MACHINE.AMD64:
      return "x64";
    case PE_MACHINE.ARM:
    case PE_MACHINE.ARMNT:
      return "arm";
    case PE_MACHINE.ARM64:
      return "arm64";
    default:
      return "unknown";
  }
}

/**
 * Parse PE machine type from file bytes (at least first 0x100 bytes recommended).
 */
export function parsePeArchitecture(bytes: Uint8Array): PeArchitectureResult {
  if (bytes.length < 2) {
    return {
      ok: false,
      code: "truncated_header",
      message: "File too small to contain a PE DOS header.",
    };
  }
  // MZ signature first so non-PE payloads fail as not_pe even when short
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    return {
      ok: false,
      code: "not_pe",
      message: "File is not a Windows PE executable (missing MZ signature).",
    };
  }
  if (bytes.length < 0x40) {
    return {
      ok: false,
      code: "truncated_header",
      message: "File too small to contain a complete PE DOS header.",
    };
  }

  const peOffset =
    bytes[0x3c]! |
    (bytes[0x3d]! << 8) |
    (bytes[0x3e]! << 16) |
    (bytes[0x3f]! << 24);

  if (peOffset < 0 || peOffset + 6 > bytes.length) {
    return {
      ok: false,
      code: "truncated_header",
      message: `PE header offset 0x${peOffset.toString(16)} is outside the provided bytes.`,
    };
  }

  // PE\0\0
  if (
    bytes[peOffset] !== 0x50 ||
    bytes[peOffset + 1] !== 0x45 ||
    bytes[peOffset + 2] !== 0x00 ||
    bytes[peOffset + 3] !== 0x00
  ) {
    return {
      ok: false,
      code: "not_pe",
      message: "File is not a Windows PE executable (missing PE signature).",
    };
  }

  const machineCode = bytes[peOffset + 4]! | (bytes[peOffset + 5]! << 8);
  const machine = machineFromCode(machineCode);

  // Optional header magic at peOffset + 24
  let isPE32Plus = false;
  if (peOffset + 26 <= bytes.length) {
    const optMagic = bytes[peOffset + 24]! | (bytes[peOffset + 25]! << 8);
    isPE32Plus = optMagic === 0x20b; // PE32+
  }

  return {
    ok: true,
    machine,
    machineCode,
    isPE32Plus,
  };
}

export type HostArch = "x64" | "arm64" | "x86" | "unknown";

export function hostArchFromNodeArch(arch: string): HostArch {
  switch (arch) {
    case "x64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    case "ia32":
    case "x86":
      return "x86";
    default:
      return "unknown";
  }
}

/** True when engine PE machine is compatible with the host arch policy. */
export function architectureMatches(
  engine: PeMachine,
  host: HostArch,
): boolean {
  if (engine === "unknown" || host === "unknown") return false;
  if (engine === host) return true;
  // WoW64: 32-bit x86 on x64 is sometimes acceptable but v1 pin is native x64.
  return false;
}
