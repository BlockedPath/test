/**
 * Helpers for rendering and driving multi-file edit review in the workspace.
 */

import {
  applySelectedChanges,
  deselectAllChanges,
  formatChangeDiff,
  rejectAllChanges,
  selectAllChanges,
  setChangeSelected,
} from "../edits";
import type { FileChangeBatch, FileWriteHost } from "../edits";

export function toggleFileSelection(
  batch: FileChangeBatch,
  changeId: string,
): FileChangeBatch {
  const change = batch.changes.find((c) => c.changeId === changeId);
  if (!change) return batch;
  return setChangeSelected(batch, changeId, !change.selected);
}

export function selectAllFiles(batch: FileChangeBatch): FileChangeBatch {
  return selectAllChanges(batch);
}

export function deselectAllFiles(batch: FileChangeBatch): FileChangeBatch {
  return deselectAllChanges(batch);
}

export function rejectBatch(batch: FileChangeBatch): FileChangeBatch {
  return rejectAllChanges(batch);
}

export async function applyBatch(
  batch: FileChangeBatch,
  host: FileWriteHost,
  options?: { projectPath?: string },
): Promise<FileChangeBatch> {
  const result = await applySelectedChanges(batch, host, {
    projectPath: options?.projectPath,
  });
  return result.batch;
}

export function inlineDiffPreview(
  batch: FileChangeBatch,
  changeId: string,
  maxLines = 8,
): string {
  const change = batch.changes.find((c) => c.changeId === changeId);
  if (!change) return "";
  const lines = formatChangeDiff(change);
  return lines
    .slice(0, maxLines)
    .map((l) => l.text)
    .join("\n");
}

export function fullDiffText(batch: FileChangeBatch, changeId: string): string {
  const change = batch.changes.find((c) => c.changeId === changeId);
  if (!change) return "";
  return formatChangeDiff(change)
    .map((l) => l.text)
    .join("\n");
}

export { formatChangeDiff };
