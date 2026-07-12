import type { FileChangeBatch, FileChangeRecord } from "./types";

function mapChange(
  batch: FileChangeBatch,
  changeId: string,
  map: (change: FileChangeRecord) => FileChangeRecord,
): FileChangeBatch {
  return {
    ...batch,
    changes: batch.changes.map((c) =>
      c.changeId === changeId ? map(c) : c,
    ),
  };
}

/** Toggle or set selection for one file in a pending batch. */
export function setChangeSelected(
  batch: FileChangeBatch,
  changeId: string,
  selected: boolean,
): FileChangeBatch {
  if (batch.status !== "pending") return batch;
  return mapChange(batch, changeId, (c) => {
    if (c.malformed || c.status !== "pending") {
      return { ...c, selected: false };
    }
    return { ...c, selected };
  });
}

/** Select every well-formed pending change (approve-all selection). */
export function selectAllChanges(batch: FileChangeBatch): FileChangeBatch {
  if (batch.status !== "pending") return batch;
  return {
    ...batch,
    changes: batch.changes.map((c) => ({
      ...c,
      selected: !c.malformed && c.status === "pending",
    })),
  };
}

/** Clear selection on all pending changes. */
export function deselectAllChanges(batch: FileChangeBatch): FileChangeBatch {
  if (batch.status !== "pending") return batch;
  return {
    ...batch,
    changes: batch.changes.map((c) => ({ ...c, selected: false })),
  };
}

/** Reject the entire batch without writing any files. */
export function rejectAllChanges(batch: FileChangeBatch): FileChangeBatch {
  return {
    ...batch,
    status: "resolved",
    changes: batch.changes.map((c) => ({
      ...c,
      status: "rejected",
      selected: false,
    })),
  };
}
