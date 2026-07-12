/**
 * Local Project context model for first-use open + Files rail.
 * Independent of AgentEnginePort; the UI opens a Project before starting a Session.
 */

export type FileKind = "file" | "directory";

export type FileEntry = {
  name: string;
  path: string;
  kind: FileKind;
};

export type FileTreeNode = FileEntry & {
  children?: FileTreeNode[];
  /** True when children were not loaded (collapsed / truncated). */
  truncated?: boolean;
};

export type GitFileStatus = {
  path: string;
  /** Short porcelain code, e.g. " M", "??", "A " */
  code: string;
};

export type GitWorkingTree = {
  branch: string | null;
  /** True when HEAD is detached or branch unknown but repo exists. */
  isRepo: true;
  dirty: boolean;
  ahead: number;
  behind: number;
  entries: GitFileStatus[];
  /** Human-readable one-line summary for the header pill. */
  summary: string;
};

export type ProjectErrorCode =
  | "path_empty"
  | "path_not_found"
  | "path_not_directory"
  | "path_unreadable"
  | "list_failed"
  | "read_failed"
  | "git_failed";

export type RecoveryAction = {
  id: string;
  label: string;
  /** Optional path to prefill when recovering (e.g. recent project). */
  path?: string;
};

export type ProjectError = {
  code: ProjectErrorCode;
  message: string;
  path?: string;
  recovery: RecoveryAction[];
};

export type TrustRule = {
  id: string;
  title: string;
  detail: string;
};

export type OpenedProject = {
  path: string;
  name: string;
  tree: FileTreeNode[];
  /** null when the folder is not a Git repository (non-Git Projects stay usable). */
  git: GitWorkingTree | null;
  openedAt: string;
  trustAcknowledged: boolean;
};

export type ProjectPhase = "choose" | "trust" | "workspace";

/** Limits applied when building a useful Files rail tree. */
export type TreeOptions = {
  maxDepth?: number;
  maxEntriesPerDir?: number;
  ignoreNames?: string[];
};

export const DEFAULT_TREE_OPTIONS: Required<TreeOptions> = {
  maxDepth: 4,
  maxEntriesPerDir: 80,
  ignoreNames: [
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    "__pycache__",
    ".turbo",
    "coverage",
  ],
};

export type ReadFileResult = {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
};
