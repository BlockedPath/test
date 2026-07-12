/**
 * Tauri-backed FileWriteHost for applying approved multi-file edits.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FileWriteHost } from "./types";

export function createTauriFileWriteHost(): FileWriteHost {
  return {
    async writeTextFile(path: string, content: string) {
      await invoke("host_write_text", { path, content });
    },
    async deleteFile(path: string) {
      await invoke("host_delete_file", { path });
    },
    async moveFile(from: string, to: string) {
      await invoke("host_move_file", { from, to });
    },
  };
}
