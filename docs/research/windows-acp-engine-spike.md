# Windows ACP engine spike — compatibility report

Validation for [Task: Validate the bundled Windows ACP engine spike](https://github.com/BlockedPath/test/issues/8).

**Research date:** 2026-07-12  
**Recommendation:** **GO (with constraints)** for using a pinned official Windows Grok Build CLI as the v1 agent engine behind an app-owned ACP adapter.

This run used the **real Windows PE binary** (`grok.exe`) under a `win32` Node host. The operator pane was WSL2, but process spawn, PE execution, Authenticode checks, and ACP I/O all ran on Windows via interop (`powershell.exe` / Windows Node). Linux CLI results were **not** substituted.

## Tested artifact

| Field | Value |
| --- | --- |
| CLI version | `grok 0.2.93 (f00f96316d) [stable]` |
| Path | `C:\Users\justi\.grok\bin\grok.exe` |
| Size | 135,930,184 bytes (~130 MiB) |
| SHA-256 | `1E9393391A399275A1863F9F457E86C5D904B10B9CBA987D0B81F8427FA625F2` |
| PE machine | `x86_64` (`IMAGE_FILE_MACHINE_AMD64`) |
| PE version resource | Empty (`0.0.0.0`) — do not trust FileVersion; use `grok --version` / `~/.grok/version.json` |
| Sibling binary | `agent.exe` is **byte-identical** (same SHA-256) |
| Authenticode | **Valid**, EV-signed **X.AI LLC**, SSL.com intermediate, DigiCert timestamp present |
| Signer thumbprint | `C4550B58C79C51C04390FAC323E600A1459186EB` (cert NotAfter ≈ 2026-12-18) |

Download cache on the machine also contained versioned payloads `grok-0.2.91-windows-x86_64` and `grok-0.2.93-windows-x86_64`, confirming the installer keeps versioned Windows x86_64 artifacts under `%USERPROFILE%\.grok\downloads\`.

## Runtime assumptions (this spike)

| Assumption | Observed |
| --- | --- |
| OS | Windows 10/11-class host (`Microsoft Windows NT 10.0.26200.0`) |
| Arch | AMD64 |
| Auth | Existing CLI login (`cached_token` from `%USERPROFILE%\.grok\auth.json`); `XAI_API_KEY` **not** set |
| Network | Live inference required for prompt turns (proxy/auth hosts per enterprise docs) |
| Launch | `grok.exe --no-auto-update agent --always-approve stdio` |
| Client | Throwaway Node 22 ACP client (JSON-RPC NDJSON on stdin/stdout) |
| Workspace | Temp Windows directory under `%LOCALAPPDATA%\Temp\grok-acp-spike\workspace` |

Fixtures and the client live under [`docs/research/fixtures/windows-acp-spike/`](fixtures/windows-acp-spike/).

## Pass / fail matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Launch Windows binary | **PASS** | Process PID observed; spawn args recorded |
| ACP `initialize` | **PASS** | `protocolVersion: 1`, `agentVersion: 0.2.93`, capabilities + auth methods returned |
| `authenticate` | **PASS** | `methodId: cached_token` succeeded (OIDC session) |
| `session/new` | **PASS** | `sessionId` returned for Windows workspace `cwd` |
| Streamed `session/update` | **PASS** | `agent_message_chunk`, `agent_thought_chunk`, `user_message_chunk`, `available_commands_update` |
| Tool events | **PASS** | `tool_call` / `tool_call_update` for `read_file`, `list_dir`, `write`, `run_terminal_command`, etc. |
| File activity | **PASS** | Client methods `fs/read_text_file` (×3), `fs/write_text_file` (×1); workspace file `spike-out.txt` written with `SPIKE_WRITE_OK` |
| Terminal activity | **PASS (protocol)** / **partial (execution)** | Agent emitted `tool_call` `run_terminal_command` / title `Execute echo SPIKE_TERM_OK` and client method `terminal/create`. Spike client did **not** fully implement terminal create/IO, so execution failed with `unsupported client method terminal/create` on stderr. Adapter **must** implement client-side terminal methods for real command runs. |
| Cancellation | **PASS** | After `session/cancel`, in-flight `session/prompt` completed with `stopReason: "cancelled"`; agent process stayed alive until dispose |
| Cleanup | **PASS** | `kill`/dispose left PID dead; exit signal `SIGTERM` from Node’s kill path |
| Packaging constraints documented | **PASS** | See below |

Overall required gate (launch → initialize → auth → session → stream → cleanup): **PASS**.

## Protocol observations (adapter contract)

### Lifecycle that works today

1. Spawn `grok.exe` with `agent stdio` (recommend `--no-auto-update` in automated hosts).
2. `initialize` with `protocolVersion: 1` and client capabilities (`fs.readTextFile`, `fs.writeTextFile`, `terminal`).
3. `authenticate` with `cached_token` (or other advertised methods). Note: this host advertised `cached_token` and `grok.com` only; `xai.api_key` did not appear (API key was unset).
4. `session/new` with absolute Windows `cwd`.
5. `session/prompt` with ACP content blocks; assistant text arrives as `session/update` → `agent_message_chunk`.
6. `session/cancel` cancels an in-flight prompt (`stopReason: "cancelled"`).
7. Process kill cleans up the child for this single-process spike.

### Client methods the GUI adapter must implement

The Windows agent does **not** keep all tool I/O server-side. Observed **client-bound** JSON-RPC methods (agent → client requests):

- `fs/read_text_file`
- `fs/write_text_file`
- `terminal/create` (and, per docs, related `x.ai/terminal/*` / terminal wait-kill-output family)

Without a terminal bridge, the agent still emits tool UI events, but command execution fails. File tools can still succeed when the client answers `fs/*` or when the agent uses its own tool path — this spike observed both tool titles and a real workspace write.

### Session update types observed

`available_commands_update`, `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`.

### Extra vendor notifications observed

`_x.ai/mcp/*`, `_x.ai/models/update`, `_x.ai/announcements/update`, `_x.ai/settings/update`, `_x.ai/session_notification`, `_x.ai/sessions/changed`, `_x.ai/queue/changed`, `_x.ai/session/prompt_complete`.

The GUI should tolerate unknown `_x.ai/*` methods without crashing.

### Auth / safety flags

- `--always-approve` on `grok agent` successfully suppressed interactive permission prompts (`permissionRequests: 0` in the spike).
- Map this to the product YOLO path carefully: it is a **process-level** bypass, not a per-tool GUI policy.
- Keep tokens out of GUI logs; authenticate via CLI-owned cache or documented API-key flow.

### Cancellation note

`session/cancel` as a **notification** was sufficient for `stopReason: "cancelled"`. The process remained usable afterward until dispose. Product code should still escalate to process tree kill on hung cancel (Windows `taskkill /T /F` as last resort).

## Packaging, signature, architecture, redistribution

### How the official binary is distributed

1. **PowerShell installer** (`irm https://x.ai/cli/install.ps1 | iex`) — Windows-only; installs under `%USERPROFILE%\.grok\`, supports pin via `-Version` / `GROK_VERSION`.
2. **npm** `@xai-official/grok@0.2.93` — **Proprietary** license; thin meta-package with `postinstall` that installs from platform optional dependency `@xai-official/grok-win32-x64` (also `win32-arm64`). Binaries ship brotli-compressed in the platform package and expand to `~/.grok/bin` as versioned files + `grok.exe` copy on Windows.
3. Enterprise docs also list hosts for binary download (`x.ai`, `storage.googleapis.com`) and note npm as an alternative that avoids those hosts for install if optional deps resolve from the registry.

### Constraints for bundling in a desktop app

| Topic | Finding | v1 implication |
| --- | --- | --- |
| License | npm `license: Proprietary` | **Do not assume** redistribution rights. Prefer pinning a version the user/installer fetches from official channels, or obtain explicit redistribution permission before embedding the PE in a third-party installer. |
| Architecture | Tested **x64** only | Official packages also list `win32-arm64`. Ship or select the matching optional package; do not run x64-only assumptions on ARM Windows without a follow-up spike. |
| Signature | Valid Authenticode EV signature from X.AI LLC | Verify signature at install/update time; pin expected publisher/thumbprint policy carefully (cert rotation will break hard pins). |
| Size | ~130 MiB uncompressed PE | Affects installer size, update bandwidth, and antivirus scan cost. |
| Version identity | Empty PE FileVersion; reliable CLI `--version` / `version.json` | Compatibility checks must shell out or read sidecar metadata, not Win32 version resources. |
| Auto-update | CLI has auto-update; spike used `--no-auto-update` | Bundled/supervised engines should disable background self-update or own the update channel so the app’s pin is stable. |
| Side-by-side pin | Installer/npm use versioned filenames under `~/.grok/bin` | Good for non-disruptive updates; app should record exact version string from `initialize` `_meta.agentVersion` / `--version`. |
| Alternate binary name | `agent.exe` == `grok.exe` | Either path works; prefer the documented `grok` entrypoint. |

### Network / runtime hosts (not re-validated packet-by-packet here)

Per enterprise documentation: auth (`auth.x.ai`), inference proxy (`cli-chat-proxy.grok.com`), optional API (`api.x.ai`). TLS 1.2/1.3 via OS trust store. Offline bundling of the PE does **not** make the agent offline-capable.

## Repro

From a Windows shell (or WSL calling Windows Node against `grok.exe`):

```powershell
$env:GROK_EXE = "$env:USERPROFILE\.grok\bin\grok.exe"
$env:SPIKE_WORKSPACE = "$env:TEMP\grok-acp-spike\workspace"
$env:SPIKE_OUT = "$env:TEMP\grok-acp-spike\out"
# ensure grok 0.2.93+ is installed and `grok login` (or XAI_API_KEY) is available
node path\to\docs\research\fixtures\windows-acp-spike\spike-client.mjs
```

Requires: authenticated Grok session, network, Windows x64 `grok.exe`.

## Go / no-go

### GO for v1 engine strategy

- Windows binary launches cleanly as a supervised subprocess.
- ACP/JSON-RPC over stdio supports initialize, auth, session, streamed updates, tool events, cancel, and process teardown on real Windows.
- Official pin channels exist (versioned installer / npm platform packages).
- Authenticode signing is present and valid on the tested build.

### Must-fix constraints before production packaging

1. **Legal/redistribution:** treat the binary as proprietary; decide install-at-runtime vs embed only after license clarity.
2. **Adapter completeness:** implement ACP client `fs/*` and full `terminal/*` (not only consume `session/update` tool titles).
3. **Version pin + signature verify** on every ship/update; ignore empty PE version resources.
4. **Windows ARM64** not validated in this spike.
5. **Process-tree cleanup** under nested shells/tools needs a harder soak than this single-child kill test.
6. **Permission model:** `--always-approve` is a blunt YOLO switch; product approval UX still needs explicit mapping for non-YOLO sessions (permission requests were not exercised here because always-approve was on).

## Fixtures

| File | Purpose |
| --- | --- |
| [`fixtures/windows-acp-spike/spike-client.mjs`](fixtures/windows-acp-spike/spike-client.mjs) | Repro client |
| [`fixtures/windows-acp-spike/spike-report.json`](fixtures/windows-acp-spike/spike-report.json) | Pass/fail + step timings (PII redacted) |
| [`fixtures/windows-acp-spike/initialize-result.json`](fixtures/windows-acp-spike/initialize-result.json) | Initialize payload |
| [`fixtures/windows-acp-spike/session-new-result.json`](fixtures/windows-acp-spike/session-new-result.json) | Session create payload |
| [`fixtures/windows-acp-spike/stream-prompt-result.json`](fixtures/windows-acp-spike/stream-prompt-result.json) | First prompt result |
| [`fixtures/windows-acp-spike/protocol-sample.json`](fixtures/windows-acp-spike/protocol-sample.json) | Notification counts, tool timeline, sample messages |

## Sources

- Local Windows binary `grok 0.2.93` and spike run 2026-07-12
- [Headless & Scripting — ACP](https://docs.x.ai/build/cli/headless-scripting)
- Bundled user guide `15-agent-mode.md` on the installed CLI
- [Enterprise Deployments](https://docs.x.ai/build/enterprise)
- npm package metadata `@xai-official/grok@0.2.93` (Proprietary; platform optionalDependencies)
- Prior boundary research: [`grok-cli-engine-boundary.md`](grok-cli-engine-boundary.md)
