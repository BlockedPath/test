import type { FileChangeBatch, FileChangeRecord, FileWriteHost } from "./types";
import {
  createSessionSafetyState,
  decideAction,
  type SessionSafetyState,
} from "../safety";

export type ApplyResult = {
  batch: FileChangeBatch;
};

export type ApplySafetyOptions = {
  /** When set, enforce Session safety policy before writing. */
  safety?: SessionSafetyState;
  /** Convenience: build a safety state from Project path (YOLO off). */
  projectPath?: string;
};

async function applyOne(
  change: FileChangeRecord,
  host: FileWriteHost,
  safety: SessionSafetyState | null,
): Promise<FileChangeRecord> {
  if (change.malformed || !change.selected || change.status !== "pending") {
    return {
      ...change,
      status: change.status === "pending" ? "skipped" : change.status,
      selected: false,
    };
  }

  if (safety) {
    const decision = decideAction(safety, {
      kind: change.kind === "create" ? "create" : change.kind,
      path: change.path,
      content: change.diff?.newText,
      destinationPath: change.diff?.destinationPath,
    });
    if (decision.decision === "hard_block") {
      return {
        ...change,
        status: "failed",
        selected: false,
        errorMessage: decision.reason,
      };
    }
    // Elevated outside-project / credential paths must not be applied via the
    // normal multi-file batch without a separate elevated decision.
    if (decision.decision === "prompt" && decision.tier === "elevated") {
      return {
        ...change,
        status: "failed",
        selected: false,
        errorMessage: decision.reason,
      };
    }
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
 * Never silently broadens selection; optional safety blocks elevated/hard paths.
 */
export async function applySelectedChanges(
  batch: FileChangeBatch,
  host: FileWriteHost,
  options?: ApplySafetyOptions,
): Promise<ApplyResult> {
  if (batch.status !== "pending") {
    return { batch };
  }

  const safety =
    options?.safety ??
    (options?.projectPath
      ? createSessionSafetyState(options.projectPath)
      : null);

  const changes: FileChangeRecord[] = [];
  for (const change of batch.changes) {
    changes.push(await applyOne(change, host, safety));
  }

  return {
    batch: {
      ...batch,
      status: "resolved",
      changes,
    },
  };
}
