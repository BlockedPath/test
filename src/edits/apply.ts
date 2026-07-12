import type { FileChangeBatch, FileChangeRecord, FileWriteHost } from "./types";

export type ApplyResult = {
  batch: FileChangeBatch;
};

async function applyOne(
  change: FileChangeRecord,
  host: FileWriteHost,
): Promise<FileChangeRecord> {
  if (change.malformed || !change.selected || change.status !== "pending") {
    return {
      ...change,
      status: change.status === "pending" ? "skipped" : change.status,
      selected: false,
    };
  }

  try {
    switch (change.kind) {
      case "create":
      case "edit": {
        const content = change.diff?.newText;
        if (typeof content !== "string") {
          return {
            ...change,
            status: "failed",
            selected: false,
            errorMessage: "Missing newText for write",
          };
        }
        await host.writeTextFile(change.path, content);
        break;
      }
      case "delete": {
        await host.deleteFile(change.path);
        break;
      }
      case "move": {
        const dest = change.diff?.destinationPath;
        if (!dest) {
          return {
            ...change,
            status: "failed",
            selected: false,
            errorMessage: "Missing destinationPath for move",
          };
        }
        await host.moveFile(change.path, dest);
        // If content also changed, write the new body at destination.
        if (
          typeof change.diff?.newText === "string" &&
          change.diff.newText !== change.diff.oldText
        ) {
          await host.writeTextFile(dest, change.diff.newText);
        }
        break;
      }
      default: {
        const _never: never = change.kind;
        void _never;
        return {
          ...change,
          status: "failed",
          selected: false,
          errorMessage: `Unknown kind`,
        };
      }
    }
    return { ...change, status: "applied", selected: false };
  } catch (err) {
    return {
      ...change,
      status: "failed",
      selected: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Apply only selected, well-formed pending changes.
 * Unselected pending files become skipped; failures are marked failed.
 * Already-resolved batches are returned unchanged.
 */
export async function applySelectedChanges(
  batch: FileChangeBatch,
  host: FileWriteHost,
): Promise<ApplyResult> {
  if (batch.status !== "pending") {
    return { batch };
  }

  const changes: FileChangeRecord[] = [];
  for (const change of batch.changes) {
    changes.push(await applyOne(change, host));
  }

  return {
    batch: {
      ...batch,
      status: "resolved",
      changes,
    },
  };
}
