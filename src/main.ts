/**
 * App entry: first-use Project shell wrapping the conversation-first workspace.
 *
 * - Browser / `npm run dev`: FakeAgentEngine + demo project (UI work).
 * - Tauri desktop: real Grok CLI via GrokAcpEngine + native FS host.
 */

import { createMemoryFileWriteHost } from "./edits";
import { createTauriFileWriteHost } from "./edits/tauri-host";
import type { AgentEnginePort } from "./engine";
import { FakeAgentEngine, GrokAcpEngine } from "./engine";
import {
  createTauriDiscoveryHost,
  createTauriIdentityHost,
  createTauriProcessCleanupHost,
  createTauriSpawnEngine,
  createTauriTerminalSpawner,
  isTauriRuntime,
} from "./engine/tauri-host";
import {
  DEMO_PROJECT_PATH,
  ProjectService,
  ProjectShell,
  createDemoProjectHost,
  createLocalStorageRecentStore,
} from "./project";
import { createTauriProjectHost } from "./project/tauri-host";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function boot(): Promise<void> {
  const root = document.querySelector("#app");
  if (!(root instanceof HTMLElement)) {
    throw new Error("#app root missing");
  }

  const tauri = isTauriRuntime();

  if (tauri) {
    const discovery = await createTauriDiscoveryHost();
    const identity = createTauriIdentityHost();
    const spawn = await createTauriSpawnEngine();
    const spawnTerminal = createTauriTerminalSpawner();
    const processCleanup = createTauriProcessCleanupHost();

    // Separate key from browser demo sessions so /tmp paths never pollute desktop.
    const recent = createLocalStorageRecentStore(
      typeof localStorage !== "undefined" ? localStorage : null,
      "grok-gui.recent-projects.desktop",
    );

    const projects = new ProjectService({
      host: createTauriProjectHost(),
      recent,
    });

    const createEngine = (): AgentEnginePort =>
      new GrokAcpEngine({
        discovery,
        identity,
        spawn,
        spawnTerminal,
        processCleanup,
      });

    const defaultPath =
      discovery.env.USERPROFILE
        ? `${discovery.env.USERPROFILE}\\projects\\test`
        : "C:\\Users\\justi\\projects\\test";

    const shell = new ProjectShell(root, {
      projects,
      createEngine,
      fileWriteHost: createTauriFileWriteHost(),
      // No auto-demo prompt — real agent, real project path from the user.
      autoDemoPrompt: null,
      realHost: true,
      defaultPath,
    });

    await shell.mount();
    return;
  }

  // --- browser / Vite-only demo path ---
  const projects = new ProjectService({
    host: createDemoProjectHost(),
    recent: createLocalStorageRecentStore(),
    demoProjectPath: DEMO_PROJECT_PATH,
  });

  const fileWriteHost = createMemoryFileWriteHost({
    "src/main.ts": "console.log('boot');\n",
    "src/legacy.ts": "export const legacy = true;\n",
  });

  const createEngine = (): AgentEnginePort =>
    new FakeAgentEngine({
      streamDelayMs: 45,
      richTurn: true,
      proposeEditsOnPrompt: true,
    });

  const shell = new ProjectShell(root, {
    projects,
    createEngine,
    fileWriteHost,
    autoDemoPrompt: `Project ready. Propose a multi-file edit I can review and apply.`,
  });

  await shell.mount();
}

window.addEventListener("DOMContentLoaded", () => {
  void boot().catch((err) => {
    const root = document.querySelector("#app");
    if (root instanceof HTMLElement) {
      root.innerHTML = `<pre class="boot-error">${escapeHtml(
        err instanceof Error ? err.stack ?? err.message : String(err),
      )}</pre>`;
    }
  });
});
