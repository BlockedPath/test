/**
 * Pure Session safety policy: classify + decide for reads, writes, commands.
 */

import {
  isCredentialAdjacentPath,
  isInsideProject,
  resolveAgainstProject,
} from "./paths";
import {
  classifyCommandElevation,
  commandFingerprint,
  parseCommandLine,
} from "./commands";
import { containsRawSecret } from "./secrets";
import type {
  PolicyDecision,
  SafetyAction,
  SessionSafetyState,
  YoloEnableRequest,
  YoloEnableResult,
} from "./types";
import { YOLO_WARNING } from "./types";

export { YOLO_WARNING };

export function createSessionSafetyState(projectPath: string): SessionSafetyState {
  return {
    projectPath,
    yoloEnabled: false,
    commandAllowlist: [],
  };
}

/**
 * Enable/disable YOLO for a Session.
 * Enabling requires explicit warning acknowledgment.
 */
export function applyYoloChange(
  state: SessionSafetyState,
  request: YoloEnableRequest,
): { state: SessionSafetyState; result: YoloEnableResult } {
  if (!request.enabled) {
    return {
      state: { ...state, yoloEnabled: false },
      result: { ok: true, enabled: false },
    };
  }
  if (!request.acknowledgeWarning) {
    return {
      state,
      result: {
        ok: false,
        reason:
          "YOLO requires explicit warning confirmation before it can be enabled",
      },
    };
  }
  return {
    state: { ...state, yoloEnabled: true },
    result: { ok: true, enabled: true },
  };
}

/** Emergency Stop / new Session: clear YOLO and allowlists. */
export function resetSessionSafety(
  state: SessionSafetyState,
): SessionSafetyState {
  return {
    projectPath: state.projectPath,
    yoloEnabled: false,
    commandAllowlist: [],
  };
}

/**
 * Record a narrow "allow similar" entry. Elevated / hard-blocked commands
 * are rejected and never stored.
 */
export function rememberAllowSimilar(
  state: SessionSafetyState,
  command: string,
  args?: string[],
): { state: SessionSafetyState; added: boolean; reason?: string } {
  const elevation = classifyCommandElevation(command, args);
  if (elevation) {
    return {
      state,
      added: false,
      reason: "Elevated actions are never covered by a normal Session allowlist",
    };
  }
  const cwd = state.projectPath;
  // Outside-project cwd commands are elevated-scoped for allowlist purposes.
  const parsed =
    args === undefined && command.includes(" ")
      ? parseCommandLine(command)
      : { command, args: args ?? [] };
  const fp = commandFingerprint(parsed.command, parsed.args);
  if (state.commandAllowlist.includes(fp)) {
    return { state, added: false, reason: "Already on Session allowlist" };
  }
  void cwd;
  return {
    state: {
      ...state,
      commandAllowlist: [...state.commandAllowlist, fp],
    },
    added: true,
  };
}

function allowDecision(
  tier: "auto" | "normal",
  source: "policy" | "yolo" | "allowlist",
  reason: string,
): PolicyDecision {
  return { decision: "allow", tier, source, reason };
}

function promptDecision(
  tier: "normal" | "elevated",
  reason: string,
  allowSimilarEligible: boolean,
): PolicyDecision {
  return {
    decision: "prompt",
    tier,
    source: "policy",
    reason,
    allowSimilarEligible,
  };
}

function hardBlock(reason: string): PolicyDecision {
  return {
    decision: "hard_block",
    tier: "hard_block",
    source: "policy",
    reason,
  };
}

/**
 * Decide whether an action may proceed automatically, needs a prompt,
 * or is hard-blocked. YOLO only auto-allows normal in-Project edit/command.
 */
export function decideAction(
  state: SessionSafetyState,
  action: SafetyAction,
): PolicyDecision {
  switch (action.kind) {
    case "read":
      return decideRead(state, action.path);
    case "write":
    case "edit":
    case "create":
    case "delete":
    case "move":
      return decideWrite(state, action);
    case "command":
      return decideCommand(state, action.command, action.args, action.cwd);
    default: {
      const _never: never = action;
      void _never;
      return hardBlock("Unknown action kind");
    }
  }
}

