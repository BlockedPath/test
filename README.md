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

## Layout

| Path | Role |
| --- | --- |
| `src/engine/` | `AgentEnginePort`, types, reducer, fake engine, tests |
| `src/main.ts` | Minimal conversation workspace UI |
| `src-tauri/` | Tauri 2 Rust host |

Domain vocabulary: see `CONTEXT.md` and `docs/research/coding-agent-event-contract.md`.
