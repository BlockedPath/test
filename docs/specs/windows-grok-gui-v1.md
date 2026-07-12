# Spec: Windows Grok GUI v1

## Problem Statement

Grok Build is a capable coding agent, but its primary interaction model is a terminal UI. Users who dislike TUIs must understand terminal navigation, inline approval mechanics, terminal output, and command-line configuration before they can use the coding agent effectively.

The project needs a Windows-first desktop experience for personal use that makes common coding-agent work approachable without discarding the existing Grok CLI. The GUI must preserve the CLI’s local Project context, agent capabilities, authentication, and CLI fallback while giving the user a clear conversation, review, approval, activity, and recovery model.

## Solution

Build a Windows-first Tauri 2 desktop app with a Rust host and web frontend. The app acquires and verifies a pinned official Grok Build CLI through an official install channel rather than embedding the proprietary CLI binary in the GUI installer. It supervises `grok.exe --no-auto-update agent stdio` through an app-owned ACP bridge.

The frontend talks to one framework-independent application seam, `AgentEnginePort`. The port exposes normalized `GuiEvent` events and `SessionSnapshot` projections rather than ACP wire messages or TUI output. The primary shell is conversation-first, with a short first-use Project/trust flow, secondary Files and Activity rails, inline diffs and approvals, and expandable full-file review when needed.

The result is a personal Windows daily driver for common coding tasks. The CLI remains available as fallback for authentication repair, advanced configuration, and workflows outside v1.

## User Stories

1. As a personal Windows user, I want to install the GUI as a current-user desktop app, so that I can start using it without administrator access.
2. As a personal Windows user, I want the installer to handle the WebView2 prerequisite through the supported bootstrapper path, so that I do not need to understand desktop runtime dependencies.
3. As a user with an existing Grok CLI setup, I want the GUI to discover the supported CLI and its configuration, so that I do not have to configure a second agent identity.
4. As a new user, I want the GUI to guide me through CLI-owned browser authentication, so that I can sign in without copying tokens into the GUI.
5. As a headless or restricted user, I want a documented device-code or API-key fallback, so that authentication can recover when a browser flow is unavailable.
6. As a user, I want to choose one local Project folder, so that the Coding agent has an obvious working scope.
7. As a user, I want the first-use flow to summarize read, edit, command, outside-project, and YOLO behavior before entering the workspace, so that I understand what the agent may do.
8. As a user, I want to see whether the Project is a Git working tree, so that I can understand the recovery options before approving changes.
9. As a user, I want the conversation to be the primary surface, so that I can describe a coding task without learning a terminal command language.
10. As a user, I want assistant text to stream into the conversation, so that I can see progress instead of waiting for an opaque final response.
11. As a user, I want plans, thoughts, tool activity, and usage to be distinguishable from the final answer, so that I can understand what the Coding agent is doing.
12. As a user, I want the Files rail to show relevant Project files and Git status, so that I can orient myself without opening a separate editor.
13. As a user, I want safe in-Project reads to happen automatically, so that ordinary exploration does not interrupt the conversation.
14. As a user, I want a multi-file edit to appear as one reviewable batch with per-file selection, so that I can approve all changes or cherry-pick only the files I accept.
15. As a user, I want an inline diff for each proposed edit, so that I can understand a change before it is written.
16. As a user, I want an expandable full diff and lightweight file view, so that large or multi-file changes remain reviewable without becoming a full IDE.
17. As a user, I want normal project-local commands to prompt by default, so that opening a Project never silently authorizes execution.
18. As a user, I want to allow similar project-local commands for the current Session, so that repetitive test commands do not require needless prompts while the allowlist remains narrow.
19. As a user, I want elevated commands, destructive operations, credential-adjacent paths, and outside-project writes to require a separate explicit decision, so that a normal approval cannot become a broad authorization.
20. As a user, I want secret-bearing paths and values to be blocked or redacted, so that credentials do not appear in the conversation, activity panel, diffs, or logs.
21. As a user, I want to enable YOLO mode explicitly for one Session, so that I can trade prompts for speed when I accept the risk.
22. As a user, I want YOLO mode to show a persistent warning and remain visible, so that I do not forget that normal edit and command prompts are being bypassed.
23. As a user, I want YOLO mode to preserve elevated approvals, hard blocks, secret redaction, diffs, activity, cancellation, and emergency stop, so that YOLO is not an unrestricted process escape hatch.
24. As a user, I want the Activity panel to show tool calls, file changes, commands, approvals, denials, hard blocks, exit codes, and errors, so that I can audit what happened during a Session.
25. As a user, I want the Activity panel to redact secrets, so that visibility does not create a second credential leak.
26. As a user, I want a Stop control beside the prompt composer, so that I can request cooperative cancellation without navigating a terminal.
27. As a user, I want cancellation to stop generation, dismiss pending approvals, prevent new tools from starting, and mark the Session interrupted, so that I can tell cancellation from successful completion.
28. As a user, I want an Emergency Stop that escalates from cooperative cancellation to agent termination and process-tree cleanup, so that a hung or unsafe run can be stopped.
29. As a user, I want the app to show when process cleanup is incomplete, so that I know when an orphaned process may remain.
30. As a user, I want the app to offer Retry engine, Reset Session, and CLI fallback after an error, so that a failed run has a clear recovery path.
31. As a user, I want cancellation and emergency stop not to silently roll back files, so that the UI reflects the real state of my Project.
32. As a user, I want to resume or relaunch a Session when supported by the CLI, so that a thin app restart does not erase useful context.
33. As a user, I want the app to display the engine version and protocol health, so that compatibility failures are diagnosable.
34. As a user, I want the app to tolerate unknown vendor ACP notifications, so that a CLI update does not crash the GUI when it adds nonessential events.
35. As a user, I want the GUI to remain Grok-only in v1, so that the product can validate one complete experience before adding provider abstraction.
36. As a user, I want to open the CLI fallback for unsupported workflows, so that the GUI does not pretend to cover capabilities it does not yet support.
37. As a personal user, I want the common coding workflow to pass a scripted acceptance walkthrough, so that “daily driver” means more than a polished empty state.

