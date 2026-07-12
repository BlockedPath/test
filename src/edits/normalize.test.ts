import { describe, expect, it } from "vitest";
import {
  normalizeFileChange,
  normalizeFileChangeBatch,
} from "./normalize";

describe("normalizeFileChange", () => {
  it("normalizes a new-file create (oldText absent, newText present)", () => {
    const change = normalizeFileChange({
      path: "src/health.ts",
      newText: "export const ok = true;\n",
    });

    expect(change.malformed).toBe(false);
    expect(change.kind).toBe("create");
    expect(change.path).toBe("src/health.ts");
    expect(change.status).toBe("pending");
    expect(change.selected).toBe(true);
    expect(change.diff).toEqual({
      path: "src/health.ts",
      oldText: null,
      newText: "export const ok = true;\n",
    });
  });

  it("normalizes a deletion (newText null)", () => {
    const change = normalizeFileChange({
      path: "src/legacy.ts",
      kind: "delete",
      oldText: "export const gone = 1;\n",
      newText: null,
    });

    expect(change.malformed).toBe(false);
    expect(change.kind).toBe("delete");
    expect(change.diff?.oldText).toBe("export const gone = 1;\n");
    expect(change.diff?.newText).toBeNull();
  });

  it("normalizes an edit with old and new text", () => {
    const change = normalizeFileChange({
      path: "src/main.ts",
      kind: "edit",
      oldText: "const x = 1;\n",
      newText: "const x = 2;\n",
    });

    expect(change.kind).toBe("edit");
    expect(change.malformed).toBe(false);
    expect(change.diff?.oldText).toBe("const x = 1;\n");
    expect(change.diff?.newText).toBe("const x = 2;\n");
  });

  it("normalizes a move with destinationPath", () => {
    const change = normalizeFileChange({
      path: "src/old-name.ts",
      kind: "move",
      destinationPath: "src/new-name.ts",
      oldText: "export {}\n",
      newText: "export {}\n",
    });

    expect(change.kind).toBe("move");
    expect(change.malformed).toBe(false);
    expect(change.diff?.destinationPath).toBe("src/new-name.ts");
  });

  it("accepts ACP-style nested diff content blocks", () => {
    const change = normalizeFileChange({
      toolCallId: "tc-1",
      diff: {
        type: "diff",
        path: "README.md",
        oldText: "a\n",
        newText: "b\n",
      },
    });

    expect(change.path).toBe("README.md");
    expect(change.kind).toBe("edit");
    expect(change.toolCallId).toBe("tc-1");
    expect(change.malformed).toBe(false);
  });

  it("marks missing path as malformed without inventing a write target", () => {
    const change = normalizeFileChange({
      newText: "orphan\n",
    });

    expect(change.malformed).toBe(true);
    expect(change.malformedReason).toMatch(/path/i);
    expect(change.status).toBe("pending");
    expect(change.selected).toBe(false);
  });

  it("marks empty path as malformed", () => {
    const change = normalizeFileChange({
      path: "   ",
      newText: "x",
    });
    expect(change.malformed).toBe(true);
    expect(change.selected).toBe(false);
  });

  it("marks non-string path as malformed", () => {
    const change = normalizeFileChange({
      path: 42,
      newText: "x",
    });
    expect(change.malformed).toBe(true);
  });

  it("marks delete without path as malformed", () => {
    const change = normalizeFileChange({
      kind: "delete",
      oldText: "x",
      newText: null,
    });
    expect(change.malformed).toBe(true);
  });

  it("marks move without destination as malformed", () => {
    const change = normalizeFileChange({
      path: "a.ts",
      kind: "move",
      oldText: "x",
      newText: "x",
    });
    expect(change.malformed).toBe(true);
    expect(change.malformedReason).toMatch(/destination/i);
  });
});

describe("normalizeFileChangeBatch", () => {
  it("builds a multi-file pending batch with per-file records", () => {
    const batch = normalizeFileChangeBatch({
      batchId: "batch-1",
      title: "Add health endpoint",
      requestId: "req-1",
      turnId: "turn-1",
      proposals: [
        {
          path: "src/health.ts",
          newText: "export const ok = true;\n",
        },
        {
          path: "src/legacy.ts",
          kind: "delete",
          oldText: "old\n",
          newText: null,
        },
        {
          path: "src/main.ts",
          oldText: "a\n",
          newText: "b\n",
        },
      ],
    });

    expect(batch.batchId).toBe("batch-1");
    expect(batch.status).toBe("pending");
    expect(batch.requestId).toBe("req-1");
    expect(batch.changes).toHaveLength(3);
    expect(batch.changes.map((c) => c.kind)).toEqual([
      "create",
      "delete",
      "edit",
    ]);
    expect(batch.changes.every((c) => c.status === "pending")).toBe(true);
    expect(batch.changes.filter((c) => c.selected).length).toBe(3);
  });

  it("includes malformed entries but leaves them unselected", () => {
    const batch = normalizeFileChangeBatch({
      batchId: "batch-bad",
      title: "Mixed",
      proposals: [
        { path: "good.ts", newText: "ok\n" },
        { newText: "no path" },
      ],
    });

    expect(batch.changes).toHaveLength(2);
    expect(batch.changes[0]!.selected).toBe(true);
    expect(batch.changes[1]!.malformed).toBe(true);
    expect(batch.changes[1]!.selected).toBe(false);
  });
});
