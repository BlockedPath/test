import type { FileWriteHost } from "./types";

/** In-memory FileWriteHost for tests and browser demos. */
export function createMemoryFileWriteHost(
  initial: Record<string, string> = {},
): FileWriteHost & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async writeTextFile(path, content) {
      files.set(path, content);
    },
    async deleteFile(path) {
      if (!files.has(path)) {
        // Allow delete of paths not preloaded (proposed delete).
        files.delete(path);
        return;
      }
      files.delete(path);
    },
    async moveFile(from, to) {
      const content = files.get(from) ?? "";
      files.delete(from);
      files.set(to, content);
    },
  };
}
