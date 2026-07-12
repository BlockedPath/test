/**
 * ProjectHost — filesystem and Git probes for local Project context.
 * Implementations: Node (real FS), Memory (tests / browser demo).
 */

import type {
  FileEntry,
  GitWorkingTree,
  ReadFileResult,
} from "./types";

export type ProjectHost = {
  /** Normalize / resolve a user-supplied path. */
  resolvePath(path: string): Promise<string>;

  pathExists(path: string): Promise<boolean>;

  isDirectory(path: string): Promise<boolean>;

  /**
   * List immediate children of a directory (non-recursive).
   * Throws with a readable message on permission / IO failure.
   */
  listDirectory(path: string): Promise<FileEntry[]>;

  /**
   * Read a text file up to maxBytes (default 256 KiB).
   * Content beyond the limit is truncated.
   */
  readFile(path: string, maxBytes?: number): Promise<ReadFileResult>;

  /**
   * Return working-tree status when `path` is inside a Git repo.
   * Return null when the path is not a Git repository (never throws for non-git).
   */
  readGitStatus(projectPath: string): Promise<GitWorkingTree | null>;
};

export type RecentProjectStore = {
  list(): string[];
  remember(path: string): void;
  clear(): void;
  /** Most recently remembered project path, if any. */
  current(): string | null;
  /**
   * Keep only paths that pass `keep`. Used to drop browser demo paths
   * when running the native desktop host.
   */
  prune?(keep: (path: string) => boolean): void;
};