## Implementation Decisions

- **Application seam:** The frontend depends on one `AgentEnginePort` and a `SessionSnapshot` projection. The port covers engine startup, authentication, Project/session lifecycle, prompt submission, approval responses, cooperative cancellation, Emergency Stop, and disposal. The frontend does not consume ACP JSON-RPC or TUI output directly.
- **Engine adapter:** The Tauri/Rust host implements the port through an ACP bridge that supervises the official Grok CLI as a child process. It owns JSON-RPC framing, request correlation, stdout/stderr separation, process lifetime, cancellation escalation, and cleanup.
- **CLI distribution:** Do not embed the proprietary Grok PE in the GUI installer by default. Acquire a pinned version through the official Windows installer or official npm platform package, verify publisher/signature and version identity, disable CLI background auto-update while supervised, and record the exact engine version.
- **Desktop shell:** Use Tauri 2 with a web frontend, WebView2 bootstrapper behavior, and a current-user NSIS installer. GUI updater infrastructure is optional for personal v1; engine pinning remains separate from GUI updates.
- **Authentication:** Keep authentication CLI-owned. Launch the documented browser/device/API-key flows as appropriate, do not scrape tokens from logs or arguments, and never expose raw credential values in GUI state or activity.
- **Domain boundaries:** One active Project per app window and one active Session per Project window. A Session owns conversation, activity, approvals, cancellation state, and the YOLO flag.
- **Normalized event model:** The bridge/store emits one `GuiEvent` stream with session and optional turn correlation. The reducer applies events to `SessionSnapshot`; UI surfaces render projections of that snapshot. Core lifecycle states are `idle`, `running`, `awaiting_approval`, `cancelling`, `completed_turn`, `faulted`, and `disposed`.
- **ACP mapping:** Normalize ACP prompt turns, streamed message/thought chunks, plans, usage, tool calls, tool updates, permission requests, terminal activity, stop reasons, and client filesystem requests into GUI vocabulary. Unknown vendor notifications are tolerated and logged at a diagnostic level.
- **Files and terminal:** The ACP bridge must implement client filesystem methods and the terminal methods required for real command execution. Tool titles alone are insufficient; commands must produce live output, exit status, cancellation, and cleanup state.
- **Conversation-first UI:** The conversation is the visual spine. Files and Activity are secondary rails. Proposed edits and normal approvals appear inline in the stream; a full diff/file surface expands when review needs more space.
- **First-use flow:** New Project setup is a short sequence: choose folder, show trust/safety summary, then enter the workspace. It is not a permanent mission-control shell.
- **Approval policy:** In-Project reads are automatic. Multi-file edit batches show per-file checkboxes and apply only selected files. Project-local commands prompt by default with an optional narrowly scoped “allow similar for this Session” action. Elevated actions are never session-allowlisted.
- **Elevated policy:** Destructive deletes, Git history/publish risk, dependency or environment mutation, privilege/process control, network-exfiltration-shaped actions, outside-project writes, credential-adjacent paths, pipe-to-shell, global installs, and kill operations outside the agent tree require elevated handling or default denial. Raw credential material is hard-blocked.
- **YOLO policy:** YOLO is off by default, enabled per Session after a warning, and visibly indicated. It bypasses only normal in-Project edit and command prompts. It does not bypass elevated decisions, hard blocks, redaction, diffs, audit activity, cancellation, or Emergency Stop.
- **Cancellation:** Cooperative Cancel sends the ACP cancellation, stops generation, dismisses pending approvals, prevents new tool starts, requests running-command stop, and marks the turn interrupted. It does not roll back already-written files.
- **Emergency Stop:** Emergency Stop escalates cooperative Cancel to CLI termination and best-effort Windows process-tree cleanup. Orphans are surfaced. New/resumed Sessions start with YOLO off after an Emergency Stop.
- **Recovery:** Recovery is explicit and visible: Retry engine, Reset Session, or CLI fallback. The app never claims a silent rollback.
- **Scope:** V1 is Windows-first, personal-use, Grok-only, single-Project, and not a full IDE. The CLI remains a fallback.

