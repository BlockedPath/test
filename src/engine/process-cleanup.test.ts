import { describe, expect, it, vi } from "vitest";
import {
  createNodeProcessCleanupHost,
  killProcessTree,
  type ProcessCleanupHost,
} from "./process-cleanup";

describe("killProcessTree (Emergency Stop cleanup seam)", () => {
  it("reports clean when no pid is present", async () => {
    const host: ProcessCleanupHost = {
      platform: "win32",
      killTree: vi.fn(),
    };
    const result = await killProcessTree(null, host);
    expect(result.status).toBe("clean");
    expect(result.orphanPids).toEqual([]);
    expect(host.killTree).not.toHaveBeenCalled();
  });

  it("uses Windows taskkill-style tree kill and reports clean on success", async () => {
    const host: ProcessCleanupHost = {
      platform: "win32",
      killTree: vi.fn(async (pid) => ({
        ok: true,
        detail: `taskkill /T /F applied to pid ${pid}`,
      })),
      isAlive: vi.fn(async () => false),
    };
    const result = await killProcessTree(4242, host);
    expect(host.killTree).toHaveBeenCalledWith(4242);
    expect(result.status).toBe("clean");
    expect(result.orphanPids).toEqual([]);
    expect(result.detail).toMatch(/taskkill|4242/i);
  });

  it("surfaces orphans_possible when the root pid remains alive", async () => {
    const host: ProcessCleanupHost = {
      platform: "win32",
      killTree: vi.fn(async () => ({ ok: true, detail: "kill issued" })),
      isAlive: vi.fn(async () => true),
    };
    const result = await killProcessTree(99, host);
    expect(result.status).toBe("orphans_possible");
    expect(result.orphanPids).toContain(99);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("reports incomplete when kill fails and no alive probe is available", async () => {
    const host: ProcessCleanupHost = {
      platform: "linux",
      killTree: vi.fn(async () => ({
        ok: false,
        detail: "permission denied",
      })),
    };
    const result = await killProcessTree(7, host);
    expect(result.status).toBe("incomplete");
    expect(result.detail).toMatch(/permission denied|incomplete|7/i);
  });
});

describe("createNodeProcessCleanupHost", () => {
  it("invokes taskkill /PID /T /F on win32", async () => {
    const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const host = createNodeProcessCleanupHost({
      platform: "win32",
      execFile,
    });
    const result = await host.killTree(1234);
    expect(execFile).toHaveBeenCalledWith("taskkill", [
      "/PID",
      "1234",
      "/T",
      "/F",
    ]);
    expect(result.ok).toBe(true);
  });

  it("applies POSIX signals without taskkill", async () => {
    const killed: Array<{ pid: number; signal?: string }> = [];
    const host = createNodeProcessCleanupHost({
      platform: "linux",
      kill: (pid, signal) => {
        killed.push({ pid, signal });
      },
    });
    const result = await host.killTree(55);
    expect(result.ok).toBe(true);
    expect(killed.some((k) => k.pid === 55)).toBe(true);
    expect(killed.some((k) => k.signal === "SIGKILL" || k.signal === "SIGTERM")).toBe(
      true,
    );
  });
});
