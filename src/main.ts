/**
 * App entry: conversation-first workspace on AgentEnginePort.
 * Foundation uses FakeAgentEngine; real ACP adapter plugs into the same port.
 */

import type { AgentEnginePort } from "./engine";
import { FakeAgentEngine } from "./engine";
import { ConversationApp } from "./workspace/app";

const PROJECT_PATH = "/tmp/grok-gui-demo-project";

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

  // Wire the fake engine for local UI work. Real ACP engine is the same port.
  const engine: AgentEnginePort = new FakeAgentEngine({
    streamDelayMs: 45,
    richTurn: true,
  });
  const app = new ConversationApp(root, engine, {
    projectPath: PROJECT_PATH,
    autoDemoPrompt: "Show me a demo conversation through AgentEnginePort.",
  });
  void app.mount().catch((err) => {
    root.innerHTML = `<pre class="boot-error">${escapeHtml(
      err instanceof Error ? err.stack ?? err.message : String(err),
    )}</pre>`;
  });
});