## Testing Decisions

- Tests must assert externally visible behavior at the `AgentEnginePort`, reducer, and UI boundaries. Do not couple tests to Tauri internals, Rust helper functions, CSS selectors that are not user-facing semantics, or raw ACP message ordering beyond the contract.
- **Port and bridge contract tests:** Use a fake ACP transport and recorded protocol fixtures to verify initialization, authentication negotiation, Project/session creation, streaming, permissions, filesystem requests, terminal requests, unknown notifications, errors, cooperative cancellation, Emergency Stop escalation, and disposal.
- **Session-store tests:** Feed normalized events into the reducer and assert `SessionSnapshot`, state transitions, append-only activity/conversation projections, approval state, cancellation state, YOLO invariants, and fault/recovery behavior.
- **Safety tests:** Verify multi-file selection, command session allowlists, elevated-action separation, outside-project boundaries, credential hard blocks, redaction, YOLO limits, audit visibility, and no implicit authorization from merely opening a Project.
- **Process tests:** On Windows, spawn the real pinned CLI in a controlled Project and assert child-process startup, stdout/stderr separation, cancellation, command output, exit codes, and process-tree cleanup. Include a hung-child or timeout path.
- **Packaging tests:** On a clean Windows user profile, install the current-user NSIS artifact, verify WebView2 behavior, acquire or discover the pinned CLI, verify publisher/version identity, authenticate, and launch the first Session. Test failure when the engine is missing, stale, unsigned, wrong-architecture, or unavailable on the network.
- **UI behavior tests:** Drive the first-use wizard, conversation stream, inline approval, expanded diff, Activity panel, YOLO warning/pill, Stop, error recovery, and CLI fallback using a fake `AgentEnginePort`.
- **Acceptance suite:** The personal v1 walkthrough must cover: install and auth; open Project; explore; approve a multi-file edit; run an approved command; recover from a failing command; reject a diff; cancel; run a normal task in YOLO; and relaunch with thin auth/CLI fallback. Every scenario must have visible pass criteria.
- **Manual visual review:** Use the throwaway prototype’s B direction as the interaction reference, but do not promote prototype implementation code as production UI. Validate keyboard, mouse, focus, contrast, readable density, and error visibility on Windows.
- **Prior art:** There is no production test suite in the greenfield repo. The ACP spike fixtures and protocol samples are the initial integration-test prior art.

## Out of Scope

- macOS or Linux release in v1.
- Multiple model providers or a provider abstraction beyond the single `AgentEnginePort` seam.
- Multi-Project workspaces or cross-window session orchestration.
- Full IDE/editor replacement, language-server features, terminal emulator replacement, or advanced code navigation.
- Public beta, broad distribution, support operations, telemetry program, or release marketing.
- Embedding the proprietary Grok CLI binary without explicit redistribution permission.
- Offline inference or offline authentication.
- Persistent multi-day audit history or exportable audit files.
- Silent filesystem rollback after cancellation or Emergency Stop.
- Pixel-level design-system polish beyond the selected interaction direction.

## Further Notes

- The Wayfinder map and all child investigations are complete; this spec is the handoff from decisions to implementation planning.
- The first implementation slice should prove the one seam end-to-end with a Tauri shell, a fake engine for UI work, and the real Windows ACP smoke path behind the same port.
- The most important unresolved operational risk is official CLI acquisition and redistribution policy. Keep installation-time acquisition separate from the GUI shell so the legal/distribution decision does not force a rewrite of the ACP bridge.
- The throwaway prototype remains useful as a visual reference at the conversation-first direction with a short first-use wizard and expandable review surfaces.
- The spec uses the project glossary: Coding agent, Project, Session, Approval, YOLO mode, Activity panel, Agent engine, ACP bridge, and CLI fallback.
