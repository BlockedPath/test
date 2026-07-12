export type {
  DiffLine,
  FileChangeBatch,
  FileChangeBatchStatus,
  FileChangeKind,
  FileChangeRecord,
  FileChangeStatus,
  FileDiff,
  FileWriteHost,
  RawFileChangeProposal,
} from "./types";
export {
  normalizeFileChange,
  normalizeFileChangeBatch,
  type NormalizeBatchInput,
} from "./normalize";
export {
  deselectAllChanges,
  rejectAllChanges,
  selectAllChanges,
  setChangeSelected,
} from "./selection";
export { applySelectedChanges, type ApplyResult } from "./apply";
export { formatChangeDiff, formatDiffLines } from "./format-diff";
export { createMemoryFileWriteHost } from "./memory-host";
