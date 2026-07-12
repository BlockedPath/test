import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ProjectService, isProjectError } from "./service";
import {
  createDemoProjectHost,
  createMemoryProjectHost,
  DEMO_PROJECT_PATH,
  NON_GIT_DEMO_PATH,
  withNonGitDemo,
} from "./memory-host";
import { createMemoryRecentStore } from "./recent-store";
import { createNodeProjectHost } from "./node-host";
import { TRUST_RULES } from "./trust";

describe("ProjectService", () => {
  it("opens a project, loads a file tree, and remembers it for reopen", async () => {
    const host = withNonGitDemo(createDemoProjectHost());
    const recent = createMemoryRecentStore();
    const service = new ProjectService({
      host,
      recent,
      demoProjectPath: DEMO_PROJECT_PATH,
    });

    const project = await service.open(DEMO_PROJECT_PATH);
    expect(project.path).toBe(DEMO_PROJECT_PATH);
    expect(project.name).toBe("grok-gui-demo-project");
    expect(project.trustAcknowledged).toBe(false);
    expect(project.tree.some((n) => n.name === "README.md")).toBe(true);
    expect(project.tree.some((n) => n.name === "src")).toBe(true);
    const src = project.tree.find((n) => n.name === "src");
    expect(src?.children?.some((c) => c.name === "server.js")).toBe(true);

    expect(service.listRecent()).toEqual([DEMO_PROJECT_PATH]);
    expect(service.currentRecent()).toBe(DEMO_PROJECT_PATH);

    service.close();
    expect(service.getOpened()).toBeNull();

    const reopened = await service.reopenCurrent();
    expect(reopened.path).toBe(DEMO_PROJECT_PATH);
  });

  it("exposes the agreed trust summary before workspace entry", async () => {
    const service = new ProjectService({
      host: createDemoProjectHost(),
      recent: createMemoryRecentStore(),
    });
    const summary = service.trustSummary();
    expect(summary.title).toMatch(/allow/i);
    const ids = summary.rules.map((r) => r.id);
    expect(ids).toEqual(["read", "edit", "command", "outside", "yolo"]);
    expect(TRUST_RULES.length).toBe(5);

    await service.open(DEMO_PROJECT_PATH);
    const acked = service.acknowledgeTrust();
    expect(acked.trustAcknowledged).toBe(true);
  });

  it("shows Git working-tree status when the Project is a repo", async () => {
    const service = new ProjectService({
      host: createDemoProjectHost(),
      recent: createMemoryRecentStore(),
    });
    const project = await service.open(DEMO_PROJECT_PATH);
    expect(project.git).not.toBeNull();
    expect(project.git!.isRepo).toBe(true);
    expect(project.git!.branch).toBe("main");
    expect(project.git!.dirty).toBe(true);
    expect(project.git!.summary).toMatch(/main/);
    expect(project.git!.entries.length).toBeGreaterThan(0);
  });

  it("keeps non-Git Projects usable without a Git surface", async () => {
    const host = withNonGitDemo(createDemoProjectHost());
    const service = new ProjectService({
      host,
      recent: createMemoryRecentStore(),
    });
    const project = await service.open(NON_GIT_DEMO_PATH);
    expect(project.git).toBeNull();
    expect(project.tree.some((n) => n.name === "notes.txt")).toBe(true);

    const file = await service.readFile("notes.txt");
    expect(file.content).toMatch(/without git/);
  });

  it("returns clear recovery actions for missing folders", async () => {
    const host = createDemoProjectHost();
    const recent = createMemoryRecentStore([DEMO_PROJECT_PATH]);
    const service = new ProjectService({
      host,
      recent,
      demoProjectPath: DEMO_PROJECT_PATH,
    });

    try {
      await service.open("/tmp/does-not-exist-grok-gui-xyz");
      expect.unreachable("should throw");
    } catch (err) {
      expect(isProjectError(err)).toBe(true);
      if (isProjectError(err)) {
        expect(err.code).toBe("path_not_found");
        expect(err.message).toMatch(/not found/i);
        const ids = err.recovery.map((r) => r.id);
        expect(ids).toContain("choose_other");
        expect(ids).toContain("reopen_recent");
        expect(ids).toContain("retry");
        expect(err.recovery.some((r) => r.path === DEMO_PROJECT_PATH)).toBe(
          true,
        );
      }
    }
  });

  it("rejects files that are not directories", async () => {
    const host = createMemoryProjectHost({
      roots: {
        "/tmp/only-file": {
          kind: "directory",
          children: {
            "readme.txt": { kind: "file", content: "x" },
          },
        },
      },
    });
    const service = new ProjectService({
      host,
      recent: createMemoryRecentStore(),
    });
    try {
      await service.open("/tmp/only-file/readme.txt");
      expect.unreachable("should throw");
    } catch (err) {
      expect(isProjectError(err)).toBe(true);
      if (isProjectError(err)) {
        expect(err.code).toBe("path_not_directory");
        expect(err.recovery.length).toBeGreaterThan(0);
      }
    }
  });

  it("reads a lightweight file view from the opened Project", async () => {
    const service = new ProjectService({
      host: createDemoProjectHost(),
      recent: createMemoryRecentStore(),
    });
    await service.open(DEMO_PROJECT_PATH);
    const file = await service.readFile(`${DEMO_PROJECT_PATH}/src/server.js`);
    expect(file.content).toMatch(/createServer/);
    expect(file.truncated).toBe(false);
  });
});

describe("createNodeProjectHost", () => {
  it("lists a real directory and reports Git when present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-gui-proj-"));
    try {
      writeFileSync(join(dir, "hello.txt"), "hi\n");
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "a.ts"), "export {}\n");
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "t@example.com"], {
        cwd: dir,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
      execFileSync("git", ["add", "."], { cwd: dir });
      execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
      writeFileSync(join(dir, "hello.txt"), "changed\n");

      const host = createNodeProjectHost();
      const service = new ProjectService({
        host,
        recent: createMemoryRecentStore(),
      });
      const project = await service.open(dir);
      expect(project.tree.some((n) => n.name === "hello.txt")).toBe(true);
      expect(project.git).not.toBeNull();
      expect(project.git!.isRepo).toBe(true);
      expect(project.git!.dirty).toBe(true);
      expect(project.git!.summary.length).toBeGreaterThan(0);

      const file = await service.readFile(join(dir, "hello.txt"));
      expect(file.content).toBe("changed\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null git for a plain folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grok-gui-nongit-"));
    try {
      writeFileSync(join(dir, "x.txt"), "x");
      const host = createNodeProjectHost();
      const git = await host.readGitStatus(dir);
      expect(git).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
