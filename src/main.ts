/**
 * App entry: first-use Project shell wrapping the conversation-first workspace.
 * Project context (issue #13) + ConversationApp on AgentEnginePort (issue #12)
 * + multi-file edit review (issue #14).
 */

import { createMemoryFileWriteHost } from "./edits";
import type { AgentEnginePort } from "./engine";
import { FakeAgentEngine } from "./engine";
import {
  DEMO_PROJECT_PATH,
  ProjectService,
  ProjectShell,
  createDemoProjectHost,
  createLocalStorageRecentStore,
} from "./project";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.addEventListener("DOMContentLoaded", () => {
  const root = document.querySelector("#app");
  if (!(root instanceof HTMLElement)) {
    throw new Error("#app root missing");
  }

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

  void shell.mount().catch((err) => {
    root.innerHTML = `<pre class="boot-error">${escapeHtml(
      err instanceof Error ? err.stack ?? err.message : String(err),
    )}</pre>`;
  });
});
