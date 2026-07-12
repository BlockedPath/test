import { describe, expect, it } from "vitest";
import {
  architectureMatches,
  hostArchFromNodeArch,
  machineFromCode,
  parsePeArchitecture,
  PE_MACHINE,
} from "./pe-architecture";

/** Minimal synthetic PE: MZ + e_lfanew + PE signature + machine. */
function syntheticPe(machine: number, peOffset = 0x80): Uint8Array {
  const buf = new Uint8Array(peOffset + 32);
  buf[0] = 0x4d; // M
  buf[1] = 0x5a; // Z
  buf[0x3c] = peOffset & 0xff;
  buf[0x3d] = (peOffset >> 8) & 0xff;
  buf[peOffset] = 0x50; // P
  buf[peOffset + 1] = 0x45; // E
  buf[peOffset + 2] = 0x00;
  buf[peOffset + 3] = 0x00;
  buf[peOffset + 4] = machine & 0xff;
  buf[peOffset + 5] = (machine >> 8) & 0xff;
  // Optional header PE32+ magic
  buf[peOffset + 24] = 0x0b;
  buf[peOffset + 25] = 0x02;
  return buf;
}

describe("parsePeArchitecture", () => {
  it("reads AMD64 machine type from a synthetic PE", () => {
    const result = parsePeArchitecture(syntheticPe(PE_MACHINE.AMD64));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.machine).toBe("x64");
      expect(result.machineCode).toBe(PE_MACHINE.AMD64);
      expect(result.isPE32Plus).toBe(true);
    }
  });

  it("reads ARM64 machine type", () => {
    const result = parsePeArchitecture(syntheticPe(PE_MACHINE.ARM64));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.machine).toBe("arm64");
    }
  });

  it("rejects non-PE payloads", () => {
    const result = parsePeArchitecture(new TextEncoder().encode("#!/bin/sh\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_pe");
      expect(result.message).toMatch(/MZ|PE/i);
    }
  });
});

describe("architectureMatches", () => {
  it("accepts x64 engine on x64 host", () => {
    expect(architectureMatches("x64", "x64")).toBe(true);
  });

  it("rejects arm64 engine on x64 host", () => {
    expect(architectureMatches("arm64", "x64")).toBe(false);
  });

  it("maps node arch strings", () => {
    expect(hostArchFromNodeArch("x64")).toBe("x64");
    expect(hostArchFromNodeArch("arm64")).toBe("arm64");
  });

  it("maps known machine codes", () => {
    expect(machineFromCode(PE_MACHINE.AMD64)).toBe("x64");
    expect(machineFromCode(0xdead)).toBe("unknown");
  });
});
