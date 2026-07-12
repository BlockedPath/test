import type {
  FileChangeBatch,
  FileChangeKind,
  FileChangeRecord,
  FileDiff,
  RawFileChangeProposal,
} from "./types";

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function extractDiffFields(raw: RawFileChangeProposal): {
  path?: string;
  oldText?: string | null;
  newText?: string | null;
  destinationPath?: string;
} {
  const nested =
    raw.diff && typeof raw.diff === "object"
      ? (raw.diff as Record<string, unknown>)
      : null;

  const path =
    asOptionalString(raw.path) ??
    (nested ? asOptionalString(nested.path) : undefined);
  const oldText =
    raw.oldText !== undefined
      ? asNullableString(raw.oldText)
      : nested
        ? asNullableString(nested.oldText)
        : undefined;
  const newText =
    raw.newText !== undefined
      ? asNullableString(raw.newText)
      : nested
        ? asNullableString(nested.newText)
        : undefined;
  const destinationPath =
    asOptionalString(raw.destinationPath) ??
    (nested ? asOptionalString(nested.destinationPath) : undefined);

  return { path, oldText, newText, destinationPath };
}

function inferKind(
  explicit: unknown,
  fields: {
    oldText?: string | null;
    newText?: string | null;
    destinationPath?: string;
  },
): FileChangeKind {
  if (
    explicit === "create" ||
    explicit === "edit" ||
    explicit === "delete" ||
    explicit === "move"
  ) {
    return explicit;
  }
  if (fields.destinationPath) return "move";
  if (fields.newText === null) return "delete";
  if (
    (fields.oldText === null || fields.oldText === undefined) &&
    typeof fields.newText === "string"
  ) {
    return "create";
  }
  return "edit";
}

let changeSeq = 0;

function nextChangeId(seed?: string): string {
  if (seed && seed.trim()) return seed;
  changeSeq += 1;
  return `change-${changeSeq}`;
}

/**
 * Normalize one edit/delete/move/create proposal into a FileChangeRecord.
 * Malformed proposals are kept for review but left unselected.
 */
export function normalizeFileChange(
  raw: RawFileChangeProposal,
  options: { changeId?: string } = {},
): FileChangeRecord {
  const fields = extractDiffFields(raw);
  const path = fields.path?.trim() ?? "";
  const kind = inferKind(raw.kind, fields);
  const toolCallId = asOptionalString(raw.toolCallId);
  const changeId = nextChangeId(
    options.changeId ?? asOptionalString(raw.changeId) ?? toolCallId,
  );

  if (!path) {
    return {
      changeId,
      path: "",
      kind,
      status: "pending",
      selected: false,
      malformed: true,
      malformedReason: "Missing or invalid path",
      toolCallId,
    };
  }

  if (kind === "move" && !fields.destinationPath?.trim()) {
    return {
      changeId,
      path,
      kind,
      status: "pending",
      selected: false,
      malformed: true,
      malformedReason: "Move requires destinationPath",
      toolCallId,
      diff: {
        path,
        oldText: fields.oldText ?? null,
        newText: fields.newText ?? null,
      },
    };
  }

  const diff: FileDiff = {
    path,
    oldText:
      fields.oldText === undefined
        ? kind === "create"
          ? null
          : undefined
        : fields.oldText,
    newText:
      fields.newText === undefined
        ? kind === "delete"
          ? null
          : undefined
        : fields.newText,
  };
  if (fields.destinationPath) {
    diff.destinationPath = fields.destinationPath;
  }

  return {
    changeId,
    path,
    kind,
    status: "pending",
    selected: true,
    malformed: false,
    toolCallId,
    diff,
  };
}

export type NormalizeBatchInput = {
  batchId: string;
  title: string;
  requestId?: string;
  turnId?: string;
  proposals: RawFileChangeProposal[];
};

/** Normalize a multi-file proposal into a pending review batch. */
export function normalizeFileChangeBatch(
  input: NormalizeBatchInput,
): FileChangeBatch {
  const changes = input.proposals.map((p, index) =>
    normalizeFileChange(p, {
      changeId: asOptionalString(p.changeId) ?? `${input.batchId}-${index + 1}`,
    }),
  );

  return {
    batchId: input.batchId,
    requestId: input.requestId,
    turnId: input.turnId,
    title: input.title,
    changes,
    status: "pending",
  };
}
