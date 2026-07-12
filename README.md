# Grok GUI

Windows-first Tauri 2 desktop shell for the Grok coding agent.

## Foundation (issue #10)

This slice establishes:

- A launchable **Tauri 2** host + Vite/TypeScript frontend
- The single **`AgentEnginePort`** application seam
- Normalized **`GuiEvent`** / **`SessionSnapshot`** model and reducer
- A **fake engine** that streams a demo conversation for UI work

The frontend never consumes ACP JSON-RPC or TUI output. The real Windows ACP bridge lands in a later ticket behind the same port.

## Develop

```bash
npm install
npm test
npm run dev          # web shell (fake engine)
npm run tauri dev    # full desktop shell (requires platform WebView deps)
```

On Linux, install [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (`webkit2gtk`, etc.) before `tauri dev`.

## Packaging (issue #18)

Windows daily-driver packaging:

- **NSIS** current-user installer (`installMode: currentUser`) — no Administrator
- **WebView2** `downloadBootstrapper` when the runtime is missing
- **Engine** is not embedded; first-run discovers/acquires the pinned official CLI and verifies publisher/signature/version/arch
- **GUI updates** stay separate from the engine pin (no silent engine drift)

```bash
npm test
npm run test:windows-live   # WebView2 + signed pinned CLI via Windows/WSL interop
npm run test:packaging-smoke   # honest plan-only on WSL; live install needs native Windows
npm run test:acceptance        # personal v1 walkthrough + pass/fail record (issue #19)
```

Acceptance results land in `docs/acceptance/personal-v1-walkthrough-record.md`. Native Windows NSIS/live CLI steps are **unexecuted** on WSL/Linux — never faked as pass.
`test:windows-live` independently verifies the signed pinned CLI and WebView2 through Windows interop; it does not claim NSIS installation.

## Layout

| Path | Role |
| --- | --- |
| `src/engine/` | `AgentEnginePort`, types, reducer, fake engine, tests |
| `src/packaging/` | NSIS/WebView2 policy, engine readiness, update pin separation |
| `src/acceptance/` | Personal v1 walkthrough scenarios + pass/fail record (issue #19) |
| `src/main.ts` | Minimal conversation workspace UI |
| `src-tauri/` | Tauri 2 Rust host (`tauri.conf.json` Windows bundle) |

Domain vocabulary: see `CONTEXT.md` and `docs/research/coding-agent-event-contract.md`.
