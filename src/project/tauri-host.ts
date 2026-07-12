/**
 * Tauri-backed ProjectHost — real Windows filesystem + git porcelain.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ProjectHost } from "./host";
import type {
  FileEntry,
  GitFileStatus,
  GitWorkingTree,
  ReadFileResult,
} from "./types";

type FileEntryDto = { name: string; path: string; kind: string };
type ReadFileDto = {
  path: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
};
type ExecResult = { stdout: string; stderr: string; exitCode: number };

export function createTauriProjectHost(): ProjectHost {
  return {
    async resolvePath(path: string) {
      return invoke<string>("host_resolve_path", { path });
    },

    async pathExists(path: string) {
      return invoke<boolean>("host_path_any_exists", { path });
    },

    async isDirectory(path: string) {
      return invoke<boolean>("host_path_is_dir", { path });
    },

    async listDirectory(path: string) {
      const entries = await invoke<FileEntryDto[]>("host_list_dir", { path });
      return entries.map(
        (e): FileEntry => ({
          name: e.name,
          path: e.path,
          kind: e.kind === "directory" ? "directory" : "file",
        }),
      );
    },

    async readFile(path: string, maxBytes = 256 * 1024): Promise<ReadFileResult> {
      const result = await invoke<ReadFileDto>("host_read_file", {
        path,
        maxBytes,
      });
      return {
        path: result.path,
        content: result.content,
        truncated: result.truncated,
        sizeBytes: result.sizeBytes,
      };
    },

    async readGitStatus(projectPath: string): Promise<GitWorkingTree | null> {
      try {
        const check = await invoke<ExecResult>("host_exec", {
          program: "git",
          args: ["-C", projectPath, "rev-parse", "--is-inside-work-tree"],
          cwd: null,
        });
        if (check.exitCode !== 0) return null;
      } catch {
        return null;
      }

      let branch: string | null = null;
      try {
        const { stdout } = await invoke<ExecResult>("host_exec", {
          program: "git",
          args: ["-C", projectPath, "branch", "--show-current"],
          cwd: null,
        });
        branch = stdout.trim() || null;
      } catch {
        branch = null;
      }

      let ahead = 0;
      let behind = 0;
      try {
        const { stdout } = await invoke<ExecResult>("host_exec", {
          program: "git",
          args: [
            "-C",
            projectPath,
            "rev-list",
            "--left-right",
            "--count",
            "@{upstream}...HEAD",
          ],
          cwd: null,
        });
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 2) {
          behind = Number(parts[0]) || 0;
          ahead = Number(parts[1]) || 0;
        }
      } catch {
        /* no upstream */
      }

      let entries: GitFileStatus[] = [];
      try {
        const { stdout } = await invoke<ExecResult>("host_exec", {
          program: "git",
          args: ["-C", projectPath, "status", "--porcelain=v1", "-uall"],
          cwd: null,
        });
        entries = stdout
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter(Boolean)
          .map((line) => {
            const code = line.slice(0, 2);
            const rest = line.slice(3);
            const path = rest.includes(" -> ")
              ? rest.split(" -> ").pop()!
              : rest;
            return { path, code };
          });
      } catch {
        entries = [];
      }

      const dirty = entries.length > 0;
      const branchLabel = branch ?? "detached";
      const changePart = dirty
        ? `${entries.length} change${entries.length === 1 ? "" : "s"}`
        : "clean";
      const ab = ahead || behind ? ` · ↑${ahead} ↓${behind}` : "";
      const summary = `${branchLabel} · ${changePart}${ab}`;

      return {
        isRepo: true,
        branch,
        dirty,
        ahead,
        behind,
        entries: entries.slice(0, 100),
        summary,
      };
    },
  };
}