function decideRead(state: SessionSafetyState, targetPath: string): PolicyDecision {
  if (containsRawSecret(targetPath)) {
    return hardBlock("Raw secret material in path is hard-blocked");
  }
  if (isInsideProject(state.projectPath, targetPath)) {
    // In-Project reads are automatic (including credential-adjacent; content
    // redaction still applies when values surface in activity/logs).
    return allowDecision(
      "auto",
      "policy",
      "In-Project reads are automatic",
    );
  }
  return promptDecision(
    "normal",
    "Outside-Project reads require approval",
    false,
  );
}

function decideWrite(
  state: SessionSafetyState,
  action: Extract<
    SafetyAction,
    { kind: "write" | "edit" | "create" | "delete" | "move" }
  >,
): PolicyDecision {
  const paths = [action.path];
  if (action.destinationPath) paths.push(action.destinationPath);

  for (const p of paths) {
    if (containsRawSecret(p)) {
      return hardBlock("Raw secret material in path is hard-blocked");
    }
  }

  if (containsRawSecret(action.content ?? null)) {
    return hardBlock(
      "Raw credential material in write content is hard-blocked",
    );
  }

  const outside = paths.some(
    (p) => !isInsideProject(state.projectPath, p),
  );
  const credential = paths.some((p) => isCredentialAdjacentPath(p));

  if (outside) {
    return promptDecision(
      "elevated",
      "Outside-Project writes require elevated approval",
      false,
    );
  }

  if (credential) {
    return promptDecision(
      "elevated",
      "Credential-adjacent paths require elevated approval",
      false,
    );
  }

  // Destructive delete of non-credential in-project files is still a normal
  // edit flow (batch review), not elevated — elevated covers outside/credential/
  // destructive *commands*. Spec: multi-file edit with per-file selection.
  if (state.yoloEnabled) {
    return allowDecision(
      "normal",
      "yolo",
      "YOLO bypasses normal in-Project edit prompts",
    );
  }

  return promptDecision(
    "normal",
    "In-Project file changes require approval",
    false,
  );
}

function decideCommand(
  state: SessionSafetyState,
  command: string,
  args: string[] | undefined,
  cwd: string | null | undefined,
): PolicyDecision {
  if (!command.trim()) {
    return hardBlock("Empty command is hard-blocked");
  }

  const line =
    args && args.length > 0 ? [command, ...args].join(" ") : command;
  if (containsRawSecret(line)) {
    return hardBlock("Raw secret material in command is hard-blocked");
  }

  const elevation = classifyCommandElevation(command, args);
  if (elevation) {
    // Elevated: never allowlist, never YOLO.
    return promptDecision("elevated", elevation, false);
  }

  const workdir = cwd?.trim() ? cwd : state.projectPath;
  if (!isInsideProject(state.projectPath, workdir)) {
    return promptDecision(
      "elevated",
      "Commands outside the Project require elevated approval",
      false,
    );
  }

  // Outside-project path arguments on an otherwise normal command stay elevated
  // when the argv clearly targets an absolute path outside the project.
  const argv = args ?? parseCommandLine(command).args;
  for (const arg of argv) {
    if (
      (arg.startsWith("/") || /^[A-Za-z]:[\\/]/.test(arg)) &&
      !isInsideProject(state.projectPath, arg) &&
      !arg.startsWith("-")
    ) {
      return promptDecision(
        "elevated",
        "Command arguments target paths outside the Project",
        false,
      );
    }
  }

  const parsed =
    args === undefined && /\s/.test(command.trim())
      ? parseCommandLine(command)
      : { command, args: args ?? [] };
  const fp = commandFingerprint(parsed.command, parsed.args);

  if (state.commandAllowlist.includes(fp)) {
    return allowDecision(
      "normal",
      "allowlist",
      "Session allowlist covers this project-local command",
    );
  }

  if (state.yoloEnabled) {
    return allowDecision(
      "normal",
      "yolo",
      "YOLO bypasses normal project-local command prompts",
    );
  }

  return promptDecision(
    "normal",
    "Project-local commands prompt by default",
    true,
  );
}

/**
 * Multi-file batch: never silently broaden selection.
 * Returns per-path decisions; caller must not apply files that are not allow.
 */
