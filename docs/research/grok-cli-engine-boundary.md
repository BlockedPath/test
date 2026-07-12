# Grok CLI engine boundary

Research for [Research: Determine the Grok CLI integration and Windows engine boundary](https://github.com/BlockedPath/test/issues/2).

Research date: 2026-07-12.

## Decision

Use the official Grok Build CLI as a bundled, version-pinned subprocess behind an app-owned engine adapter. Start it with `grok agent stdio` and speak ACP/JSON-RPC over stdin/stdout. Do not wrap the interactive TUI or parse human-readable terminal output. Keep the adapter narrow so a future direct xAI API engine can replace the subprocess without changing the GUI.

The first implementation spike should prove the Windows binary can be bundled and launched, then exercise `initialize`, authentication, `session/new`, `session/prompt`, streamed `session/update` messages, filesystem capabilities, terminal capability, cancellation, process exit, and stderr/error handling.

## Findings from primary sources

### The CLI already exposes a non-TUI integration mode

xAI documents Grok Build as usable through an interactive TUI, headless scripts, or the Agent Client Protocol (ACP) in other apps. The normal `grok` command starts the TUI; the documented integration command is `grok agent stdio`.

Source: [Grok Build overview](https://docs.x.ai/build/overview) (last updated July 6, 2026), especially the Getting Started and CLI sections.

### ACP provides the required process boundary

The official headless documentation describes `grok agent stdio` as an ACP agent over JSON-RPC on stdin/stdout. Its example launches the process with Node’s `child_process.spawn`, parses newline-delimited JSON, forwards stderr separately, sends `initialize`, negotiates authentication, creates a session with a working directory, and sends `session/prompt`.

The same example states that assistant text arrives incrementally through `session/update` chunks, including `agent_message_chunk`. The initialize request advertises filesystem read/write and terminal capabilities. This matches the GUI’s need to show streamed conversation, file activity, command activity, and cancellation without interpreting TUI screen output.

Source: [Headless & Scripting — ACP](https://docs.x.ai/build/cli/headless-scripting#headless-scripting) (last updated June 10, 2026).

### Headless streaming is a useful fallback, not the primary seam

The CLI also supports `-p`/`--single`, `--cwd`, sessions, `--output-format streaming-json`, and `--always-approve`. Streaming JSON is newline-delimited and emits incremental events. This is useful for smoke tests, diagnostics, and a fallback mode, but ACP is the better primary interface because it explicitly models authentication, session lifecycle, capabilities, and protocol messages.

Source: [Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting#headless-mode) and [CLI Reference](https://docs.x.ai/build/cli/reference).

### Windows installation is an explicit supported path

xAI documents a Windows PowerShell installer:

```powershell
irm https://x.ai/cli/install.ps1 | iex
```

The enterprise deployment documentation also lists `npm install -g @xai-official/grok` as an alternative distribution path. The docs do not promise a stable embeddable library or a public source-level engine API, so the GUI should treat the CLI executable and ACP protocol as the compatibility boundary.

Sources: [Grok Build overview](https://docs.x.ai/build/overview#install) and [Enterprise Deployments](https://docs.x.ai/build/enterprise#network-requirements).

### Authentication should remain CLI-owned initially

The documented authentication methods are browser OIDC via `grok login`, device-code authentication via `grok login --device-auth`, an external auth-provider command, and an API key through `XAI_API_KEY` or model configuration. The ACP example negotiates available methods through `initialize` and then calls `authenticate`; it recognizes cached credentials and API-key authentication.

The CLI documentation identifies `%USERPROFILE%\\.grok\\config.toml` as the Windows user configuration path. It does not establish that the GUI should copy tokens into Windows Credential Manager. Therefore v1 should invoke the CLI’s authentication flow and avoid duplicating or migrating credential storage until a separate security investigation confirms the cache format and ownership rules.

Source: [Enterprise Deployments — Authentication](https://docs.x.ai/build/enterprise#authentication), [Headless & Scripting — ACP](https://docs.x.ai/build/cli/headless-scripting#acp), and [Grok Build overview — Windows configuration](https://docs.x.ai/build/overview#custom-models).

## Boundary contract for the GUI adapter

The app-owned adapter should expose only GUI-level concepts:

- `start(projectPath, capabilities, authPolicy)`
- `authenticate()`
- `createSession()` / `resumeSession()`
- `sendPrompt(prompt)` with streamed events
- `respondToApproval(requestId, decision)`
- `cancel()` and `dispose()`
- process health, stderr, exit code, and structured error state

The adapter owns process startup, working-directory validation, JSON-RPC framing, request correlation, stdout/stderr separation, cancellation escalation, and cleanup. The GUI owns presentation, diff approval, project trust, YOLO policy, and user-visible recovery. The adapter must not expose raw TUI output as a required interface.

## Constraints and risks

1. **Bundling is not yet proven.** xAI documents installation paths, but not redistribution terms, binary signing requirements, or a stable embedded-runtime contract. Before packaging, verify the Windows binary’s license/distribution permissions, architecture variants, update policy, and signature verification.
2. **ACP coverage needs a Windows spike.** The docs show the core handshake and text streaming, but the GUI needs to observe actual tool-call, file, terminal, approval, cancellation, and error messages.
3. **CLI updates can change the protocol.** Pin a known CLI version in the app, expose the engine version in diagnostics, and add a compatibility check before starting a session.
4. **Authentication ownership is a security boundary.** Keep tokens out of GUI logs and command arguments. Prefer the CLI’s cached session or its documented auth handshake; do not assume a credential-store migration is safe.
5. **Process control is part of the safety model.** The app must be able to cancel a prompt, terminate the child process, clean up descendants, and represent an interrupted session distinctly from a completed one.
6. **A direct API engine remains a future escape hatch.** xAI documents direct API access for custom agents and IDE integrations, but reimplementing the coding-agent behavior would be a different project. Preserve the adapter seam without making direct API integration a v1 dependency.

## Consequences for the next tickets

- The desktop-stack ticket should evaluate a framework that can spawn and supervise a Windows child process, stream JSON-RPC events, open the browser for login, and package a pinned executable.
- The event-contract ticket should model ACP messages first and define a normalization layer for GUI events rather than inventing a parallel protocol.
- The prototype can use recorded ACP fixtures before a real bundled binary exists.
- A later task must validate the real Windows binary, packaging permission/signing, and protocol behavior before implementation is considered production-ready.

## Sources

- [Grok Build overview](https://docs.x.ai/build/overview)
- [Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting)
- [CLI Reference](https://docs.x.ai/build/cli/reference)
- [Enterprise Deployments](https://docs.x.ai/build/enterprise)
