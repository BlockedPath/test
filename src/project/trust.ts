/**
 * First-use trust / safety summary agreed for v1.
 * Shown before the user enters the conversation workspace.
 */

import type { TrustRule } from "./types";

export const TRUST_SUMMARY_TITLE = "What this Project allows";

export const TRUST_SUMMARY_INTRO =
  "Opening a Project never silently authorizes edits or commands. " +
  "Review these rules before you enter the workspace.";

export const TRUST_RULES: TrustRule[] = [
  {
    id: "read",
    title: "Read",
    detail:
      "Safe in-Project reads happen automatically so ordinary exploration does not interrupt the conversation.",
  },
  {
    id: "edit",
    title: "Edit",
    detail:
      "File changes show as diffs and require approval before apply (unless YOLO is on for this Session).",
  },
  {
    id: "command",
    title: "Command",
    detail:
      "Project-local commands prompt by default. You can allow similar commands for the current Session only.",
  },
  {
    id: "outside",
    title: "Outside project & elevated",
    detail:
      "Outside-project writes, destructive operations, credential-adjacent paths, and other elevated actions always need a separate explicit decision.",
  },
  {
    id: "yolo",
    title: "YOLO mode",
    detail:
      "Off by default. When you enable it for a Session, it skips only normal in-Project edit and command prompts. Diffs, activity, cancellation, Emergency Stop, and elevated decisions remain.",
  },
];

export function formatTrustSummaryPlain(): string {
  const lines = [TRUST_SUMMARY_TITLE, "", TRUST_SUMMARY_INTRO, ""];
  for (const rule of TRUST_RULES) {
    lines.push(`• ${rule.title}: ${rule.detail}`);
  }
  return lines.join("\n");
}
