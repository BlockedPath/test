/**
 * In-memory ProjectHost for tests and browser demo without native FS.
 */

import type { ProjectHost } from "./host";
import type {
  FileEntry,
  FileKind,
  GitWorkingTree,
  ReadFileResult,
} from "./types";

export type MemoryNode = {
  kind: FileKind;
  /** File contents when kind === "file" */
  content?: string;
  children?: Record<string, MemoryNode>;
};

export type MemoryHostOptions = {
  /** Absolute-style path roots → directory trees */
  roots: Record<string, MemoryNode>;
  /** Optional Git status keyed by project root path */
  gitByRoot?: Record<string, GitWorkingTree | null>;
};

function norm(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}

export function createMemoryProjectHost(
  options: MemoryHostOptions,
): ProjectHost {
  const roots = new Map(
    Object.entries(options.roots).map(([k, v]) => [norm(k), v]),
  );
  const gitByRoot = new Map(
    Object.entries(options.gitByRoot ?? {}).map(([k, v]) => [norm(k), v]),
  );

  function find(
    path: string,
  ): { rootPath: string; node: MemoryNode } | null {
    const p = norm(path);
    // Longest root prefix match
    const rootPaths = [...roots.keys()].sort((a, b) => b.length - a.length);
    for (const rootPath of rootPaths) {
      if (p === rootPath) {
        return { rootPath, node: roots.get(rootPath)! };
      }
      if (p.startsWith(rootPath + "/")) {
        const rel = p.slice(rootPath.length + 1).split("/");
        let node = roots.get(rootPath)!;
        for (const part of rel) {
          if (node.kind !== "directory" || !node.children?.[part]) {
            return null;
          }
          node = node.children[part];
        }
        return { rootPath, node };
      }
    }
    return null;
  }

  return {
    async resolvePath(path: string) {
      const trimmed = path.trim();
      if (!trimmed) throw new Error("Empty path");
      return norm(trimmed);
    },

    async pathExists(path: string) {
      return find(path) !== null;
    },

    async isDirectory(path: string) {
      const hit = find(path);
      return hit?.node.kind === "directory";
    },

    async listDirectory(path: string) {
      const hit = find(path);
      if (!hit) throw new Error(`Directory not found: ${path}`);
      if (hit.node.kind !== "directory") {
        throw new Error(`Not a directory: ${path}`);
      }
      const base = norm(path);
      const children = hit.node.children ?? {};
      const entries: FileEntry[] = Object.entries(children).map(
        ([name, child]) => ({
          name,
          path: `${base}/${name}`,
          kind: child.kind,
        }),
      );
      return entries;
    },

    async readFile(path: string, maxBytes = 256 * 1024): Promise<ReadFileResult> {
      const hit = find(path);
      if (!hit) throw new Error(`File not found: ${path}`);
      if (hit.node.kind !== "file") throw new Error(`Not a file: ${path}`);
      const full = hit.node.content ?? "";
      const sizeBytes = new TextEncoder().encode(full).length;
      const truncated = sizeBytes > maxBytes;
      const content = truncated ? full.slice(0, maxBytes) : full;
      return { path: norm(path), content, truncated, sizeBytes };
    },

    async readGitStatus(projectPath: string) {
      const p = norm(projectPath);
      if (gitByRoot.has(p)) return gitByRoot.get(p) ?? null;
      // Walk up to a known root
      for (const [root, status] of gitByRoot) {
        if (p === root || p.startsWith(root + "/")) return status;
      }
      return null;
    },
  };
}

/** Demo Project used by the web shell when native FS is unavailable. */
export const DEMO_PROJECT_PATH = "/tmp/grok-gui-demo-project";

export function createDemoProjectHost(): ProjectHost {
  return createMemoryProjectHost({
    roots: {
      [DEMO_PROJECT_PATH]: {
        kind: "directory",
        children: {
          "README.md": {
            kind: "file",
            content:
              "# demo-api\n\nSample Project for Grok GUI local context.\n\nSafe reads are automatic. Edits and commands need approval.\n",
          },
          "package.json": {
            kind: "file",
            content: `${JSON.stringify(
              {
                name: "demo-api",
                private: true,
                scripts: { test: "node --test" },
              },
              null,
              2,
            )}\n`,
          },
          src: {
            kind: "directory",
            children: {
              "server.js": {
                kind: "file",
                content:
                  "const http = require('http');\n\nfunction createServer() {\n  return http.createServer((req, res) => {\n    res.end('ok');\n  });\n}\n\nmodule.exports = { createServer };\n",
              },
              "routes.js": {
                kind: "file",
                content:
                  "function health() {\n  return { ok: true };\n}\n\nmodule.exports = { health };\n",
              },
            },
          },
          ".gitignore": {
            kind: "file",
            content: "node_modules/\n",
          },
        },
      },
    },
    gitByRoot: {
      [DEMO_PROJECT_PATH]: {
        isRepo: true,
        branch: "main",
        dirty: true,
        ahead: 0,
        behind: 0,
        entries: [
          { path: "src/server.js", code: " M" },
          { path: "README.md", code: "??" },
        ],
        summary: "main · 2 changes",
      },
    },
  });
}

/** Non-Git demo root for tests that assert Git is optional. */
export const NON_GIT_DEMO_PATH = "/tmp/grok-gui-nongit-project";

export function withNonGitDemo(host: ProjectHost): ProjectHost {
  const extra = createMemoryProjectHost({
    roots: {
      [NON_GIT_DEMO_PATH]: {
        kind: "directory",
        children: {
          "notes.txt": {
            kind: "file",
            content: "plain folder without git\n",
          },
        },
      },
    },
    gitByRoot: {
      [NON_GIT_DEMO_PATH]: null,
    },
  });

  return {
    resolvePath: (p) =>
      p.trim().startsWith(NON_GIT_DEMO_PATH)
        ? extra.resolvePath(p)
        : host.resolvePath(p),
    pathExists: async (p) =>
      (await extra.pathExists(p)) || (await host.pathExists(p)),
    isDirectory: async (p) =>
      (await extra.isDirectory(p)) || (await host.isDirectory(p)),
    listDirectory: async (p) => {
      if (await extra.pathExists(p)) return extra.listDirectory(p);
      return host.listDirectory(p);
    },
    readFile: async (p, max) => {
      if (await extra.pathExists(p)) return extra.readFile(p, max);
      return host.readFile(p, max);
    },
    readGitStatus: async (p) => {
      if (normPath(p) === NON_GIT_DEMO_PATH || p.startsWith(NON_GIT_DEMO_PATH)) {
        return extra.readGitStatus(p);
      }
      return host.readGitStatus(p);
    },
  };
}

function normPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
}
