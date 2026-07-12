/**
 * ProjectService — open / reopen a Project and load local context.
 */

import type { ProjectHost, RecentProjectStore } from "./host";
import {
  DEFAULT_TREE_OPTIONS,
  type FileTreeNode,
  type OpenedProject,
  type ProjectError,
  type ReadFileResult,
  type RecoveryAction,
  type TreeOptions,
} from "./types";
import { TRUST_RULES, TRUST_SUMMARY_INTRO, TRUST_SUMMARY_TITLE } from "./trust";

export type ProjectServiceOptions = {
  host: ProjectHost;
  recent: RecentProjectStore;
  treeOptions?: TreeOptions;
  /** Demo / fixture path offered as a recovery action when open fails. */
  demoProjectPath?: string;
};

export class ProjectService {
  private readonly host: ProjectHost;
  private readonly recent: RecentProjectStore;
  private readonly treeOptions: Required<TreeOptions>;
  private readonly demoProjectPath?: string;
  private opened: OpenedProject | null = null;

  constructor(options: ProjectServiceOptions) {
    this.host = options.host;
    this.recent = options.recent;
    this.treeOptions = { ...DEFAULT_TREE_OPTIONS, ...options.treeOptions };
    this.demoProjectPath = options.demoProjectPath;
  }

  getOpened(): OpenedProject | null {
    return this.opened;
  }

  listRecent(): string[] {
    return this.recent.list();
  }

  currentRecent(): string | null {
    return this.recent.current();
  }

  /** Drop recent entries that fail `keep` (e.g. Unix demo paths on Windows). */
  pruneRecent(keep: (path: string) => boolean): void {
    if (this.recent.prune) {
      this.recent.prune(keep);
      return;
    }
    // Fallback for stores without prune: clear if current is invalid.
    const items = this.recent.list().filter(keep);
    this.recent.clear();
    for (const p of items.reverse()) this.recent.remember(p);
  }

  trustSummary() {
    return {
      title: TRUST_SUMMARY_TITLE,
      intro: TRUST_SUMMARY_INTRO,
      rules: TRUST_RULES,
    };
  }

  /**
   * Validate a folder path and load tree + Git context.
   * Does not mark trust acknowledged — caller advances the trust step.
   */
  async open(rawPath: string): Promise<OpenedProject> {
    const path = rawPath.trim();
    if (!path) {
      throw this.error("path_empty", "Choose a local folder path to open as a Project.");
    }

    let resolved: string;
    try {
      resolved = await this.host.resolvePath(path);
    } catch (err) {
      throw this.error(
        "path_not_found",
        `Could not resolve path: ${messageOf(err)}`,
        path,
      );
    }

    const exists = await this.host.pathExists(resolved);
    if (!exists) {
      throw this.error(
        "path_not_found",
        `Folder not found: ${resolved}`,
        resolved,
      );
    }

    const isDir = await this.host.isDirectory(resolved);
    if (!isDir) {
      throw this.error(
        "path_not_directory",
        `Path is not a folder: ${resolved}`,
        resolved,
      );
    }

    let tree: FileTreeNode[];
    try {
      tree = await this.buildTree(resolved, 0);
    } catch (err) {
      throw this.error(
        "list_failed",
        `Could not list project files: ${messageOf(err)}`,
        resolved,
      );
    }

    let git = null;
    try {
      git = await this.host.readGitStatus(resolved);
    } catch (err) {
      // Non-fatal: Git surface must not block non-Git or flaky-git Projects.
      void err;
      git = null;
    }

    const name = baseName(resolved);
    const project: OpenedProject = {
      path: resolved,
      name,
      tree,
      git,
      openedAt: new Date().toISOString(),
      trustAcknowledged: false,
    };

    this.opened = project;
    this.recent.remember(resolved);
    return project;
  }

  /** Reopen the most recently used Project path. */
  async reopenCurrent(): Promise<OpenedProject> {
    const path = this.recent.current();
    if (!path) {
      throw this.error(
        "path_empty",
        "No recent Project to reopen. Choose a folder first.",
      );
    }
    return this.open(path);
  }

