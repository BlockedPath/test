/**
 * Normalized file-change review model.
 * Multi-file edit batches with per-file selection and apply outcomes.
 */

export type FileChangeKind = "create" | "edit" | "delete" | "move";

/** Lifecycle of one proposed file change after user review. */
export type FileChangeStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "skipped"
  | "failed";

/**
 * ACP-shaped diff content: oldText null/absent ⇒ new file;
 * newText null ⇒ deletion.
 */
export type FileDiff = {
  path: string;
  oldText?: string | null;
  newText?: string | null;
  /** Destination path for move proposals. */
  destinationPath?: string;
};

/** Raw proposal before normalization (tool / permission preview). */
export type RawFileChangeProposal = {
  path?: unknown;
  kind?: unknown;
  oldText?: unknown;
  newText?: unknown;
  destinationPath?: unknown;
  /** ACP tool content style: { type: "diff", path, oldText?, newText } */
  diff?: unknown;
  toolCallId?: unknown;
  changeId?: unknown;
};

export type FileChangeRecord = {
  changeId: string;
  path: string;
  kind: FileChangeKind;
  status: FileChangeStatus;
  /** Selected for apply when the batch is approved (cherry-pick). */
  selected: boolean;
  diff?: FileDiff;
  errorMessage?: string;
  /** True when the proposal could not be fully normalized. */
  malformed: boolean;
  malformedReason?: string;
  toolCallId?: string;
};

export type FileChangeBatchStatus = "pending" | "resolved";

export type FileChangeBatch = {
  batchId: string;
  requestId?: string;
  turnId?: string;
  title: string;
  changes: FileChangeRecord[];
  status: FileChangeBatchStatus;
};

/** Readable line for inline / expanded diff views. */
export type DiffLine = {
  type: "ctx" | "add" | "del" | "hunk" | "meta";
  text: string;
};

/** Host seam used to write approved changes to disk. */
export type FileWriteHost = {
  writeTextFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
};
