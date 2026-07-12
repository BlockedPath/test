/**
 * @vitest-environment happy-dom
 *
 * ProjectShell × demo host × FakeAgentEngine integration.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgentEngine } from "../engine/fake-engine";
import {
  DEMO_PROJECT_PATH,
  NON_GIT_DEMO_PATH,
  createDemoProjectHost,
  withNonGitDemo,
} from "./memory-host";
import { createMemoryRecentStore } from "./recent-store";
import { ProjectService } from "./service";
import { ProjectShell } from "./shell";

async function flush(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("ProjectShell (first-use + Files rail + ConversationApp)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    root.id = "app";
    document.body.appendChild(root);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function buildShell(options?: {
    demoPrompt?: string | null;
    host?: ReturnType<typeof createDemoProjectHost>;
  }): ProjectShell {
    const host = options?.host ?? createDemoProjectHost();
    const projects = new ProjectService({
      host,
      recent: createMemoryRecentStore(),
      demoProjectPath: DEMO_PROJECT_PATH,
    });
    return new ProjectShell(root, {
      projects,
      createEngine: () =>
        new FakeAgentEngine({ streamDelayMs: 0, richTurn: true }),
      autoDemoPrompt: options?.demoPrompt ?? null,
    });
  }

  it("starts on the choose-project phase", async () => {
    const shell = buildShell();
    await shell.mount();
    expect(root.querySelector('[data-testid="first-use-choose"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="open-project"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="open-demo"]')).toBeTruthy();
  });

  it("opens demo project, shows trust summary, then workspace with Files rail", async () => {
    const shell = buildShell({ demoPrompt: null });
    await shell.mount();

    (root.querySelector('[data-testid="open-demo"]') as HTMLButtonElement).click();
    await flush();

    expect(root.querySelector('[data-testid="first-use-trust"]')).toBeTruthy();
    const trust = root.querySelector('[data-testid="trust-summary"]');
    expect(textOf(trust)).toMatch(/Read/i);
    expect(textOf(trust)).toMatch(/Edit/i);
    expect(textOf(trust)).toMatch(/Command/i);
    expect(textOf(trust)).toMatch(/Outside/i);
    expect(textOf(trust)).toMatch(/YOLO/i);

    (
      root.querySelector('[data-testid="trust-continue"]') as HTMLButtonElement
    ).click();
    await flush(20);

    expect(root.querySelector('[data-testid="project-workspace"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="files-rail"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="file-tree"]')).toBeTruthy();
    expect(textOf(root.querySelector('[data-testid="file-tree"]'))).toMatch(
      /README\.md/,
    );
    expect(root.querySelector('[data-testid="git-pill"]')).toBeTruthy();
    expect(
      root.querySelector('[data-testid="conversation-workspace"]'),
    ).toBeTruthy();
    expect(root.querySelector('[data-testid="prompt-input"]')).toBeTruthy();
    expect(textOf(root.querySelector('[data-testid="project-path-label"]'))).toBe(
      DEMO_PROJECT_PATH,
    );
  });

  it("opens a lightweight file view from the Files rail without dropping conversation", async () => {
    const shell = buildShell({ demoPrompt: null });
    await shell.mount();
    (root.querySelector('[data-testid="open-demo"]') as HTMLButtonElement).click();
    await flush();
    (
      root.querySelector('[data-testid="trust-continue"]') as HTMLButtonElement
    ).click();
    await flush(20);

    const fileBtn = root.querySelector(
      '[data-testid="file-README.md"]',
    ) as HTMLButtonElement | null;
    expect(fileBtn).toBeTruthy();
    fileBtn!.click();
    await flush();

    expect(root.querySelector('[data-testid="file-preview"]')).toBeTruthy();
    expect(textOf(root.querySelector('[data-testid="file-view"]'))).toMatch(
      /demo-api/,
    );
    // Conversation host still present
    expect(
      root.querySelector('[data-testid="conversation-workspace"]'),
    ).toBeTruthy();
  });

  it("keeps non-Git projects usable", async () => {
    const shell = buildShell({
      demoPrompt: null,
      host: withNonGitDemo(createDemoProjectHost()),
    });
    await shell.mount();
    const input = root.querySelector(
      '[data-testid="project-path"]',
    ) as HTMLInputElement;
    input.value = NON_GIT_DEMO_PATH;
    (root.querySelector('[data-testid="open-project"]') as HTMLButtonElement).click();
    await flush();
    (
      root.querySelector('[data-testid="trust-continue"]') as HTMLButtonElement
    ).click();
    await flush(20);

    expect(root.querySelector('[data-testid="git-none"]')).toBeTruthy();
    expect(textOf(root.querySelector('[data-testid="file-tree"]'))).toMatch(
      /notes\.txt/,
    );
    expect(
      root.querySelector('[data-testid="conversation-workspace"]'),
    ).toBeTruthy();
  });

  it("shows path-error recovery actions for missing folders", async () => {
    const shell = buildShell();
    await shell.mount();
    const input = root.querySelector(
      '[data-testid="project-path"]',
    ) as HTMLInputElement;
    input.value = "/tmp/does-not-exist-project-xyz";
    (root.querySelector('[data-testid="open-project"]') as HTMLButtonElement).click();
    await flush();

    expect(root.querySelector('[data-testid="project-error"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="recovery-choose_other"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="recovery-open_demo"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="recovery-retry"]')).toBeTruthy();
  });

  it("reopens the current Project from recent memory", async () => {
    const shell = buildShell({ demoPrompt: null });
    await shell.mount();
    (root.querySelector('[data-testid="open-demo"]') as HTMLButtonElement).click();
    await flush();
    // Back out without entering workspace so reopen is still available on choose
    // Use Change is only in workspace — go back from trust
    const back = Array.from(root.querySelectorAll("button")).find((b) =>
      textOf(b).includes("Back"),
    ) as HTMLButtonElement | undefined;
    expect(back).toBeTruthy();
    back!.click();
    await flush();

    expect(root.querySelector('[data-testid="first-use-choose"]')).toBeTruthy();
    const reopen = root.querySelector(
      '[data-testid="reopen-current"]',
    ) as HTMLButtonElement;
    expect(reopen.disabled).toBe(false);
    reopen.click();
    await flush();
    expect(root.querySelector('[data-testid="first-use-trust"]')).toBeTruthy();
    expect(textOf(root.querySelector('[data-testid="trust-project-path"]'))).toMatch(
      /grok-gui-demo-project/,
    );
  });
});