  acknowledgeTrust(): OpenedProject {
    if (!this.opened) {
      throw this.error(
        "path_empty",
        "Open a Project before confirming the trust summary.",
      );
    }
    this.opened = { ...this.opened, trustAcknowledged: true };
    return this.opened;
  }

  async refreshTree(): Promise<FileTreeNode[]> {
    if (!this.opened) {
      throw this.error("path_empty", "No Project is open.");
    }
    const tree = await this.buildTree(this.opened.path, 0);
    this.opened = { ...this.opened, tree };
    return tree;
  }

  async refreshGit(): Promise<OpenedProject["git"]> {
    if (!this.opened) {
      throw this.error("path_empty", "No Project is open.");
    }
    try {
      const git = await this.host.readGitStatus(this.opened.path);
      this.opened = { ...this.opened, git };
      return git;
    } catch {
      this.opened = { ...this.opened, git: null };
      return null;
    }
  }

  async readFile(relativeOrAbsolute: string): Promise<ReadFileResult> {
    if (!this.opened) {
      throw this.error("path_empty", "No Project is open.");
    }
    const full = resolveUnderProject(this.opened.path, relativeOrAbsolute);
    try {
      return await this.host.readFile(full);
    } catch (err) {
      throw this.error(
        "read_failed",
        `Could not open file: ${messageOf(err)}`,
        full,
      );
    }
  }

  close(): void {
    this.opened = null;
  }

  private async buildTree(
    dirPath: string,
    depth: number,
  ): Promise<FileTreeNode[]> {
    const { maxDepth, maxEntriesPerDir, ignoreNames } = this.treeOptions;
    const entries = await this.host.listDirectory(dirPath);
    const ignore = new Set(ignoreNames);

    const filtered = entries
      .filter((e) => !ignore.has(e.name))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const limited = filtered.slice(0, maxEntriesPerDir);
    const nodes: FileTreeNode[] = [];

    for (const entry of limited) {
      if (entry.kind === "directory" && depth + 1 < maxDepth) {
        try {
          const children = await this.buildTree(entry.path, depth + 1);
          nodes.push({ ...entry, children });
        } catch {
          nodes.push({ ...entry, children: [], truncated: true });
        }
      } else if (entry.kind === "directory") {
        nodes.push({ ...entry, truncated: true });
      } else {
        nodes.push({ ...entry });
      }
    }

    if (filtered.length > maxEntriesPerDir) {
      nodes.push({
        name: `… ${filtered.length - maxEntriesPerDir} more`,
        path: `${dirPath}/…`,
        kind: "file",
        truncated: true,
      });
    }

    return nodes;
  }

  private error(
    code: ProjectError["code"],
    message: string,
    path?: string,
  ): ProjectError {
    return {
      code,
      message,
      path,
      recovery: this.recoveryActions(path),
    };
  }

  private recoveryActions(failedPath?: string): RecoveryAction[] {
    const actions: RecoveryAction[] = [
      { id: "choose_other", label: "Choose another folder" },
    ];

    const recent = this.recent.list().filter((p) => p !== failedPath);
    if (recent[0]) {
      actions.push({
        id: "reopen_recent",
        label: `Reopen ${baseName(recent[0])}`,
        path: recent[0],
      });
    }

    if (
      this.demoProjectPath &&
      this.demoProjectPath !== failedPath &&
      !recent.includes(this.demoProjectPath)
    ) {
      actions.push({
        id: "open_demo",
        label: "Open demo project",
        path: this.demoProjectPath,
      });
    }

    actions.push({ id: "retry", label: "Retry", path: failedPath });
    return actions;
  }
}

export function isProjectError(err: unknown): err is ProjectError {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "recovery" in err &&
    "message" in err
  );
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

function baseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function resolveUnderProject(projectPath: string, target: string): string {
  if (
    target.startsWith(projectPath) ||
    /^[a-zA-Z]:[\\/]/.test(target) ||
    target.startsWith("/")
  ) {
    return target;
  }
  const sep = projectPath.includes("\\") ? "\\" : "/";
  return `${projectPath.replace(/[\\/]+$/, "")}${sep}${target.replace(
    /^[\\/]+/,
    "",
  )}`;
}
