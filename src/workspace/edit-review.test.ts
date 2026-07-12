/**
 * @vitest-environment happy-dom
 *
 * Edit review UI: multi-file selection, apply/reject, distinct statuses.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryFileWriteHost } from "../edits";
import { FakeAgentEngine } from "../engine/fake-engine";
import { ConversationApp } from "./app";

async function flush(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("Edit review (ConversationApp × file change batches)", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    document.body.appendChild(root);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mountWithEdits(): Promise<{
    engine: FakeAgentEngine;
    host: ReturnType<typeof createMemoryFileWriteHost>;
    app: ConversationApp;
  }> {
    const engine = new FakeAgentEngine({
      streamDelayMs: 0,
      richTurn: false,
      proposeEditsOnPrompt: true,
    });
    const host = createMemoryFileWriteHost({
      "src/main.ts": "console.log('boot');\n",
      "src/legacy.ts": "export const legacy = true;\n",
    });
    const app = new ConversationApp(root, engine, {
      projectPath: "/tmp/demo-project",
      autoDemoPrompt: null,
      fileWriteHost: host,
    });
    await app.mount();
    return { engine, host, app };
  }

  it("shows a multi-file edit batch with paths and inline diffs", async () => {
    const { engine } = await mountWithEdits();
    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "please edit the project";
    send.click();
    await flush(40);

    const batch = root.querySelector('[data-testid="file-change-batch"]');
    expect(batch).toBeTruthy();
    expect(textOf(batch)).toMatch(/health\.ts|main\.ts|legacy\.ts/);
    expect(root.querySelectorAll('[data-testid="file-change-row"]').length).toBe(
      3,
    );
    expect(textOf(batch)).toMatch(/\+|health|export/i);
    expect(engine.getSnapshot()?.fileChangeBatches[0]?.status).toBe("pending");
  });

  it("supports approve-all, reject-all, and per-file selection", async () => {
    await mountWithEdits();
    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "edit";
    send.click();
    await flush(40);

    const checkboxes = root.querySelectorAll(
      '[data-testid="file-change-select"]',
    ) as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBe(3);
    // deselect middle file
    checkboxes[1]!.click();
    await flush(10);
    expect(checkboxes[1]!.checked).toBe(false);

    const selectAll = root.querySelector(
      '[data-testid="file-change-select-all"]',
    ) as HTMLButtonElement;
    selectAll.click();
    await flush(10);
    expect(
      Array.from(
        root.querySelectorAll(
          '[data-testid="file-change-select"]',
        ) as NodeListOf<HTMLInputElement>,
      ).every((c) => c.checked),
    ).toBe(true);
  });

  it("applies only selected files; skipped remain not written", async () => {
    const { host, engine } = await mountWithEdits();
    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "edit";
    send.click();
    await flush(40);

    // Deselect main.ts (index 1 in demo batch)
    const checkboxes = root.querySelectorAll(
      '[data-testid="file-change-select"]',
    ) as NodeListOf<HTMLInputElement>;
    checkboxes[1]!.click();
    await flush(10);

    const applyBtn = root.querySelector(
      '[data-testid="file-change-apply"]',
    ) as HTMLButtonElement;
    applyBtn.click();
    await flush(40);

    const batch = engine.getSnapshot()?.fileChangeBatches[0];
    expect(batch?.status).toBe("resolved");
    expect(batch?.changes.map((c) => c.status)).toEqual([
      "applied",
      "skipped",
      "applied",
    ]);

    // health created, legacy deleted, main unchanged
    expect(host.files.has("src/health.ts")).toBe(true);
    expect(host.files.has("src/legacy.ts")).toBe(false);
    expect(host.files.get("src/main.ts")).toBe("console.log('boot');\n");

    const rows = root.querySelectorAll('[data-testid="file-change-row"]');
    expect(textOf(rows[0]!)).toMatch(/applied/i);
    expect(textOf(rows[1]!)).toMatch(/skipped/i);
    expect(textOf(rows[2]!)).toMatch(/applied/i);
  });

  it("reject-all writes nothing and marks rejected", async () => {
    const { host, engine } = await mountWithEdits();
    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "edit";
    send.click();
    await flush(40);

    const rejectBtn = root.querySelector(
      '[data-testid="file-change-reject"]',
    ) as HTMLButtonElement;
    rejectBtn.click();
    await flush(20);

    const batch = engine.getSnapshot()?.fileChangeBatches[0];
    expect(batch?.status).toBe("resolved");
    expect(batch?.changes.every((c) => c.status === "rejected")).toBe(true);
    expect(host.files.has("src/health.ts")).toBe(false);
    expect(host.files.has("src/legacy.ts")).toBe(true);
  });

  it("expands a file to full diff review", async () => {
    await mountWithEdits();
    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "edit";
    send.click();
    await flush(40);

    const expand = root.querySelector(
      '[data-testid="file-change-expand"]',
    ) as HTMLButtonElement;
    expand.click();
    await flush(10);

    const full = root.querySelector('[data-testid="file-change-full-diff"]');
    expect(full).toBeTruthy();
    expect(textOf(full)).toMatch(/health|export|function/i);
  });

  it("surfaces write failures as failed status", async () => {
    const engine = new FakeAgentEngine({
      streamDelayMs: 0,
      richTurn: false,
      proposeEditsOnPrompt: true,
    });
    const host = createMemoryFileWriteHost();
    const originalWrite = host.writeTextFile.bind(host);
    host.writeTextFile = async (path, content) => {
      if (path.includes("health")) throw new Error("EACCES health");
      return originalWrite(path, content);
    };
    const app = new ConversationApp(root, engine, {
      projectPath: "/tmp/demo",
      fileWriteHost: host,
    });
    await app.mount();

    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = "edit";
    send.click();
    await flush(40);

    (
      root.querySelector(
        '[data-testid="file-change-apply"]',
      ) as HTMLButtonElement
    ).click();
    await flush(40);

    const batch = engine.getSnapshot()?.fileChangeBatches[0];
    expect(batch?.changes[0]!.status).toBe("failed");
    expect(batch?.changes[0]!.errorMessage).toMatch(/EACCES/);
    expect(textOf(root.querySelector('[data-testid="file-change-row"]'))).toMatch(
      /failed/i,
    );
  });
});
