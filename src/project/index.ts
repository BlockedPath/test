export type {
  FileEntry,
  FileKind,
  FileTreeNode,
  GitFileStatus,
  GitWorkingTree,
  OpenedProject,
  ProjectError,
  ProjectErrorCode,
  ProjectPhase,
  ReadFileResult,
  RecoveryAction,
  TrustRule,
  TreeOptions,
} from "./types";
export { DEFAULT_TREE_OPTIONS } from "./types";
export type { ProjectHost, RecentProjectStore } from "./host";
export {
  ProjectService,
  isProjectError,
  type ProjectServiceOptions,
} from "./service";
export {
  TRUST_RULES,
  TRUST_SUMMARY_INTRO,
  TRUST_SUMMARY_TITLE,
  formatTrustSummaryPlain,
} from "./trust";
export {
  createMemoryRecentStore,
  createLocalStorageRecentStore,
} from "./recent-store";
export {
  createMemoryProjectHost,
  createDemoProjectHost,
  withNonGitDemo,
  DEMO_PROJECT_PATH,
  NON_GIT_DEMO_PATH,
  type MemoryNode,
  type MemoryHostOptions,
} from "./memory-host";
export { ProjectShell, type ProjectShellOptions } from "./shell";
// Node host uses node:fs / child_process — import from "./project/node-host"
// in Node tests and runners only (not the browser bundle).
