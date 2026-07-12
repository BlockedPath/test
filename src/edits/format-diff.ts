import type { DiffLine, FileChangeRecord, FileDiff } from "./types";

/**
 * Produce a simple line-oriented diff for inline / expanded review.
 * Not a full Myers diff — readable enough for review surfaces.
 */
export function formatDiffLines(diff: FileDiff): DiffLine[] {
  const lines: DiffLine[] = [];
  lines.push({ type: "meta", text: `--- ${diff.path}` });
  if (diff.destinationPath) {
    lines.push({ type: "meta", text: `+++ ${diff.destinationPath}` });
  } else {
    lines.push({ type: "meta", text: `+++ ${diff.path}` });
  }

  const oldText = diff.oldText ?? "";
  const newText = diff.newText ?? "";
  const isCreate = diff.oldText === null || diff.oldText === undefined;
  const isDelete = diff.newText === null;

  if (isCreate && typeof diff.newText === "string") {
    lines.push({ type: "hunk", text: "@@ new file @@" });
    for (const line of splitLines(diff.newText)) {
      lines.push({ type: "add", text: `+${line}` });
    }
    return lines;
  }

  if (isDelete) {
    lines.push({ type: "hunk", text: "@@ deleted file @@" });
    for (const line of splitLines(oldText)) {
      lines.push({ type: "del", text: `-${line}` });
    }
    return lines;
  }

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  lines.push({
    type: "hunk",
    text: `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  });

  // Naive: show all deletions then all additions when texts differ; identity as context.
  if (oldText === newText) {
    for (const line of oldLines) {
      lines.push({ type: "ctx", text: ` ${line}` });
    }
    return lines;
  }

  for (const line of oldLines) {
    lines.push({ type: "del", text: `-${line}` });
  }
  for (const line of newLines) {
    lines.push({ type: "add", text: `+${line}` });
  }
  return lines;
}

export function formatChangeDiff(change: FileChangeRecord): DiffLine[] {
  if (change.malformed) {
    return [
      {
        type: "meta",
        text: `malformed: ${change.malformedReason ?? "invalid proposal"}`,
      },
    ];
  }
  if (!change.diff) {
    return [{ type: "meta", text: `(no diff for ${change.path})` }];
  }
  return formatDiffLines(change.diff);
}

function splitLines(text: string): string[] {
  if (text === "") return [""];
  const parts = text.split("\n");
  // Preserve trailing empty from final newline as a blank line only if mid content.
  if (parts.length > 1 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}
