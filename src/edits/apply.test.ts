import { describe, expect, it } from "vitest";
import { applySelectedChanges } from "./apply";
import { normalizeFileChangeBatch } from "./normalize";
import { setChangeSelected } from "./selection";
import type { FileWriteHost } from "./types";

function memoryHost(options?: {
  failPaths?: Set<string>;
}): FileWriteHost & {
  writes: Array<{ path: string; content: string }>;
  deletes: string[];
  moves: Array<{ from: string; to: string }>;
} {
  const writes: Array<{ path: string; content: string }> = [];
  const deletes: string[] = [];
  const moves: Array<{ from: string; to: string }> = [];
  const failPaths = options?.failPaths ?? new Set();

  return {
    writes,
    deletes,
    moves,
    async writeTextFile(path, content) {
      if (failPaths.has(path)) throw new Error(`EACCES: ${path}`);
      writes.push({ path, content });
    },
    async deleteFile(path) {
      if (failPaths.has(path)) throw new Error(`EACCES: ${path}`);
      deletes.push(path);
    },
    async moveFile(from, to) {
      if (failPaths.has(from) || failPaths.has(to)) {
        throw new Error(`EACCES: move ${from} → ${to}`);
      }
      moves.push({ from, to });
    },
  };
}

describe("applySelectedChanges", () => {
  it("hard-blocks raw secrets and elevated paths when safety is provided", async () => {
    const batch = normalizeFileChangeBatch({
      batchId: "safe-1",
      title: "Unsafe",
      proposals: [
        {
          path: "src/ok.ts",
          newText: "export const ok = true;\n",
        },
        {
          path: "src/leak.ts",
          newText: 'export const k = "xai-abcdef1234567890";\n',
        },
        {
          path: "/tmp/outside.ts",
          newText: "outside\n",
        },
      ],
    });
    const host = memoryHost();
    const result = await applySelectedChanges(batch, host, {
      projectPath: "/home/user/proj",
    });
    const byPath = Object.fromEntries(
      result.batch.changes.map((c) => [c.path, c]),
    );
    expect(byPath["src/ok.ts"]!.status).toBe("applied");
    expect(byPath["src/leak.ts"]!.status).toBe("failed");
    expect(byPath["src/leak.ts"]!.errorMessage).toMatch(/hard-block|secret|credential/i);
    expect(byPath["/tmp/outside.ts"]!.status).toBe("failed");
    expect(byPath["/tmp/outside.ts"]!.errorMessage).toMatch(/outside|elevated/i);
    expect(host.writes.map((w) => w.path)).toEqual(["src/ok.ts"]);
  });

  it("writes only selected files and marks others skipped", async () => {
    let batch = normalizeFileChangeBatch({
      batchId: "b1",
      title: "Partial",
      proposals: [
        { path: "a.ts", newText: "new a\n" },
        { path: "b.ts", oldText: "old b\n", newText: "new b\n" },
        { path: "c.ts", kind: "delete", oldText: "c\n", newText: null },
      ],
    });
    batch = setChangeSelected(batch, "b1-2", false);

    const host = memoryHost();
    const result = await applySelectedChanges(batch, host);

    expect(result.batch.status).toBe("resolved");
    expect(result.batch.changes.map((c) => c.status)).toEqual([
      "applied",
      "skipped",
      "applied",
    ]);
    expect(host.writes).toEqual([
      { path: "a.ts", content: "new a\n" },
      // b skipped
    ]);
    // wait, c is delete - should be in deletes
    expect(host.deletes).toEqual(["c.ts"]);
    expect(host.writes.map((w) => w.path)).toEqual(["a.ts"]);
  });

  it("creates new files from create proposals", async () => {
    const batch = normalizeFileChangeBatch({
      batchId: "b2",
      title: "Create",
      proposals: [{ path: "src/new.ts", newText: "export {}\n" }],
    });
    const host = memoryHost();
    const result = await applySelectedChanges(batch, host);
    expect(result.batch.changes[0]!.status).toBe("applied");
    expect(host.writes).toEqual([
      { path: "src/new.ts", content: "export {}\n" },
    ]);
  });

  it("deletes files for delete proposals", async () => {
    const batch = normalizeFileChangeBatch({
      batchId: "b3",
      title: "Delete",
      proposals: [
        {
          path: "src/gone.ts",
          kind: "delete",
          oldText: "x\n",
          newText: null,
        },
      ],
    });
    const host = memoryHost();
    await applySelectedChanges(batch, host);
    expect(host.deletes).toEqual(["src/gone.ts"]);
    expect(host.writes).toEqual([]);
  });

  it("moves files for move proposals", async () => {
    const batch = normalizeFileChangeBatch({
      batchId: "b4",
      title: "Move",
      proposals: [
        {
          path: "src/old.ts",
          kind: "move",
          destinationPath: "src/new.ts",
          oldText: "x\n",
          newText: "x\n",
        },
      ],
    });
    const host = memoryHost();
    await applySelectedChanges(batch, host);
    expect(host.moves).toEqual([{ from: "src/old.ts", to: "src/new.ts" }]);
  });

  it("marks write failures as failed without applying remaining as silent success for that file", async () => {
    const batch = normalizeFileChangeBatch({
      batchId: "b5",
      title: "Fail one",
      proposals: [
        { path: "ok.ts", newText: "ok\n" },
        { path: "bad.ts", newText: "bad\n" },
        { path: "later.ts", newText: "later\n" },
      ],
    });
    const host = memoryHost({ failPaths: new Set(["bad.ts"]) });
    const result = await applySelectedChanges(batch, host);

    expect(result.batch.changes.map((c) => c.status)).toEqual([
      "applied",
      "failed",
      "applied",
    ]);
    expect(result.batch.changes[1]!.errorMessage).toMatch(/EACCES|bad\.ts/);
    expect(host.writes.map((w) => w.path)).toEqual(["ok.ts", "later.ts"]);
  });

  it("never writes malformed or unselected changes", async () => {
    let batch = normalizeFileChangeBatch({
      batchId: "b6",
      title: "Guard",
      proposals: [
        { path: "good.ts", newText: "g\n" },
        { newText: "no path" },
      ],
    });
    batch = setChangeSelected(batch, "b6-1", false);
    const host = memoryHost();
    const result = await applySelectedChanges(batch, host);
    expect(host.writes).toEqual([]);
    expect(host.deletes).toEqual([]);
    expect(result.batch.changes[0]!.status).toBe("skipped");
    expect(result.batch.changes[1]!.status).toBe("skipped");
  });

  it("reject path is a no-op for the host (use rejectAllChanges first)", async () => {
    const batch = normalizeFileChangeBatch({
      batchId: "b7",
      title: "Empty select",
      proposals: [{ path: "x.ts", newText: "x\n" }],
    });
    const deselected = setChangeSelected(batch, "b7-1", false);
    const host = memoryHost();
    await applySelectedChanges(deselected, host);
    expect(host.writes).toEqual([]);
  });
});
