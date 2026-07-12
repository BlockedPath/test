# Windows desktop stack and packaging path

Research for [Research: Select the Windows desktop stack and self-contained packaging path](https://github.com/BlockedPath/test/issues/3).

Research date: 2026-07-12.

## Decision

**Use Tauri 2 (Rust host + web frontend + system WebView2) packaged with an NSIS per-user installer.** Ship a self-contained GUI shell that does **not** embed the proprietary Grok Build PE. Instead, **pin and acquire the official Windows CLI through xAI’s documented install channels** (PowerShell installer with version pin, or the official npm platform packages), verify Authenticode + version identity at install/first-run, and supervise `grok.exe … agent stdio` as an external process through the app-owned ACP bridge.

Defer full auto-update infrastructure if personal v1 only needs manual reinstall; when updates matter, use **Tauri’s updater plugin against NSIS artifacts** for the GUI shell, and a **separate engine pin channel** for the CLI so the app’s compatibility check stays authoritative.

This keeps the adapter contract from issues #2 and #8 intact: GUI → normalized events → ACP bridge → pinned CLI subprocess.

## Why this fits v1

| Requirement (issue #3 / map #1) | How Tauri 2 + NSIS + external pin meets it |
| --- | --- |
| Windows-first personal daily driver | First-class Windows NSIS/MSI bundling; WebView2 is OS-provided on modern Windows 10/11 |
| Self-contained installer | NSIS `-setup.exe` installs the GUI under `%LOCALAPPDATA%` without admin by default (`installMode` current user) |
| Reusable CLI-engine boundary | ACP bridge lives in the Rust host (or a tightly scoped command surface); UI never parses TUI output |
| Spawn / supervise / stream / kill | `tauri-plugin-shell` spawn + stdin write + kill; Rust can also own `std::process` and Windows Job Objects for tree kill |
| Open browser for CLI-owned login | Opener / shell open for `http(s)` URLs |
| Proprietary CLI redistribution risk | Do **not** ship `grok.exe` inside the installer as app content; fetch/pin from official channels and verify signature |
| ~130 MiB engine size | Keeps GUI installer small; engine weight is explicit and versioned under user profile (`~/.grok`) |
| Future cross-platform (deferred) | Same Tauri project can later target macOS/Linux without rewriting the web UI or ACP adapter seam |
| Accessibility | WebView2 inherits Chromium accessibility; pair with semantic HTML in the GUI surfaces |

## Packaging path (concrete)

### GUI shell

1. **Framework:** Tauri 2 desktop app.
2. **UI:** Web stack (framework-agnostic for this decision; React/Svelte/etc. are implementation detail).
3. **Windows bundle target:** **NSIS** (`-setup.exe`) as primary. MSI remains optional; NSIS is simpler for per-user personal installs and is the artifact the Tauri updater reuses on Windows.
4. **Install scope:** **Current user** (default NSIS mode) — no Administrator requirement; install under `%LOCALAPPDATA%`.
5. **WebView2:** Default **`downloadBootstrapper`** mode. On Windows 10 (April 2018+) and Windows 11 the runtime is already part of the OS; bootstrapper only runs if missing. Do **not** pay the ~127–180 MiB offline/fixed runtime tax for personal v1 unless offline install becomes a hard requirement.
6. **Code signing:** Sign the GUI installer/app with the project’s Authenticode cert when distributing beyond the developer machine (personal v1 can start unsigned locally).
7. **Updates (GUI):** Optional `tauri-plugin-updater` with signed NSIS artifacts and static JSON or simple endpoint. Personal v1 may skip this and reinstall manually.

Sources: [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/), [Tauri Updater](https://v2.tauri.app/plugin/updater/).

### Agent engine (not embedded)

Aligned with the Windows ACP spike GO recommendation:

| Step | Behavior |
| --- | --- |
| Acquire | Official PowerShell installer with version pin (`-Version` / `GROK_VERSION`) **or** official npm `@xai-official/grok` platform package resolution |
| Locate | Prefer `%USERPROFILE%\.grok\bin\grok.exe` (or recorded path after pin) |
| Verify | Authenticode publisher X.AI LLC; version via `grok --version` / `version.json` / ACP `agentVersion` — **not** empty PE FileVersion |
| Launch | `grok.exe --no-auto-update agent stdio` (+ YOLO mapping for `--always-approve` only when product YOLO is on) |
| Supervise | stdin/stdout JSON-RPC; separate stderr; `session/cancel` then process-tree kill escalation |
| Update | App-controlled pin; do not rely on CLI background auto-update while supervised |

**Do not** use Tauri `externalBin` / sidecar to ship `grok.exe` unless legal redistribution is later confirmed. Sidecar remains available for **app-owned** helpers if needed.

Sources: [windows-acp-engine-spike.md](./windows-acp-engine-spike.md), [grok-cli-engine-boundary.md](./grok-cli-engine-boundary.md), [Tauri Embedding External Binaries](https://v2.tauri.app/develop/sidecar/), [Tauri Shell plugin](https://v2.tauri.app/plugin/shell/).

## Engine-boundary constraints imposed by this stack

1. **ACP bridge host language:** Prefer implementing the bridge in **Rust** (process lifetime, buffering, Job Object kill, signature checks). The web UI consumes only the **normalized GuiEvent / SessionSnapshot** contract from issue #4 — not raw JSON-RPC.
2. **Client capabilities:** Bridge must answer ACP client methods `fs/*` and full `terminal/*` on the host side (spike: without terminal bridge, command tools fail).
3. **No Chromium-in-app requirement for the engine:** The engine is a PE subprocess, not a Node utilityProcess. Electron’s Node main process is **not** required for ACP.
4. **Path and cwd:** Always pass absolute Windows project paths to `session/new`; spawn without a shell when launching `grok.exe` (avoid `.cmd`/shell injection patterns).
5. **Auth:** Open system browser / device flow owned by CLI; GUI must not scrape tokens from logs or argv.
6. **Capabilities ACL:** Tauri shell permissions must allow only the pinned engine binary and opener scopes — not arbitrary shell from the frontend.
7. **Size budget:** GUI installer stays small; total disk after first engine pin is GUI + ~130 MiB CLI + WebView2 (usually already present).

## Comparison (smallest viable options)

### Selected: Tauri 2 + NSIS + external engine pin

| Axis | Assessment |
| --- | --- |
| Native Windows integration | Good: OS WebView2, per-user NSIS, optional MSI; not as deep as WinUI chrome APIs |
| Filesystem / process | Excellent: Rust + shell plugin; easy to add Job Objects |
| Startup / runtime size | Best of web-shell options (no bundled Chromium) |
| Installer | First-party NSIS/MSI with WebView2 modes and hooks |
| Update strategy | Official updater plugin for GUI; separate engine pin |
| Accessibility | WebView2 / Chromium a11y + semantic UI work |
| Cross-platform later | Strong |

### Rejected: Electron + electron-builder NSIS

| Axis | Why rejected for v1 default |
| --- | --- |
| Process / ACP | **Proven** in the Windows spike (Node `child_process.spawn` + NDJSON). Excellent technical fit. |
| Size / startup | Ships Chromium + Node; heavier daily-driver footprint than WebView2 host |
| Packaging | Mature NSIS + auto-update ecosystem (`electron-updater`) |
| Engine boundary | Temptation to put ACP + UI policy in one large Node main process; harder to keep adapter narrow |
| Verdict | **Viable fallback** if the team standardizes on pure TypeScript end-to-end or must maximize reuse of the Node spike client without a Rust bridge. Not the default given personal-use size and clearer host/UI split. |

Sources: [Node.js child_process](https://nodejs.org/api/child_process.html), [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) (Node children only — external PE still uses `child_process`).

### Rejected: WinUI 3 / Windows App SDK (C# or C++)

| Axis | Why rejected for v1 default |
| --- | --- |
| Native integration | Best-in-class Windows UX toolkit |
| Process / FS | Excellent (`Process`, Job Objects, full Win32) |
| Packaging | MSIX and unpackaged self-contained WASDK documented; not a true single-file EXE for WinUI 3 in all modes |
| UI productivity for this product | Conversation, activity stream, lightweight editor/diffs are faster in a web UI; pure XAML would slow first-use prototyping (#5) |
| Cross-platform later | Weak — Windows-only stack |
| Verdict | Revisit only if product prioritizes shell-native chrome over web UI velocity, or if WebView2 is disallowed. |

Sources: [Windows App SDK self-contained deployment](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/self-contained-deploy/deploy-self-contained-apps), [Unpackaged WinUI 3](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/unpackage-winui-app).

### Rejected: Wails (Go + WebView2)

Similar webview model to Tauri but weaker first-party story for sidecars, capability-scoped shell, and Windows updater/installer depth compared with Tauri 2’s documented NSIS + updater path. No project-specific reason to pick Go over Rust here.

### Rejected: Flutter / Qt

Portable UI kits with solid desktop packaging, but weaker default fit for embedding a long-lived JSON-RPC PE supervisor next to a coding-agent workspace UI, and less alignment with the web-centric activity/diff surfaces already implied by the map. Higher framework-specific cost for personal v1.

### Rejected: “Pure” native WebView2 bootstrap without a framework

Possible but reimplements windowing, packaging, updater, and permission boundaries that Tauri already provides. Not smallest *viable* path.

## Installer vs engine: clarifying “self-contained”

Map #1 prefers a self-contained installer. After the spike, that means:

| Layer | Self-contained? | Notes |
| --- | --- | --- |
| GUI app + WebView2 policy | **Yes** (bootstrapper if needed) | One NSIS setup for the product shell |
| Grok Build CLI engine | **Pinned, official-channel** | Not redistributed inside the GUI package by default |
| Network for inference/auth | **Required** | Offline PE does not imply offline agent |

If redistribution rights are later granted, packaging may switch to optional sidecar embed **without** changing the ACP adapter interface — only the acquire/locate step changes.

## Consequences for later work

- **Prototype (#5):** Scaffold Tauri 2 Windows app; mock or record ACP fixtures before real engine wiring.
- **Event contract (#4):** Keep GuiEvent model framework-independent; Tauri commands/events are transport only.
- **Safety grilling (#6):** Map YOLO to process flags carefully; host kill path must work from Rust.
- **Acceptance (#7):** Include “fresh Windows user: install GUI → pin engine → login → first session” as a path.
- **Implementation:** First production spike after wayfinding should create the Tauri project, implement engine acquire/verify/spawn, and complete `fs/*` + `terminal/*` client methods.

## Sources

- [Tauri 2 — Windows Installer](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri 2 — Embedding External Binaries (sidecar)](https://v2.tauri.app/develop/sidecar/)
- [Tauri 2 — Shell plugin](https://v2.tauri.app/plugin/shell/)
- [Tauri 2 — Updater plugin](https://v2.tauri.app/plugin/updater/)
- [Windows App SDK — self-contained apps](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/self-contained-deploy/deploy-self-contained-apps)
- [Node.js — child_process](https://nodejs.org/api/child_process.html)
- [Electron — utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- Prior project research: [grok-cli-engine-boundary.md](./grok-cli-engine-boundary.md), [windows-acp-engine-spike.md](./windows-acp-engine-spike.md), [coding-agent-event-contract.md](./coding-agent-event-contract.md)
- Map: [Windows Grok GUI — Wayfinding Map](https://github.com/BlockedPath/test/issues/1)
