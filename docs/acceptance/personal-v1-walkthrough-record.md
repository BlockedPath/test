# Personal v1 acceptance walkthrough

- **Issue:** #19
- **Generated:** 2026-07-12T16:18:51.856Z
- **Host:** linux/x64 (wsl)
- **WSL indicator:** Linux version 6.6.114.1-microsoft-standard-WSL2 (root@507f3e43091d) (gcc (GCC) 13.2.0, GNU ld (GNU Binutils) 2.41) #1 SMP PREEMPT_DYNAMIC Mon Dec  1 20:46:23 UTC 2025

- **Node:** v22.22.3
- **Git:** `ticket-19-acceptance` @ `ade382581ac251f605ed34c5ed964ed757d5f721`

## Summary

| passed | failed | unexecuted | skipped | ready |
| --- | --- | --- | --- | --- |
| 8 | 0 | 1 | 0 | yes |

## Scenarios

### Fresh install and CLI-owned authentication — UNEXECUTED

- **id:** `fresh_install_cli_auth`
- **detail:** Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
- **pass criteria:**
  - Current-user NSIS install launches without Administrator (native Windows).
  - Engine is discovered/acquired (not embedded) and identity-verified.
  - CLI-owned auth completes via browser/device/API-key; GUI never scrapes tokens.
  - On non-Windows hosts: install/auth live steps are unexecuted with reason; auth seam still proven via AgentEnginePort.authenticate → engine.authenticated.
- **evidence:**
  - packaging smoke mode=plan_only
  - nsis_current_user_install: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - webview2_bootstrap: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - engine_discover_or_acquire: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - engine_verify_pin: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - cli_owned_auth: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - project_open: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - first_session_start: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - clean profile steps defined: nsis_current_user_install, webview2_bootstrap, engine_discover_or_acquire, engine_verify_pin, cli_owned_auth, project_open, first_session_start
  - Auth seam separately proven by FakeAgentEngine in vitest walkthrough

### Open Project and conversation-first workspace — PASS

- **id:** `open_project_conversation`
- **detail:** Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).
- **pass criteria:**
  - First-use choose → trust summary → workspace.
  - Files rail shows project tree and Git status (or non-git notice).
  - Conversation is the primary surface with a usable prompt composer.
  - Safe explore path surfaces tool/read activity without ACP/TUI wire.
- **evidence:**
  - Proven by vitest personal v1 acceptance walkthrough suite
  - Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy

### Approve multi-file edit with selected-only apply — PASS

- **id:** `multi_file_edit_selected_apply`
- **detail:** Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).
- **pass criteria:**
  - Multi-file batch appears with per-file selection and inline diffs.
  - Deselected files are not written; selected files apply.
  - Batch resolves with applied/skipped statuses visible.
- **evidence:**
  - Proven by vitest personal v1 acceptance walkthrough suite
  - Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy

### Command approval, live Activity, failure recovery — PASS

- **id:** `command_activity_and_failure`
- **detail:** Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).
- **pass criteria:**
  - Project-local command prompts for approval (opening a Project does not authorize execution).
  - After allow: Activity shows live output and exit status.
  - Nonzero exit is visible; Session remains usable for a subsequent prompt.
- **evidence:**
  - Proven by vitest personal v1 acceptance walkthrough suite
  - Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy

### Reject a proposed diff — PASS

- **id:** `reject_diff_no_write`
- **detail:** Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).
- **pass criteria:**
  - Reject-all marks every change rejected.
  - File write host is unchanged for rejected paths.
- **evidence:**
  - Proven by vitest personal v1 acceptance walkthrough suite
  - Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy

### Cancel a turn vs successful completion — PASS

- **id:** `cancel_vs_success`
- **detail:** Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).
- **pass criteria:**
  - Stop requests cooperative cancel; turn stopReason is cancelled.
  - UI turn status distinguishes interrupted vs end_turn success.
  - Pending approvals are dismissed; no silent disk rollback claimed.
- **evidence:**
  - Proven by vitest personal v1 acceptance walkthrough suite
  - Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy

### YOLO for normal tasks with elevated/hard-block protection — PASS

- **id:** `yolo_normal_with_protections`
- **detail:** Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).
- **pass criteria:**
  - YOLO requires explicit warning acknowledgment; banner/indicator visible when on.
  - Normal project-local commands auto-allow under YOLO.
  - Elevated actions still prompt; hard-blocked secret/credential actions stay blocked.
  - Cancel and Emergency Stop remain available; Emergency Stop clears YOLO for next Session.
- **evidence:**
  - Proven by vitest personal v1 acceptance walkthrough suite
  - Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy

### Relaunch recovery via thin auth or CLI fallback — PASS

- **id:** `relaunch_auth_cli_fallback`
- **detail:** Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).
- **pass criteria:**
  - After engine fault/emergency, Retry engine re-authenticates and opens a Session.
  - Reset Session restores a usable idle Session with YOLO off.
  - CLI fallback control documents the terminal repair path without claiming file rollback.
- **evidence:**
  - Proven by vitest personal v1 acceptance walkthrough suite
  - Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy

### Windows smoke and acceptance results recorded — PASS

- **id:** `windows_packaging_smoke_record`
- **detail:** Record written; live install steps unexecuted — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
- **pass criteria:**
  - Clean-profile smoke plan is defined (NSIS → WebView2 → engine pin → auth → project → session).
  - On non-native-Windows hosts every live step is skipped/unexecuted with reason — never faked as pass.
  - Remaining v1 gaps are listed with classification (out_of_scope / environment / product).
- **evidence:**
  - packaging smoke mode=plan_only
  - nsis_current_user_install: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - webview2_bootstrap: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - engine_discover_or_acquire: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - engine_verify_pin: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - cli_owned_auth: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - project_open: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - first_session_start: skipped — Clean-profile NSIS install/auth/session smoke requires native Windows. Current host is wsl; refusing to fake live packaging results.
  - clean profile steps defined: nsis_current_user_install, webview2_bootstrap, engine_discover_or_acquire, engine_verify_pin, cli_owned_auth, project_open, first_session_start
  - gaps classified in this record

## Remaining gaps

- **[environment]** `native-windows-nsis-install`: Live current-user NSIS install + WebView2 bootstrap not executed on this host — Host environment is wsl; requires native Windows with NSIS artifact.
- **[environment]** `real-pinned-cli-process`: Real pinned Grok CLI process tests (spawn, cancel tree, live auth browser flow) not executed — Walkthrough used FakeAgentEngine + packaging plan-only smoke. Process tests require native Windows + pinned engine.
- **[deferred]** `visual-density-review`: Manual Windows visual review (keyboard, focus, contrast, density) not automated — Spec requires manual visual review against prototype B direction; not claimed by this suite.
- **[out_of_scope]** `multi-day-audit-export`: Persistent multi-day audit history / exportable audit files — Explicitly out of scope for v1.

_Do not treat unexecuted native Windows steps as passed. Re-run on native Windows with NSIS + pinned CLI to close environment gaps._
