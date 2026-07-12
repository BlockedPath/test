/**
 * First-use Project shell: choose folder → trust summary → workspace with
 * Files rail + conversation-first ConversationApp (issue #12).
 */

import type { FileWriteHost } from "../edits";
import type { AgentEnginePort } from "../engine/port";
import { ConversationApp } from "../workspace/app";
import { DEMO_PROJECT_PATH } from "./memory-host";
import { isProjectError, type ProjectService } from "./service";
import type {
  FileTreeNode,
  GitWorkingTree,
  ProjectError,
  ProjectPhase,
  ReadFileResult,
  RecoveryAction,
} from "./types";

export type ProjectShellOptions = {
  projects: ProjectService;
  /** Factory so Change Project can start a fresh engine/session. */
  createEngine: () => AgentEnginePort;
  autoDemoPrompt?: string | null;
  /** Applies approved multi-file edits (issue #14). */
  fileWriteHost?: FileWriteHost;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function baseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

function relativePath(root: string, full: string): string {
  const nRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const nFull = full.replace(/\\/g, "/");
  if (nFull.startsWith(nRoot + "/")) return nFull.slice(nRoot.length + 1);
  return full;
}

/**
 * Owns first-use Project phases and local context chrome.
 * Delegates the live conversation surface to ConversationApp.
 */
export class ProjectShell {
  private root: HTMLElement;
  private projects: ProjectService;
  private createEngine: () => AgentEnginePort;
  private autoDemoPrompt: string | null;
  private fileWriteHost: FileWriteHost | null;

  private phase: ProjectPhase = "choose";
  private projectError: ProjectError | null = null;
  private pathDraft = DEMO_PROJECT_PATH;
  private selectedFilePath: string | null = null;
  private fileView: ReadFileResult | null = null;
  private fileViewError: string | null = null;

  private engine: AgentEnginePort | null = null;
  private conversation: ConversationApp | null = null;
  private shellEl!: HTMLElement;

  constructor(root: HTMLElement, options: ProjectShellOptions) {
    this.root = root;
    this.projects = options.projects;
    this.createEngine = options.createEngine;
    this.autoDemoPrompt = options.autoDemoPrompt ?? null;
    this.fileWriteHost = options.fileWriteHost ?? null;
  }

  async mount(): Promise<void> {
    this.root.innerHTML = `<div id="app-shell" class="app-shell" data-testid="app-shell"></div>`;
    this.shellEl = this.must("#app-shell");
    this.shellEl.addEventListener("click", (e) => void this.onClick(e));
    this.shellEl.addEventListener("keydown", (e) => void this.onKeydown(e));

    const recent = this.projects.currentRecent();
    if (recent) this.pathDraft = recent;

    this.renderPhase();
  }

  unmount(): void {
    this.teardownConversation();
  }

  private must(selector: string): HTMLElement {
    const el = this.root.querySelector(selector);
    if (!el) throw new Error(`Missing element ${selector}`);
    return el as HTMLElement;
  }

  private renderPhase(): void {
    if (this.phase === "choose") {
      this.renderChoose();
      return;
    }
    if (this.phase === "trust") {
      this.renderTrust();
      return;
    }
    void this.mountWorkspace();
  }

  private renderChoose(): void {
    this.teardownConversation();
    const recent = this.projects.listRecent();
    const err = this.projectError;

    this.shellEl.innerHTML = `
      <div class="first-use" data-testid="first-use-choose">
        <header class="first-use-header">
          <h1>Open a Project</h1>
          <p class="subtitle">Choose one local folder as the agent working scope for this window.</p>
        </header>

        ${err ? this.renderErrorCard(err) : ""}

        <section class="first-use-card">
          <label class="field-label" for="project-path">Project folder</label>
          <div class="path-row">
            <input
              id="project-path"
              class="path-input"
              type="text"
              spellcheck="false"
              data-testid="project-path"
              value="${escapeHtml(this.pathDraft)}"
              placeholder="/path/to/your/project"
            />
            <button type="button" class="btn primary" data-action="open-path" data-testid="open-project">
              Open
            </button>
          </div>
          <p class="hint">
            Web shell uses an in-memory demo host. Open
            <code>${escapeHtml(DEMO_PROJECT_PATH)}</code>
            for the sample tree, or wire a Node/Tauri host for real disks.
          </p>
        </section>

        <section class="first-use-card">
          <h2 class="card-title">Recent</h2>
          ${
            recent.length === 0
              ? `<p class="muted">No recent Projects yet.</p>`
              : `<ul class="recent-list" data-testid="recent-projects">
                  ${recent
                    .map(
                      (p) => `
                    <li>
                      <button type="button" class="recent-item" data-action="open-recent" data-path="${escapeHtml(p)}">
                        <strong>${escapeHtml(baseName(p))}</strong>
                        <span>${escapeHtml(p)}</span>
                      </button>
                    </li>`,
                    )
                    .join("")}
                </ul>`
          }
          <div class="row-actions">
            <button type="button" class="btn secondary" data-action="open-demo" data-testid="open-demo">
              Open demo project
            </button>
            <button
              type="button"
              class="btn ghost"
              data-action="reopen-current"
              data-testid="reopen-current"
              ${recent.length === 0 ? "disabled" : ""}
            >
              Reopen current Project
            </button>
          </div>
        </section>
      </div>
    `;
  }

  private renderTrust(): void {
    this.teardownConversation();
    const project = this.projects.getOpened();
    if (!project) {
      this.phase = "choose";
      this.renderChoose();
      return;
    }
    const summary = this.projects.trustSummary();

    this.shellEl.innerHTML = `
      <div class="first-use" data-testid="first-use-trust">
        <header class="first-use-header">
          <div class="wizard-steps" aria-label="First-use steps">
            <span>1 · Project</span>
            <span class="on">2 · Trust</span>
            <span>3 · Workspace</span>
          </div>
          <h1>${escapeHtml(summary.title)}</h1>
          <p class="subtitle">${escapeHtml(summary.intro)}</p>
          <p class="project-chip" data-testid="trust-project-path">
            Project: <strong>${escapeHtml(project.name)}</strong>
            <span class="muted">${escapeHtml(project.path)}</span>
          </p>
        </header>

        <section class="first-use-card trust-card">
          <ul class="trust-list" data-testid="trust-summary">
            ${summary.rules
              .map(
                (rule) => `
              <li data-trust-id="${escapeHtml(rule.id)}">
                <strong>${escapeHtml(rule.title)}</strong>
                <span>${escapeHtml(rule.detail)}</span>
              </li>`,
              )
              .join("")}
          </ul>
          <div class="row-actions">
            <button type="button" class="btn secondary" data-action="trust-back">Back</button>
            <button type="button" class="btn primary" data-action="trust-continue" data-testid="trust-continue">
              I understand — enter workspace
            </button>
          </div>
        </section>
      </div>
    `;
  }

  /** Build Files rail + host, then mount ConversationApp once. */
  private async mountWorkspace(): Promise<void> {
    const project = this.projects.getOpened();
    if (!project) {
      this.phase = "choose";
      this.renderChoose();
      return;
    }

    const previewOpen = Boolean(
      this.selectedFilePath || this.fileView || this.fileViewError,
    );

    this.shellEl.innerHTML = `
      <div class="workspace-layout${previewOpen ? " with-preview" : ""}" data-testid="project-workspace">
        <aside class="files-rail" data-testid="files-rail" aria-label="Project files">
          <div class="rail-header">
            <div>
              <div class="rail-title">Files</div>
              <div class="rail-sub" title="${escapeHtml(project.path)}">${escapeHtml(project.name)}</div>
            </div>
            <button type="button" class="btn ghost btn-tiny" data-action="change-project" title="Change Project">Change</button>
          </div>
          <div class="git-strip" data-testid="git-status">
            ${this.renderGitStrip(project.git)}
          </div>
          <div class="file-tree" data-testid="file-tree">
            ${this.renderTree(project.tree, project.path)}
          </div>
        </aside>

        <div class="conversation-host" id="conversation-host" data-testid="conversation-host"></div>

        ${previewOpen ? this.renderFilePreview() : ""}
      </div>
    `;

    const host = this.must("#conversation-host");
    this.engine = this.createEngine();
    this.conversation = new ConversationApp(host, this.engine, {
      projectPath: project.path,
      subtitle: project.path,
      autoDemoPrompt: this.autoDemoPrompt,
      fileWriteHost: this.fileWriteHost ?? undefined,
    });
    await this.conversation.mount();
  }

  /** Update Files rail + preview without destroying the conversation host. */
  private patchWorkspaceChrome(): void {
    const project = this.projects.getOpened();
    if (!project || this.phase !== "workspace") return;

    const layout = this.shellEl.querySelector(".workspace-layout");
    if (!(layout instanceof HTMLElement)) return;

    const tree = layout.querySelector('[data-testid="file-tree"]');
    if (tree) {
      tree.innerHTML = this.renderTree(project.tree, project.path);
    }
    const git = layout.querySelector('[data-testid="git-status"]');
    if (git) {
      git.innerHTML = this.renderGitStrip(project.git);
    }

    const previewOpen = Boolean(
      this.selectedFilePath || this.fileView || this.fileViewError,
    );
    layout.classList.toggle("with-preview", previewOpen);

    const preview = layout.querySelector('[data-testid="file-preview"]');
    if (previewOpen) {
      if (!preview) {
        layout.insertAdjacentHTML("beforeend", this.renderFilePreview());
      } else {
        preview.outerHTML = this.renderFilePreview();
      }
    } else if (preview) {
      preview.remove();
    }
  }

  private renderGitStrip(git: GitWorkingTree | null): string {
    if (!git) {
      return `<span class="git-none" data-testid="git-none">Not a Git repository — Project is still usable</span>`;
    }
    return `
      <span class="git-pill" data-testid="git-pill" title="${escapeHtml(
        git.entries
          .slice(0, 12)
          .map((e) => `${e.code} ${e.path}`)
          .join("\n"),
      )}">
        <span class="git-dot${git.dirty ? " dirty" : ""}"></span>
        ${escapeHtml(git.summary)}
      </span>
    `;
  }

  private renderTree(nodes: FileTreeNode[], projectRoot: string): string {
    if (nodes.length === 0) {
      return `<p class="muted small">No files to show</p>`;
    }
    return `<ul class="tree-list">${nodes
      .map((n) => this.renderTreeNode(n, projectRoot, 0))
      .join("")}</ul>`;
  }

  private renderTreeNode(
    node: FileTreeNode,
    projectRoot: string,
    depth: number,
  ): string {
    const rel = relativePath(projectRoot, node.path);
    const pad = `padding-left: ${0.4 + depth * 0.75}rem`;
    if (node.kind === "directory") {
      const kids = node.children ?? [];
      return `
        <li class="tree-dir" style="${pad}">
          <span class="tree-dir-label" title="${escapeHtml(node.path)}">📁 ${escapeHtml(node.name)}</span>
          ${
            kids.length
              ? `<ul class="tree-list">${kids
                  .map((c) => this.renderTreeNode(c, projectRoot, depth + 1))
                  .join("")}</ul>`
              : node.truncated
                ? `<div class="muted small" style="padding-left:0.75rem">…</div>`
                : ""
          }
        </li>`;
    }
    const selected = this.selectedFilePath === node.path ? " selected" : "";
    const disabled = node.truncated ? " disabled" : "";
    return `
      <li class="tree-file${selected}" style="${pad}">
        <button
          type="button"
          class="tree-file-btn"
          data-action="open-file"
          data-path="${escapeHtml(node.path)}"
          title="${escapeHtml(rel)}"
          data-testid="file-${escapeHtml(rel.replace(/[^\w.-]+/g, "-"))}"
          ${disabled}
        >📄 ${escapeHtml(node.name)}</button>
      </li>`;
  }

  private renderFilePreview(): string {
    const title = this.selectedFilePath
      ? baseName(this.selectedFilePath)
      : "File";
    const body = this.fileViewError
      ? `<p class="file-view-error">${escapeHtml(this.fileViewError)}</p>`
      : this.fileView
        ? `<pre class="file-view-body" data-testid="file-view">${escapeHtml(
            this.fileView.content,
          )}${
            this.fileView.truncated
              ? `\n\n… truncated (${this.fileView.sizeBytes} bytes total)`
              : ""
          }</pre>`
        : `<p class="muted">Loading…</p>`;

    return `
      <aside class="file-preview" data-testid="file-preview" aria-label="File preview">
        <div class="file-preview-header">
          <strong>${escapeHtml(title)}</strong>
          <button type="button" class="btn ghost btn-tiny" data-action="close-file">Close</button>
        </div>
        ${body}
      </aside>
    `;
  }

  private renderErrorCard(err: ProjectError): string {
    return `
      <section class="error-card" role="alert" data-testid="project-error">
        <strong>${escapeHtml(err.code)}</strong>
        <p>${escapeHtml(err.message)}</p>
        <div class="row-actions">
          ${err.recovery
            .map(
              (a) => `
            <button
              type="button"
              class="btn secondary"
              data-action="recovery"
              data-recovery-id="${escapeHtml(a.id)}"
              data-path="${escapeHtml(a.path ?? "")}"
              data-testid="recovery-${escapeHtml(a.id)}"
            >${escapeHtml(a.label)}</button>`,
            )
            .join("")}
        </div>
      </section>
    `;
  }

  private async onClick(e: Event): Promise<void> {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest("[data-action]") as HTMLElement | null;
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action) return;

    switch (action) {
      case "open-path": {
        const input = this.shellEl.querySelector(
          "#project-path",
        ) as HTMLInputElement | null;
        await this.openProject(input?.value?.trim() || this.pathDraft);
        break;
      }
      case "open-demo":
        await this.openProject(DEMO_PROJECT_PATH);
        break;
      case "open-recent":
        await this.openProject(btn.dataset.path ?? "");
        break;
      case "reopen-current":
        await this.reopenProject();
        break;
      case "trust-back":
        this.projects.close();
        this.phase = "choose";
        this.renderPhase();
        break;
      case "trust-continue":
        await this.enterWorkspace();
        break;
      case "change-project":
        await this.changeProject();
        break;
      case "open-file":
        await this.openFile(btn.dataset.path ?? "");
        break;
      case "close-file":
        this.selectedFilePath = null;
        this.fileView = null;
        this.fileViewError = null;
        this.patchWorkspaceChrome();
        break;
      case "recovery":
        await this.onRecovery({
          id: btn.dataset.recoveryId ?? "",
          label: btn.textContent ?? "",
          path: btn.dataset.path || undefined,
        });
        break;
      default:
        break;
    }
  }

  private async onKeydown(e: Event): Promise<void> {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && (ke.metaKey || ke.ctrlKey)) {
      const t = ke.target;
      if (t instanceof HTMLInputElement && t.id === "project-path") {
        ke.preventDefault();
        await this.openProject(t.value.trim());
      }
    }
  }

  private async openProject(path: string): Promise<void> {
    this.pathDraft = path;
    this.projectError = null;
    try {
      await this.projects.open(path);
      this.phase = "trust";
      this.renderPhase();
    } catch (err) {
      this.phase = "choose";
      this.projectError = isProjectError(err)
        ? err
        : {
            code: "path_unreadable",
            message: err instanceof Error ? err.message : String(err),
            recovery: [
              { id: "choose_other", label: "Choose another folder" },
              {
                id: "open_demo",
                label: "Open demo project",
                path: DEMO_PROJECT_PATH,
              },
            ],
          };
      this.renderPhase();
    }
  }

  private async reopenProject(): Promise<void> {
    this.projectError = null;
    try {
      await this.projects.reopenCurrent();
      this.phase = "trust";
      this.renderPhase();
    } catch (err) {
      this.phase = "choose";
      this.projectError = isProjectError(err)
        ? err
        : {
            code: "path_empty",
            message: err instanceof Error ? err.message : String(err),
            recovery: [
              { id: "choose_other", label: "Choose another folder" },
              {
                id: "open_demo",
                label: "Open demo project",
                path: DEMO_PROJECT_PATH,
              },
            ],
          };
      this.renderPhase();
    }
  }

  private async enterWorkspace(): Promise<void> {
    this.projects.acknowledgeTrust();
    this.phase = "workspace";
    this.selectedFilePath = null;
    this.fileView = null;
    this.fileViewError = null;
    this.teardownConversation();
    await this.mountWorkspace();
  }

  private async changeProject(): Promise<void> {
    this.selectedFilePath = null;
    this.fileView = null;
    this.fileViewError = null;
    this.projects.close();
    this.phase = "choose";
    this.teardownConversation();
    this.renderPhase();
  }

  private async openFile(path: string): Promise<void> {
    if (!path || path.endsWith("/…")) return;
    this.selectedFilePath = path;
    this.fileView = null;
    this.fileViewError = null;
    this.patchWorkspaceChrome();
    try {
      this.fileView = await this.projects.readFile(path);
      this.fileViewError = null;
    } catch (err) {
      this.fileView = null;
      this.fileViewError = isProjectError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    }
    this.patchWorkspaceChrome();
  }

  private async onRecovery(action: RecoveryAction): Promise<void> {
    if (action.id === "choose_other") {
      this.projectError = null;
      this.renderPhase();
      return;
    }
    if (action.path) {
      await this.openProject(action.path);
      return;
    }
    if (action.id === "retry" && this.pathDraft) {
      await this.openProject(this.pathDraft);
    }
  }

  private teardownConversation(): void {
    this.conversation?.unmount();
    this.conversation = null;
    if (this.engine) {
      void this.engine.dispose().catch(() => {
        /* ignore */
      });
      this.engine = null;
    }
  }
}
