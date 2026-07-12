/**
 * Session safety policy vocabulary.
 * One path for reads, edits, commands, elevated actions, hard blocks, YOLO.
 */

export type PolicyTier = "auto" | "normal" | "elevated" | "hard_block";

export type PolicySource =
  | "policy"
  | "yolo"
  | "allowlist"
  | "user"
  | "cancel";

/** Classified agent action presented to the policy. */
export type SafetyAction =
  | {
      kind: "read";
      path: string;
    }
  | {
      kind: "write" | "edit" | "create" | "delete" | "move";
      path: string;
      /** Optional body inspected for raw secret material. */
      content?: string | null;
      destinationPath?: string | null;
    }
  | {
      kind: "command";
      command: string;
      args?: string[];
      cwd?: string | null;
    };

export type PolicyDecision =
  | {
      decision: "allow";
      tier: PolicyTier;
      source: Extract<PolicySource, "policy" | "yolo" | "allowlist">;
      reason: string;
    }
  | {
      decision: "prompt";
      tier: "normal" | "elevated";
      source: "policy";
      reason: string;
      /** Only normal project-local commands may be "allow similar" listed. */
      allowSimilarEligible: boolean;
    }
  | {
      decision: "hard_block";
      tier: "hard_block";
      source: "policy";
      reason: string;
    };

/** Mutable Session-scoped safety state (allowlist + YOLO). */
export type SessionSafetyState = {
  projectPath: string;
  yoloEnabled: boolean;
  /**
   * Narrow fingerprints of project-local commands allowed for this Session.
   * Elevated commands are never stored here.
   */
  commandAllowlist: string[];
};

export type YoloEnableRequest = {
  enabled: boolean;
  /** Required when turning YOLO on. */
  acknowledgeWarning?: boolean;
};

export type YoloEnableResult =
  | { ok: true; enabled: boolean }
  | { ok: false; reason: string };

/** Warning text shown before enabling YOLO for a Session. */
export const YOLO_WARNING =
  "YOLO mode skips normal in-Project edit and command prompts for this Session only. " +
  "Elevated actions, hard blocks, secret redaction, diffs, activity, Cancel, and Emergency Stop still apply. " +
  "Enable only if you accept that risk.";

export const YOLO_INDICATOR_LABEL = "YOLO on — normal prompts bypassed";
