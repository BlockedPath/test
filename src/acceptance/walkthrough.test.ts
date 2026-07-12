/**
 * @vitest-environment happy-dom
 *
 * Personal v1 acceptance walkthrough (issue #19).
 * Drives ProjectShell + ConversationApp + FakeAgentEngine at external seams.
 * Native Windows packaging/install steps are classified honestly as unexecuted.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryFileWriteHost } from "../edits";
import { FakeAgentEngine } from "../engine/fake-engine";
import type { GuiEvent } from "../engine/types";
import {
  classifyHostEnvironment,
  planCleanProfileSmoke,
  skipLiveStepsOnNonWindows,
  CLEAN_PROFILE_SMOKE_STEPS,
} from "../packaging/clean-profile-smoke";
import {
  DEMO_PROJECT_PATH,
  ProjectService,
  ProjectShell,
  createDemoProjectHost,
  createMemoryRecentStore,
} from "../project";
import {
  createSessionSafetyState,
  decideAction,
  YOLO_INDICATOR_LABEL,
  YOLO_WARNING,
} from "../safety";
import {
  PERSONAL_V1_WALKTHROUGH,
  buildAcceptanceRecord,
  buildHostMeta,
  defaultGapsForHost,
  formatAcceptanceMarkdown,
  type ScenarioResult,
} from "./index";

async function flush(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 5;
  const label = options.label ?? "condition";
  const start = Date.now();
  await Promise.resolve();
  await Promise.resolve();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await flush(intervalMs);
  }
}

function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function wslIndicator(): string {
  if (process.env.WSL_DISTRO_NAME) {
    return `wsl_distro:${process.env.WSL_DISTRO_NAME}`;
  }
  try {
    return readFileSync("/proc/version", "utf8").slice(0, 200);
  } catch {
    return process.env.WSL_INTEROP ? "wsl_interop" : "";
  }
}

describe("Personal v1 acceptance walkthrough catalog", () => {
  it("covers every issue #19 acceptance bullet in order", () => {
    expect(PERSONAL_V1_WALKTHROUGH).toHaveLength(9);
    const orders = PERSONAL_V1_WALKTHROUGH.map((s) => s.order);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const s of PERSONAL_V1_WALKTHROUGH) {
      expect(s.passCriteria.length).toBeGreaterThan(0);
      expect(s.acceptanceBullet.length).toBeGreaterThan(10);
    }
  });
});

describe("Personal v1 acceptance walkthrough (executable)", () => {
  let root: HTMLElement;
  const scenarioResults: ScenarioResult[] = [];

  beforeEach(() => {
    document.body.innerHTML = "";
    root = document.createElement("div");
    root.id = "app";
    document.body.appendChild(root);
    // happy-dom may not implement confirm; YOLO enable needs it.
    window.confirm = () => true;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function buildShell(options?: {
    createEngine?: () => FakeAgentEngine;
    fileWriteHost?: ReturnType<typeof createMemoryFileWriteHost>;
    demoPrompt?: string | null;
  }): {
    shell: ProjectShell;
    host: ReturnType<typeof createMemoryFileWriteHost>;
  } {
    const projects = new ProjectService({
      host: createDemoProjectHost(),
      recent: createMemoryRecentStore(),
      demoProjectPath: DEMO_PROJECT_PATH,
    });
    const host =
      options?.fileWriteHost ??
      createMemoryFileWriteHost({
        "src/main.ts": "console.log('boot');\n",
        "src/legacy.ts": "export const legacy = true;\n",
      });
    const shell = new ProjectShell(root, {
      projects,
      createEngine:
        options?.createEngine ??
        (() =>
          new FakeAgentEngine({
            streamDelayMs: 0,
            richTurn: true,
            proposeEditsOnPrompt: false,
          })),
      fileWriteHost: host,
      autoDemoPrompt: options?.demoPrompt ?? null,
    });
    return { shell, host };
  }

  async function openDemoWorkspace(shell: ProjectShell): Promise<void> {
    await shell.mount();
    (root.querySelector('[data-testid="open-demo"]') as HTMLButtonElement).click();
    await flush();
    (
      root.querySelector('[data-testid="trust-continue"]') as HTMLButtonElement
    ).click();
    await waitUntil(
      () => Boolean(root.querySelector('[data-testid="conversation-workspace"]')),
      { label: "workspace mount" },
    );
  }

  async function sendPrompt(text: string): Promise<void> {
    const input = root.querySelector(
      '[data-testid="prompt-input"]',
    ) as HTMLTextAreaElement;
    const send = root.querySelector('[data-testid="send"]') as HTMLButtonElement;
    input.value = text;
    send.click();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("1+2: CLI-owned auth seam + open Project + conversation-first workspace", async () => {
    const events: GuiEvent[] = [];
    let engineRef: FakeAgentEngine | null = null;
    const { shell } = buildShell({
      createEngine: () => {
        engineRef = new FakeAgentEngine({
          streamDelayMs: 0,
          richTurn: true,
        });
        engineRef.subscribe((e) => events.push(e));
        return engineRef;
      },
      demoPrompt: null,
    });

    await openDemoWorkspace(shell);

    // Auth is CLI-owned through the port: createSession path emits authenticated.
    expect(events.some((e) => e.type === "engine.authenticated")).toBe(true);
    expect(events.some((e) => e.type === "engine.started")).toBe(true);
    expect(events.some((e) => e.type === "session.created")).toBe(true);

    expect(root.querySelector('[data-testid="project-workspace"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="files-rail"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="file-tree"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="conversation-workspace"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="prompt-input"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="git-pill"], [data-testid="git-none"]')).toBeTruthy();

    // Explore: send a prompt, see conversation + tool activity
    await sendPrompt("Explore the project layout");
    await waitUntil(
      () => {
        const turn = textOf(root.querySelector('[data-testid="turn-status"]'));
        return /completed|success|end_turn/i.test(turn);
      },
      { label: "explore turn complete" },
    );
    expect(textOf(root.querySelector('[data-testid="messages"]'))).toMatch(
      /Explore the project layout/,
    );
    expect(engineRef!.getSnapshot()?.state).toBe("idle");
    expect(engineRef!.getSnapshot()?.engineVersion).toBeTruthy();

    const hostEnv = classifyHostEnvironment({
      platform: process.platform,
      wslIndicator: wslIndicator(),
    });

    scenarioResults.push({
      id: "fresh_install_cli_auth",
      title: PERSONAL_V1_WALKTHROUGH[0]!.title,
      status: hostEnv === "native_windows" ? "passed" : "unexecuted",
      detail:
        hostEnv === "native_windows"
          ? undefined
          : `NSIS/WebView2/live CLI auth requires native Windows; host is ${hostEnv}. Auth seam proven via FakeAgentEngine: engine.authenticated emitted.`,
      evidence: [
        `engine.authenticated events=${events.filter((e) => e.type === "engine.authenticated").length}`,
        `engine.started with version=${engineRef!.getSnapshot()?.engineVersion}`,
        `host=${hostEnv}`,
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[0]!.passCriteria],
    });

    scenarioResults.push({
      id: "open_project_conversation",
      title: PERSONAL_V1_WALKTHROUGH[1]!.title,
      status: "passed",
      evidence: [
        "first-use → trust → workspace",
        "files rail + git status present",
        "conversation primary + explore turn end_turn",
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[1]!.passCriteria],
    });
  });

  it("3: multi-file edit — review, deselect, apply only selected", async () => {
    const host = createMemoryFileWriteHost({
      "src/main.ts": "console.log('boot');\n",
      "src/legacy.ts": "export const legacy = true;\n",
    });
    let engineRef: FakeAgentEngine | null = null;
    const { shell } = buildShell({
      fileWriteHost: host,
      createEngine: () => {
        engineRef = new FakeAgentEngine({
          streamDelayMs: 0,
          richTurn: false,
          proposeEditsOnPrompt: true,
        });
        return engineRef;
      },
    });
    await openDemoWorkspace(shell);
    await sendPrompt("Propose multi-file edits");
    await waitUntil(
      () => root.querySelectorAll('[data-testid="file-change-row"]').length >= 3,
      { label: "edit batch rows" },
    );

    const batchEl = root.querySelector('[data-testid="file-change-batch"]');
    expect(batchEl).toBeTruthy();
    expect(textOf(batchEl)).toMatch(/health\.ts|main\.ts|legacy\.ts/);

    // Expand first file for full diff review
    const expand = root.querySelector(
      '[data-testid="file-change-expand"]',
    ) as HTMLButtonElement;
    expand.click();
    await flush(10);
    expect(root.querySelector('[data-testid="file-change-full-diff"]')).toBeTruthy();

    // Deselect main.ts (index 1)
    const boxes = root.querySelectorAll(
      '[data-testid="file-change-select"]',
    ) as NodeListOf<HTMLInputElement>;
    expect(boxes.length).toBe(3);
    boxes[1]!.click();
    await flush(10);
    expect(boxes[1]!.checked).toBe(false);

    (
      root.querySelector('[data-testid="file-change-apply"]') as HTMLButtonElement
    ).click();
    await waitUntil(
      () => engineRef!.getSnapshot()?.fileChangeBatches[0]?.status === "resolved",
      { label: "batch resolved" },
    );

    const batch = engineRef!.getSnapshot()!.fileChangeBatches[0]!;
    expect(batch.changes.map((c) => c.status)).toEqual([
      "applied",
      "skipped",
      "applied",
    ]);
    expect(host.files.has("src/health.ts")).toBe(true);
    expect(host.files.get("src/main.ts")).toBe("console.log('boot');\n");
    expect(host.files.has("src/legacy.ts")).toBe(false);

    scenarioResults.push({
      id: "multi_file_edit_selected_apply",
      title: PERSONAL_V1_WALKTHROUGH[2]!.title,
      status: "passed",
      evidence: [
        "3-file batch with inline + full diff",
        "statuses applied/skipped/applied",
        "main.ts unchanged on disk host",
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[2]!.passCriteria],
    });
  });

  it("4: command approval → Activity output → failing command recovery", async () => {
    let engineRef: FakeAgentEngine | null = null;
    const { shell } = buildShell({
      createEngine: () => {
        engineRef = new FakeAgentEngine({
          streamDelayMs: 0,
          richTurn: false,
          commandTurn: true,
          commandFail: true,
        });
        return engineRef;
      },
    });
    await openDemoWorkspace(shell);

    // Opening Project must not auto-authorize commands
    expect(engineRef!.getSnapshot()?.pendingApprovals.length ?? 0).toBe(0);

    await sendPrompt("Run the smoke command");
    await waitUntil(
      () => (engineRef!.getSnapshot()?.pendingApprovals.length ?? 0) > 0,
      { label: "command approval pending" },
    );
    expect(root.querySelector('[data-testid="approval-panel"]')).toBeTruthy();
    expect(
      root.querySelector('[data-testid="approval-panel"]')!.classList.contains(
        "hidden",
      ),
    ).toBe(false);

    (
      root.querySelector('[data-testid="approval-allow"]') as HTMLButtonElement
    ).click();
    await waitUntil(
      () => {
        const terms = Object.values(engineRef!.getSnapshot()?.terminals ?? {});
        return terms.some((t) => t.exitCode === 1);
      },
      { label: "failing command exit 1" },
    );

    expect(textOf(root.querySelector('[data-testid="activity-panel"]'))).toMatch(
      /SPIKE_TERM|command failed|exit|1/i,
    );
    // Recover: send another prompt after failure
    await waitUntil(
      () => {
        const snap = engineRef!.getSnapshot();
        return (
          snap?.state === "idle" ||
          snap?.state === "completed_turn" ||
          Boolean(snap?.turn?.stopReason)
        );
      },
      { label: "turn settled after command fail" },
    );
    // Force idle path: if still in awaiting, that's ok; send after turn completes
    await waitUntil(
      () => {
        const send = root.querySelector(
          '[data-testid="send"]',
        ) as HTMLButtonElement | null;
        return Boolean(send && !send.disabled);
      },
      { label: "send re-enabled" },
    );
    await sendPrompt("Retry after failure");
    await waitUntil(
      () => (engineRef!.getSnapshot()?.pendingApprovals.length ?? 0) > 0,
      { label: "second command approval" },
    );
    // Deny second to finish cleanly
    (
      root.querySelector('[data-testid="approval-deny"]') as HTMLButtonElement
    ).click();
    await flush(20);

    scenarioResults.push({
      id: "command_activity_and_failure",
      title: PERSONAL_V1_WALKTHROUGH[3]!.title,
      status: "passed",
      evidence: [
        "approval required before command",
        "Activity shows failed exit 1",
        "composer usable for subsequent turn",
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[3]!.passCriteria],
    });
  });

  it("5: reject diff writes nothing", async () => {
    const host = createMemoryFileWriteHost({
      "src/main.ts": "console.log('boot');\n",
      "src/legacy.ts": "export const legacy = true;\n",
    });
    let engineRef: FakeAgentEngine | null = null;
    const { shell } = buildShell({
      fileWriteHost: host,
      createEngine: () => {
        engineRef = new FakeAgentEngine({
          streamDelayMs: 0,
          richTurn: false,
          proposeEditsOnPrompt: true,
        });
        return engineRef;
      },
    });
    await openDemoWorkspace(shell);
    await sendPrompt("edit please");
    await waitUntil(
      () => root.querySelector('[data-testid="file-change-reject"]') != null,
      { label: "reject control" },
    );
    (
      root.querySelector('[data-testid="file-change-reject"]') as HTMLButtonElement
    ).click();
    await waitUntil(
      () => engineRef!.getSnapshot()?.fileChangeBatches[0]?.status === "resolved",
      { label: "reject resolved" },
    );

    const batch = engineRef!.getSnapshot()!.fileChangeBatches[0]!;
    expect(batch.changes.every((c) => c.status === "rejected")).toBe(true);
    expect(host.files.has("src/health.ts")).toBe(false);
    expect(host.files.has("src/legacy.ts")).toBe(true);

    scenarioResults.push({
      id: "reject_diff_no_write",
      title: PERSONAL_V1_WALKTHROUGH[4]!.title,
      status: "passed",
      evidence: ["all changes rejected", "host files unchanged for creates"],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[4]!.passCriteria],
    });
  });

  it("6: cancel is distinguishable from successful completion", async () => {
    let engineRef: FakeAgentEngine | null = null;
    const { shell } = buildShell({
      createEngine: () => {
        // hangTurn with streamDelayMs 0 parks ~60s until cancel clears timers.
        engineRef = new FakeAgentEngine({
          streamDelayMs: 0,
          richTurn: false,
          hangTurn: true,
        });
        return engineRef;
      },
    });
    await openDemoWorkspace(shell);

    // Success path first (separate engine config)
    const successEngine = new FakeAgentEngine({
      streamDelayMs: 0,
      richTurn: false,
    });
    await successEngine.start({ projectPath: DEMO_PROJECT_PATH });
    await successEngine.createSession({ cwd: DEMO_PROJECT_PATH });
    await successEngine.sendPrompt("quick success");
    await flush(10);
    expect(successEngine.getSnapshot()?.turn?.stopReason).toBe("end_turn");

    // Cancel path on mounted hung turn
    await sendPrompt("long running");
    await waitUntil(
      () => engineRef!.getSnapshot()?.state === "running",
      { label: "hung turn running" },
    );
    (root.querySelector('[data-testid="stop"]') as HTMLButtonElement).click();
    await waitUntil(
      () => engineRef!.getSnapshot()?.turn?.stopReason === "cancelled",
      { label: "cancelled stopReason" },
    );
    const turnStatus = textOf(root.querySelector('[data-testid="turn-status"]'));
    expect(turnStatus).toMatch(/cancel|interrupt/i);
    expect(turnStatus).not.toMatch(/success \(end_turn\)/);

    scenarioResults.push({
      id: "cancel_vs_success",
      title: PERSONAL_V1_WALKTHROUGH[5]!.title,
      status: "passed",
      evidence: [
        "success stopReason=end_turn",
        `cancel UI: ${turnStatus}`,
        "snapshot stopReason=cancelled",
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[5]!.passCriteria],
    });
  });

  it("7: YOLO normal path with elevated/hard-block protection", async () => {
    let engineRef: FakeAgentEngine | null = null;
    const { shell } = buildShell({
      createEngine: () => {
        engineRef = new FakeAgentEngine({
          streamDelayMs: 0,
          richTurn: false,
          commandTurn: true,
        });
        return engineRef;
      },
    });
    await openDemoWorkspace(shell);

    // Enable YOLO via UI (confirm stubbed true)
    expect(YOLO_WARNING).toMatch(/elevated|hard blocks|Emergency Stop/i);
    (
      root.querySelector('[data-testid="yolo-toggle"]') as HTMLButtonElement
    ).click();
    await waitUntil(
      () => engineRef!.getSnapshot()?.yoloEnabled === true,
      { label: "yolo enabled" },
    );
    expect(
      root.querySelector('[data-testid="yolo-banner"]')?.classList.contains(
        "hidden",
      ),
    ).toBe(false);
    expect(textOf(root.querySelector('[data-testid="yolo-banner"]'))).toMatch(
      new RegExp(YOLO_INDICATOR_LABEL.slice(0, 8), "i"),
    );

    // Normal command under YOLO auto-allows (no stuck approval)
    await sendPrompt("run under yolo");
    await waitUntil(
      () => {
        const terms = Object.values(engineRef!.getSnapshot()?.terminals ?? {});
        return terms.some((t) => t.exitCode === 0);
      },
      { label: "yolo auto-allowed command" },
    );
    expect(engineRef!.getSnapshot()?.pendingApprovals.length ?? 0).toBe(0);

    // Elevated + hard_block still protected under YOLO
    const yoloState = {
      ...createSessionSafetyState(DEMO_PROJECT_PATH),
      yoloEnabled: true,
    };
    expect(
      decideAction(yoloState, {
        kind: "command",
        command: "git",
        args: ["push", "--force", "origin", "main"],
        cwd: DEMO_PROJECT_PATH,
      }).decision,
    ).toBe("prompt");
    expect(
      decideAction(yoloState, {
        kind: "edit",
        path: `${DEMO_PROJECT_PATH}/src/a.ts`,
        content: "Bearer supersecrettokenvalue",
      }).decision,
    ).toBe("hard_block");

    // Emergency Stop clears YOLO for next session
    await engineRef!.emergencyStop();
    await engineRef!.createSession({ cwd: DEMO_PROJECT_PATH });
    expect(engineRef!.getSnapshot()?.yoloEnabled).toBe(false);

    scenarioResults.push({
      id: "yolo_normal_with_protections",
      title: PERSONAL_V1_WALKTHROUGH[6]!.title,
      status: "passed",
      evidence: [
        "YOLO banner visible",
        "normal command auto-allowed exit 0",
        "elevated force-push still prompt",
        "secret edit hard_block",
        "Emergency Stop → next session YOLO off",
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[6]!.passCriteria],
    });
  });

  it("8: relaunch / recovery via auth and CLI fallback", async () => {
    let engineRef: FakeAgentEngine | null = null;
    const { shell } = buildShell({
      createEngine: () => {
        engineRef = new FakeAgentEngine({
          streamDelayMs: 0,
          richTurn: false,
          faultOnPrompt: true,
        });
        return engineRef;
      },
    });
    await openDemoWorkspace(shell);
    await sendPrompt("trigger fault");
    await waitUntil(
      () =>
        Boolean(root.querySelector('[data-testid="error-recovery"]')) &&
        !root
          .querySelector('[data-testid="error-recovery"]')!
          .classList.contains("hidden"),
      { label: "error recovery visible" },
    );

    expect(root.querySelector('[data-testid="recover-retry-engine"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="recover-reset-session"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="recover-cli-fallback"]')).toBeTruthy();

    // CLI fallback path documents terminal repair
    (
      root.querySelector(
        '[data-testid="recover-cli-fallback"]',
      ) as HTMLButtonElement
    ).click();
    await flush();
    expect(textOf(root.querySelector('[data-testid="error-recovery"]'))).toMatch(
      /CLI|grok|terminal/i,
    );
    expect(textOf(root.querySelector('[data-testid="error-recovery"]'))).toMatch(
      /not rolled back|Nothing was rolled back/i,
    );

    // Reset Session restores usable session
    (
      root.querySelector(
        '[data-testid="recover-reset-session"]',
      ) as HTMLButtonElement
    ).click();
    await waitUntil(
      () => engineRef!.getSnapshot()?.state === "idle",
      { label: "reset session idle" },
    );
    expect(engineRef!.getSnapshot()?.yoloEnabled).toBe(false);

    // Thin relaunch: dispose + new engine authenticate path (port-level)
    const relaunch = new FakeAgentEngine({ streamDelayMs: 0, richTurn: false });
    const events: GuiEvent[] = [];
    relaunch.subscribe((e) => events.push(e));
    await relaunch.start({ projectPath: DEMO_PROJECT_PATH });
    await relaunch.authenticate();
    const sid = await relaunch.createSession({ cwd: DEMO_PROJECT_PATH });
    expect(sid).toBeTruthy();
    expect(events.some((e) => e.type === "engine.authenticated")).toBe(true);
    await relaunch.resumeSession(sid);
    expect(events.some((e) => e.type === "session.resumed")).toBe(true);

    scenarioResults.push({
      id: "relaunch_auth_cli_fallback",
      title: PERSONAL_V1_WALKTHROUGH[7]!.title,
      status: "passed",
      evidence: [
        "CLI fallback copy visible",
        "Reset Session → idle",
        "relaunch authenticate + resumeSession",
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[7]!.passCriteria],
    });
  });

  it("9: Windows packaging smoke recorded honestly for this host", () => {
    const indicator = wslIndicator();
    const decision = planCleanProfileSmoke({
      platform: process.platform,
      wslIndicator: indicator,
      nsisArtifactPath: process.env.NSIS_SETUP ?? null,
    });
    const live = skipLiveStepsOnNonWindows(decision);

    if (decision.mode === "plan_only") {
      expect(live.every((s) => s.status === "skipped")).toBe(true);
      expect(decision.reason).toMatch(/native Windows/i);
    }

    expect(CLEAN_PROFILE_SMOKE_STEPS.length).toBeGreaterThanOrEqual(6);
    expect(CLEAN_PROFILE_SMOKE_STEPS.map((s) => s.id)).toContain(
      "cli_owned_auth",
    );

    const host = buildHostMeta({
      platform: process.platform,
      arch: process.arch,
      wslIndicator: indicator,
      nodeVersion: process.version,
    });

    scenarioResults.push({
      id: "windows_packaging_smoke_record",
      title: PERSONAL_V1_WALKTHROUGH[8]!.title,
      // Pass = results recorded honestly (live steps may still be unexecuted).
      status: "passed",
      detail:
        decision.mode === "plan_only"
          ? `Recorded with live steps unexecuted: ${decision.reason}`
          : "Live mode available; individual steps still require runner execution.",
      evidence: [
        `smoke mode=${decision.mode}`,
        `environment=${host.environment}`,
        `live steps classified=${live.map((s) => `${s.id}:${s.status}`).join(",")}`,
        `failure matrix scenarios defined (${CLEAN_PROFILE_SMOKE_STEPS.length} install path steps)`,
        "gaps classified via defaultGapsForHost",
      ],
      passCriteria: [...PERSONAL_V1_WALKTHROUGH[8]!.passCriteria],
    });

    // Build full record shape used by docs/script
    const byId = new Map(scenarioResults.map((s) => [s.id, s]));
    // Ensure all 9 ids present for record assembly in this last test —
    // earlier tests may run in parallel isolation; re-assert catalog integrity here.
    for (const s of PERSONAL_V1_WALKTHROUGH) {
      if (!byId.has(s.id) && s.executionMode === "native_windows") {
        byId.set(s.id, {
          id: s.id,
          title: s.title,
          status: "unexecuted",
          evidence: [],
          detail: `Not observed in this test isolation; see dedicated scenario tests.`,
          passCriteria: [...s.passCriteria],
        });
      }
    }

    const record = buildAcceptanceRecord({
      host,
      scenarios: PERSONAL_V1_WALKTHROUGH.map(
        (s) =>
          byId.get(s.id) ?? {
            id: s.id,
            title: s.title,
            status: "skipped" as const,
            evidence: [],
            detail: "Not collected in this process (vitest isolation).",
            passCriteria: [...s.passCriteria],
          },
      ),
      gaps: defaultGapsForHost(host.environment),
    });

    const md = formatAcceptanceMarkdown(record);
    expect(md).toMatch(/Personal v1 acceptance walkthrough/);
    expect(md).toMatch(/Remaining gaps/);
    if (host.environment !== "native_windows") {
      expect(md).toMatch(/UNEXECUTED|unexecuted|environment/i);
      expect(record.gaps.some((g) => g.classification === "environment")).toBe(
        true,
      );
    }
  });
});
