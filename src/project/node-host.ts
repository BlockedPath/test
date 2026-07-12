/**
 * Node.js ProjectHost using fs and git porcelain.
 * Used by tests and any Node-side runner.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectHost } from "./host";
import type {
  FileEntry,
  GitFileStatus,
  GitWorkingTree,
  ReadFileResult,
} from "./types";

const execFileAsync = promisify(execFile);

export function createNodeProjectHost(): ProjectHost {
  return {
    async resolvePath(path: string) {
      return resolve(path.trim());
    },

    async pathExists(path: string) {
      return existsSync(path);
    },

    async isDirectory(path: string) {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },

    async listDirectory(path: string) {
      const names = readdirSync(path);
      const entries: FileEntry[] = [];
      for (const name of names) {
        const full = join(path, name);
        let kind: FileEntry["kind"] = "file";
        try {
          kind = statSync(full).isDirectory() ? "directory" : "file";
        } catch {
          continue;
        }
        entries.push({ name, path: full, kind });
      }
      return entries;
    },

    async readFile(path: string, maxBytes = 256 * 1024): Promise<ReadFileResult> {
      const buf = readFileSync(path);
      const truncated = buf.byteLength > maxBytes;
      const slice = truncated ? buf.subarray(0, maxBytes) : buf;
      return {
        path,
        content: slice.toString("utf8"),
        truncated,
        sizeBytes: buf.byteLength,
      };
    },

    async readGitStatus(projectPath: string): Promise<GitWorkingTree | null> {
      try {
        await execFileAsync("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], {
          timeout: 5_000,
        });
      } catch {
        return null;
      }

      let branch: string | null = null;
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", projectPath, "branch", "--show-current"],
          { timeout: 5_000 },
        );
        branch = stdout.trim() || null;
      } catch {
        branch = null;
      }

      let ahead = 0;
      let behind = 0;
      try {
        const { stdout } = await execFileAsync(
          "git",
          [
            "-C",
            projectPath,
            "rev-list",
            "--left-right",
            "--count",
            "@{upstream}...HEAD",
          ],
          { timeout: 5_000 },
        );
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 2) {
          behind = Number(parts[0]) || 0;
          ahead = Number(parts[1]) || 0;
        }
      } catch {
        /* no upstream — fine */
      }

      let entries: GitFileStatus[] = [];
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", projectPath, "status", "--porcelain=v1", "-uall"],
          { timeout: 10_000 },
        );
        entries = stdout
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter(Boolean)
          .map((line) => {
            const code = line.slice(0, 2);
            const rest = line.slice(3);
            // Rename lines: "R  old -> new"
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
      const ab =
        ahead || behind
          ? ` · ↑${ahead} ↓${behind}`
          : "";
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

/** Convenience: basename for UI without importing path in browser code. */
export function nodeBaseName(path: string): string {
  return basename(path);
}
