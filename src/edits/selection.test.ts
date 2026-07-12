import { describe, expect, it } from "vitest";
import { normalizeFileChangeBatch } from "./normalize";
import {
  rejectAllChanges,
  selectAllChanges,
  setChangeSelected,
} from "./selection";

function sampleBatch() {
  return normalizeFileChangeBatch({
    batchId: "b1",
    title: "Multi-file",
    proposals: [
      { path: "a.ts", newText: "a\n" },
      { path: "b.ts", oldText: "b0\n", newText: "b1\n" },
      { path: "c.ts", kind: "delete", oldText: "c\n", newText: null },
    ],
  });
}

describe("file change selection", () => {
  it("selects and deselects individual files", () => {
    let batch = sampleBatch();
    batch = setChangeSelected(batch, "b1-2", false);
    expect(batch.changes.find((c) => c.changeId === "b1-2")?.selected).toBe(
      false,
    );
    expect(batch.changes.find((c) => c.changeId === "b1-1")?.selected).toBe(
      true,
    );

    batch = setChangeSelected(batch, "b1-2", true);
    expect(batch.changes.find((c) => c.changeId === "b1-2")?.selected).toBe(
      true,
    );
  });

  it("does not select malformed changes via select-all", () => {
    let batch = normalizeFileChangeBatch({
      batchId: "b2",
      title: "Mixed",
      proposals: [
        { path: "good.ts", newText: "ok\n" },
        { newText: "bad" },
      ],
    });
    // deselect good first
    batch = setChangeSelected(batch, batch.changes[0]!.changeId, false);
    batch = selectAllChanges(batch);
    expect(batch.changes[0]!.selected).toBe(true);
    expect(batch.changes[1]!.selected).toBe(false);
  });

  it("approve-all path is select-all on well-formed pending changes", () => {
    let batch = sampleBatch();
    batch = setChangeSelected(batch, "b1-1", false);
    batch = setChangeSelected(batch, "b1-3", false);
    batch = selectAllChanges(batch);
    expect(batch.changes.every((c) => c.selected)).toBe(true);
  });

  it("reject-all marks every change rejected and clears selection", () => {
    const batch = rejectAllChanges(sampleBatch());
    expect(batch.status).toBe("resolved");
    expect(batch.changes.every((c) => c.status === "rejected")).toBe(true);
    expect(batch.changes.every((c) => c.selected === false)).toBe(true);
  });
});
