/**
 * Personal v1 acceptance walkthrough scenarios (issue #19 / spec #9 testing).
 *
 * Every scenario has visible pass criteria. Scenarios that require native
 * Windows packaging or a real pinned Grok CLI are marked; runners must not
 * claim pass for those on WSL/Linux.
 */

export type ScenarioId =
  | "fresh_install_cli_auth"
  | "open_project_conversation"
  | "multi_file_edit_selected_apply"
  | "command_activity_and_failure"
  | "reject_diff_no_write"
  | "cancel_vs_success"
  | "yolo_normal_with_protections"
  | "relaunch_auth_cli_fallback"
  | "windows_packaging_smoke_record";

export type ScenarioExecutionMode =
  /** Fully executable against FakeAgentEngine / ProjectShell on any host. */
  | "fake_port"
  /**
   * Packaging / NSIS / real CLI steps. Live only on native Windows with
   * artifacts; otherwise must be recorded as unexecuted/skipped.
   */
  | "native_windows";

export type WalkthroughScenario = {
  id: ScenarioId;
  /** Maps to issue #19 acceptance criteria order. */
  order: number;
  title: string;
  passCriteria: string[];
  executionMode: ScenarioExecutionMode;
  /** Parent issue acceptance bullet (short). */
  acceptanceBullet: string;
};

/**
 * Ordered personal v1 daily-driver walkthrough from issue #19.
 */
export const PERSONAL_V1_WALKTHROUGH: WalkthroughScenario[] = [
  {
    id: "fresh_install_cli_auth",
    order: 1,
    title: "Fresh install and CLI-owned authentication",
    acceptanceBullet:
      "Fresh install and CLI-owned authentication complete successfully.",
    executionMode: "native_windows",
    passCriteria: [
      "Current-user NSIS install launches without Administrator (native Windows).",
      "Engine is discovered/acquired (not embedded) and identity-verified.",
      "CLI-owned auth completes via browser/device/API-key; GUI never scrapes tokens.",
      "On non-Windows hosts: install/auth live steps are unexecuted with reason; auth seam still proven via AgentEnginePort.authenticate → engine.authenticated.",
    ],
  },
  {
    id: "open_project_conversation",
    order: 2,
    title: "Open Project and conversation-first workspace",
    acceptanceBullet:
      "User opens a Project, explores it, and sees the conversation-first workspace.",
    executionMode: "fake_port",
    passCriteria: [
      "First-use choose → trust summary → workspace.",
      "Files rail shows project tree and Git status (or non-git notice).",
      "Conversation is the primary surface with a usable prompt composer.",
      "Safe explore path surfaces tool/read activity without ACP/TUI wire.",
    ],
  },
  {
    id: "multi_file_edit_selected_apply",
    order: 3,
    title: "Approve multi-file edit with selected-only apply",
    acceptanceBullet:
      "User approves a multi-file edit, reviews the diff, and confirms only selected files apply.",
    executionMode: "fake_port",
    passCriteria: [
      "Multi-file batch appears with per-file selection and inline diffs.",
      "Deselected files are not written; selected files apply.",
      "Batch resolves with applied/skipped statuses visible.",
    ],
  },
  {
    id: "command_activity_and_failure",
    order: 4,
    title: "Command approval, live Activity, failure recovery",
    acceptanceBullet:
      "User approves a command, sees live Activity output, and recovers from a failing command.",
    executionMode: "fake_port",
    passCriteria: [
      "Project-local command prompts for approval (opening a Project does not authorize execution).",
      "After allow: Activity shows live output and exit status.",
      "Nonzero exit is visible; Session remains usable for a subsequent prompt.",
    ],
  },
  {
    id: "reject_diff_no_write",
    order: 5,
    title: "Reject a proposed diff",
    acceptanceBullet:
      "User rejects a diff and sees no rejected file applied.",
    executionMode: "fake_port",
    passCriteria: [
      "Reject-all marks every change rejected.",
      "File write host is unchanged for rejected paths.",
    ],
  },
  {
    id: "cancel_vs_success",
    order: 6,
    title: "Cancel a turn vs successful completion",
    acceptanceBullet:
      "User cancels a turn and can distinguish interruption from successful completion.",
    executionMode: "fake_port",
    passCriteria: [
      "Stop requests cooperative cancel; turn stopReason is cancelled.",
      "UI turn status distinguishes interrupted vs end_turn success.",
      "Pending approvals are dismissed; no silent disk rollback claimed.",
    ],
  },
  {
    id: "yolo_normal_with_protections",
    order: 7,
    title: "YOLO for normal tasks with elevated/hard-block protection",
    acceptanceBullet:
      "User enables YOLO for a normal task while elevated actions and hard blocks remain protected.",
    executionMode: "fake_port",
    passCriteria: [
      "YOLO requires explicit warning acknowledgment; banner/indicator visible when on.",
      "Normal project-local commands auto-allow under YOLO.",
      "Elevated actions still prompt; hard-blocked secret/credential actions stay blocked.",
      "Cancel and Emergency Stop remain available; Emergency Stop clears YOLO for next Session.",
    ],
  },
  {
    id: "relaunch_auth_cli_fallback",
    order: 8,
    title: "Relaunch recovery via thin auth or CLI fallback",
    acceptanceBullet:
      "User relaunches and can recover through the thin auth or CLI fallback path.",
    executionMode: "fake_port",
    passCriteria: [
      "After engine fault/emergency, Retry engine re-authenticates and opens a Session.",
      "Reset Session restores a usable idle Session with YOLO off.",
      "CLI fallback control documents the terminal repair path without claiming file rollback.",
    ],
  },
  {
    id: "windows_packaging_smoke_record",
    order: 9,
    title: "Windows smoke and acceptance results recorded",
    acceptanceBullet:
      "Windows smoke and acceptance results are recorded with any remaining v1 gaps explicitly classified.",
    executionMode: "native_windows",
    passCriteria: [
      "Clean-profile smoke plan is defined (NSIS → WebView2 → engine pin → auth → project → session).",
      "On non-native-Windows hosts every live step is skipped/unexecuted with reason — never faked as pass.",
      "Remaining v1 gaps are listed with classification (out_of_scope / environment / product).",
    ],
  },
];

export function scenarioById(id: ScenarioId): WalkthroughScenario {
  const s = PERSONAL_V1_WALKTHROUGH.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown walkthrough scenario: ${id}`);
  return s;
}