export function decideFileBatch(
  state: SessionSafetyState,
  files: Array<{
    path: string;
    kind?: "write" | "edit" | "create" | "delete" | "move";
    content?: string | null;
    selected: boolean;
    destinationPath?: string | null;
  }>,
): {
  perFile: Array<{ path: string; selected: boolean; decision: PolicyDecision }>;
  /** Files that may be written now (selected + allowed by policy). */
  writablePaths: string[];
  /** True when any selected file still needs an elevated prompt. */
  needsElevatedPrompt: boolean;
  /** True when any selected file is hard-blocked. */
  hasHardBlock: boolean;
  /** True when any selected normal file still needs a normal prompt. */
  needsNormalPrompt: boolean;
} {
  const perFile = files.map((f) => {
    const decision = decideAction(state, {
      kind: f.kind ?? "edit",
      path: f.path,
      content: f.content,
      destinationPath: f.destinationPath,
    });
    return { path: f.path, selected: f.selected, decision };
  });

  const selected = perFile.filter((f) => f.selected);
  const writablePaths = selected
    .filter((f) => f.decision.decision === "allow")
    .map((f) => f.path);
  const needsElevatedPrompt = selected.some(
    (f) => f.decision.decision === "prompt" && f.decision.tier === "elevated",
  );
  const hasHardBlock = selected.some(
    (f) => f.decision.decision === "hard_block",
  );
  const needsNormalPrompt = selected.some(
    (f) => f.decision.decision === "prompt" && f.decision.tier === "normal",
  );

  return {
    perFile,
    writablePaths,
    needsElevatedPrompt,
    hasHardBlock,
    needsNormalPrompt,
  };
}

/**
 * Given a pending permission-shaped request, map kind/title/preview into an action.
 * Used by engines so YOLO / allowlist share one code path with pure tests.
 */
export function actionFromPermission(input: {
  kind?: string;
  title?: string;
  preview?: unknown;
  projectPath: string;
}): SafetyAction {
  const kind = (input.kind ?? "").toLowerCase();
  const preview =
    input.preview && typeof input.preview === "object"
      ? (input.preview as Record<string, unknown>)
      : {};

  if (kind === "read" || kind === "search") {
    const path =
      stringField(preview, "path") ??
      firstLocationPath(preview) ??
      extractPathFromTitle(input.title) ??
      ".";
    return { kind: "read", path };
  }

  if (
    kind === "execute" ||
    (kind === "other" && /command|run|exec/i.test(input.title ?? ""))
  ) {
    const command =
      stringField(preview, "command") ??
      extractCommandFromTitle(input.title) ??
      input.title ??
      "";
    const args = Array.isArray(preview.args)
      ? preview.args.map(String)
      : undefined;
    const cwd = stringField(preview, "cwd");
    return { kind: "command", command, args, cwd };
  }

  if (
    kind === "edit" ||
    kind === "delete" ||
    kind === "move" ||
    kind === "write"
  ) {
    const path =
      stringField(preview, "path") ??
      firstLocationPath(preview) ??
      extractPathFromTitle(input.title) ??
      ".";
    const content =
      stringField(preview, "newText") ??
      stringField(preview, "content") ??
      null;
    return {
      kind: kind === "write" ? "edit" : (kind as "edit" | "delete" | "move"),
      path,
      content,
      destinationPath: stringField(preview, "destinationPath"),
    };
  }

  // Fallback: treat as command if title looks like one, else elevated-ish edit.
  if (/run |execute |command/i.test(input.title ?? "")) {
    return {
      kind: "command",
      command: extractCommandFromTitle(input.title) ?? input.title ?? "",
      cwd: stringField(preview, "cwd") ?? input.projectPath,
    };
  }

  const path =
    stringField(preview, "path") ??
    firstLocationPath(preview) ??
    ".";
  return { kind: "edit", path, content: stringField(preview, "newText") };
}

function stringField(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function firstLocationPath(preview: Record<string, unknown>): string | undefined {
  const locs = preview.locations;
  if (Array.isArray(locs) && locs[0] && typeof locs[0] === "object") {
    const p = (locs[0] as { path?: unknown }).path;
    if (typeof p === "string") return p;
  }
  return undefined;
}

function extractPathFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const m = title.match(/(?:['"`])([^'"`]+)(?:['"`])|(\/[^\s]+|[A-Za-z]:\\[^\s]+)/);
  return m?.[1] ?? m?.[2];
}

function extractCommandFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const m = title.match(
    /(?:command|run|execute)\s*[:=]?\s*`?([^`]+)`?/i,
  );
  if (m?.[1]) return m[1].trim();
  const colon = title.match(/:\s*(.+)$/);
  return colon?.[1]?.trim();
}

export { resolveAgainstProject, isInsideProject, commandFingerprint };
