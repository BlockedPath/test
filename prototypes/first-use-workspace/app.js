/**
 * PROTOTYPE — first-use coding workspace flow (issue #5)
 * Throwaway. Three structural variants via ?variant=A|B|C
 *
 * Question: What should first-use + primary coding workspace look like
 * for a user who dislikes a TUI?
 */

const VARIANTS = {
  A: { key: "A", name: "Workbench", blurb: "IDE: tree | editor/diff | chat | activity" },
  B: { key: "B", name: "Conversation-first", blurb: "Chat center; files & activity rails; inline diffs" },
  C: { key: "C", name: "Mission Control", blurb: "Cockpit split + open-project wizard" },
};

const DEMO_PROJECT = {
  name: "demo-api",
  path: "C:\\Users\\you\\code\\demo-api",
  files: [
    { id: "readme", name: "README.md", kind: "file", content: "# demo-api\n\nSample project for the workspace prototype.\n" },
    { id: "pkg", name: "package.json", kind: "file", content: '{\n  "name": "demo-api",\n  "scripts": {\n    "test": "node --test"\n  }\n}\n' },
    {
      id: "src",
      name: "src",
      kind: "dir",
      children: [
        {
          id: "server",
          name: "server.js",
          kind: "file",
          content:
            "const http = require('http');\n\nfunction createServer() {\n  return http.createServer((req, res) => {\n    res.end('ok');\n  });\n}\n\nmodule.exports = { createServer };\n",
        },
        {
          id: "routes",
          name: "routes.js",
          kind: "file",
          content: "function health() {\n  return { ok: true };\n}\n\nmodule.exports = { health };\n",
        },
      ],
    },
  ],
};

const SAMPLE_DIFF = [
  { t: "hunk", text: "--- a/src/server.js" },
  { t: "hunk", text: "+++ b/src/server.js" },
  { t: "ctx", text: " function createServer() {" },
  { t: "ctx", text: "   return http.createServer((req, res) => {" },
  { t: "del", text: "-    res.end('ok');" },
  { t: "add", text: "+    if (req.url === '/health') {" },
  { t: "add", text: "+      res.writeHead(200, { 'Content-Type': 'application/json' });" },
  { t: "add", text: "+      res.end(JSON.stringify({ ok: true }));" },
  { t: "add", text: "+      return;" },
  { t: "add", text: "+    }" },
  { t: "add", text: "+    res.writeHead(404);" },
  { t: "add", text: "+    res.end('not found');" },
  { t: "ctx", text: "   });" },
  { t: "ctx", text: " }" },
];

function nowStamp() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour12: false });
}

function flattenFiles(nodes, acc = []) {
  for (const n of nodes) {
    if (n.kind === "file") acc.push(n);
    if (n.children) flattenFiles(n.children, acc);
  }
  return acc;
}

function initialState() {
  return {
    project: null,
    sessionStatus: "idle", // idle | running | awaiting_approval | cancelled | error
    yolo: false,
    messages: [],
    activity: [],
    selectedFileId: "server",
    editorTab: "file", // file | diff
    pendingApproval: null, // { id, kind: 'edit'|'command', title, detail, path? }
    lastDiff: null,
    error: null,
    wizardStep: 1,
    draft: "",
    demoStep: 0,
    toast: null,
  };
}

let state = initialState();
let timers = [];

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function setState(patch) {
  state = { ...state, ...patch };
  render();
}

function pushActivity(entry) {
  state = {
    ...state,
    activity: [...state.activity, { id: crypto.randomUUID(), at: nowStamp(), ...entry }],
  };
}

function pushMessage(role, body) {
  state = {
    ...state,
    messages: [...state.messages, { id: crypto.randomUUID(), role, body, at: nowStamp() }],
  };
}

function getVariantKey() {
  const v = new URLSearchParams(location.search).get("variant") || "A";
  return VARIANTS[v] ? v : "A";
}

function setVariant(key) {
  const url = new URL(location.href);
  url.searchParams.set("variant", key);
  history.replaceState(null, "", url);
  render();
}

function cycleVariant(dir) {
  const keys = Object.keys(VARIANTS);
  const i = keys.indexOf(getVariantKey());
  const next = keys[(i + dir + keys.length) % keys.length];
  setVariant(next);
}

// —— Domain actions (stubbed session) ——

function openProject(project = DEMO_PROJECT) {
  clearTimers();
  state = {
    ...initialState(),
    project,
    selectedFileId: "server",
    messages: [
      {
        id: crypto.randomUUID(),
        role: "system",
        body: `Project opened: ${project.path}\nSafe reads are automatic. Edits need diff approval. Commands need approval unless YOLO is on.`,
        at: nowStamp(),
      },
    ],
    activity: [
      { id: crypto.randomUUID(), at: nowStamp(), kind: "ok", key: "session", text: "Session ready for demo-api" },
    ],
  };
  render();
}

function closeProject() {
  clearTimers();
  state = initialState();
  render();
}

function selectFile(id) {
  setState({ selectedFileId: id, editorTab: "file" });
}

function toggleYolo() {
  if (!state.project) return;
  if (!state.yolo) {
    const ok = confirm(
      "Enable YOLO mode for this session?\n\n" +
        "Per-action approvals for edits and commands will be skipped.\n" +
        "Activity, diffs, cancellation, and emergency stop remain available.\n\n" +
        "This is opt-in and visibly warned."
    );
    if (!ok) return;
    pushActivity({ kind: "warn", key: "yolo", text: "YOLO enabled — approvals auto-granted" });
    pushMessage("system", "YOLO mode ON for this session. Edits and commands will auto-apply. You can still Cancel / Stop.");
    setState({ yolo: true });
  } else {
    pushActivity({ kind: "ok", key: "yolo", text: "YOLO disabled — approvals restored" });
    pushMessage("system", "YOLO mode OFF. Approvals required again.");
    setState({ yolo: false });
  }
}

function cancelTurn() {
  if (!state.project) return;
  clearTimers();
  if (state.sessionStatus === "idle" && !state.pendingApproval) {
    pushActivity({ kind: "warn", key: "cancel", text: "Nothing running to cancel" });
    render();
    return;
  }
  pushActivity({ kind: "warn", key: "cancel", text: "User cancelled turn / emergency stop" });
  pushMessage("system", "Turn cancelled. Partial work left unapplied. Session recoverable.");
  setState({
    sessionStatus: "cancelled",
    pendingApproval: null,
    error: null,
  });
}

function resetSession() {
  if (!state.project) return;
  clearTimers();
  const project = state.project;
  openProject(project);
  pushMessage("system", "Session reset after recovery.");
  render();
}

function triggerError() {
  if (!state.project) return;
  clearTimers();
  pushActivity({ kind: "err", key: "engine", text: "ACP bridge lost connection to grok agent stdio" });
  pushMessage("system", "Engine error: child process exited unexpectedly (code 1).");
  setState({
    sessionStatus: "error",
    pendingApproval: null,
    error: {
      title: "Agent engine crashed",
      detail: "The ACP subprocess exited while streaming a tool event. Conversation history is kept in memory.",
    },
  });
}

function retryAfterError() {
  if (!state.error) return;
  pushActivity({ kind: "ok", key: "recover", text: "Restarted engine adapter; session resumed" });
  pushMessage("system", "Recovered. You can continue from the last prompt or start a new turn.");
  setState({ sessionStatus: "idle", error: null });
}

function cliFallback() {
  pushActivity({ kind: "ok", key: "cli", text: "Opened CLI fallback hint (stub)" });
  pushMessage(
    "system",
    "CLI fallback: run `grok` in this project folder when the GUI cannot cover a workflow.\n(Prototype only — no terminal launched.)"
  );
  render();
}

function respondApproval(decision) {
  const appr = state.pendingApproval;
  if (!appr) return;
  if (decision === "deny") {
    pushActivity({ kind: "warn", key: "approval", text: `Denied ${appr.kind}: ${appr.title}` });
    pushMessage("agent", `Understood — I will not apply that ${appr.kind}. What would you like instead?`);
    setState({ pendingApproval: null, sessionStatus: "idle" });
    return;
  }
  pushActivity({ kind: "ok", key: "approval", text: `Approved ${appr.kind}: ${appr.title}` });
  if (appr.kind === "edit") {
    state = {
      ...state,
      lastDiff: SAMPLE_DIFF,
      editorTab: "diff",
      selectedFileId: "server",
    };
    pushMessage("agent", "Applied the health-check route change. Diff is open for review.");
    // After edit, sometimes a command approval follows
    timers.push(
      setTimeout(() => {
        if (state.yolo) {
          pushActivity({ kind: "cmd", key: "cmd", text: "npm test (auto-approved via YOLO)" });
          pushActivity({ kind: "ok", key: "cmd", text: "tests passed (stub)" });
          pushMessage("agent", "Tests passed (stub). Ready for the next task.");
          setState({ pendingApproval: null, sessionStatus: "idle" });
        } else {
          setState({
            sessionStatus: "awaiting_approval",
            pendingApproval: {
              id: crypto.randomUUID(),
              kind: "command",
              title: "Run project tests",
              detail: "npm test\nWorking directory: project root\nNetwork: none requested",
            },
          });
        }
      }, 500)
    );
    setState({ pendingApproval: null, sessionStatus: "running" });
    return;
  }
  // command approved
  pushActivity({ kind: "cmd", key: "cmd", text: "npm test — running…" });
  timers.push(
    setTimeout(() => {
      pushActivity({ kind: "ok", key: "cmd", text: "npm test — exit 0 (stub output)" });
      pushMessage("agent", "Tests passed. Health route is covered. Anything else?");
      setState({ pendingApproval: null, sessionStatus: "idle" });
    }, 700)
  );
  setState({ pendingApproval: null, sessionStatus: "running" });
}

function sendPrompt(text) {
  const prompt = (text ?? state.draft).trim();
  if (!prompt || !state.project) return;
  if (state.sessionStatus === "running" || state.sessionStatus === "awaiting_approval") return;

  clearTimers();
  pushMessage("user", prompt);
  pushActivity({ kind: "tool", key: "prompt", text: "session/prompt accepted" });
  state = { ...state, draft: "", sessionStatus: "running", error: null, demoStep: state.demoStep + 1 };

  // Simulated agent turn
  timers.push(
    setTimeout(() => {
      pushActivity({ kind: "tool", key: "read", text: "read src/server.js" });
      pushActivity({ kind: "tool", key: "read", text: "read src/routes.js" });
      pushMessage(
        "agent",
        "I'll add a `/health` JSON endpoint in `src/server.js` and run tests.\nProposed edit is ready for approval."
      );
      render();
    }, 450)
  );

  timers.push(
    setTimeout(() => {
      if (state.yolo) {
        pushActivity({ kind: "warn", key: "yolo", text: "Auto-approved edit (YOLO)" });
        state = { ...state, lastDiff: SAMPLE_DIFF, editorTab: "diff", selectedFileId: "server" };
        pushMessage("agent", "Edit applied under YOLO. Running tests next…");
        pushActivity({ kind: "cmd", key: "cmd", text: "npm test (auto-approved via YOLO)" });
        timers.push(
          setTimeout(() => {
            pushActivity({ kind: "ok", key: "cmd", text: "npm test — exit 0" });
            pushMessage("agent", "Done under YOLO. Diff still visible for audit.");
            setState({ sessionStatus: "idle" });
          }, 600)
        );
        setState({ sessionStatus: "running" });
      } else {
        setState({
          sessionStatus: "awaiting_approval",
          pendingApproval: {
            id: crypto.randomUUID(),
            kind: "edit",
            title: "Apply edit to src/server.js",
            detail: "Add /health JSON response and 404 fallback. 8 lines changed.",
            path: "src/server.js",
          },
          lastDiff: SAMPLE_DIFF,
          editorTab: "diff",
        });
      }
    }, 900)
  );

  render();
}

function runDemoTurn() {
  setState({ draft: "Add a /health endpoint and run tests" });
  // ensure draft is in state then send
  state = { ...state, draft: "Add a /health endpoint and run tests" };
  sendPrompt(state.draft);
}

// —— Render helpers ——

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function findFile(id, nodes = state.project?.files || []) {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const f = findFile(id, n.children);
      if (f) return f;
    }
  }
  return null;
}

function renderTree(nodes, depth = 0) {
  return nodes
    .map((n) => {
      if (n.kind === "dir") {
        return `
          <div class="tree-item" style="opacity:0.85">
            <span class="indent" style="width:${depth * 0.9}rem"></span>
            <span class="icon">📁</span>
            <span>${escapeHtml(n.name)}</span>
          </div>
          ${renderTree(n.children || [], depth + 1)}
        `;
      }
      const active = state.selectedFileId === n.id ? "active" : "";
      return `
        <button class="tree-item ${active}" data-action="select-file" data-id="${n.id}">
          <span class="indent" style="width:${depth * 0.9}rem"></span>
          <span class="icon">📄</span>
          <span>${escapeHtml(n.name)}</span>
        </button>
      `;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusPill() {
  const map = {
    idle: ["idle", "Idle"],
    running: ["running", "Running"],
    awaiting_approval: ["running", "Awaiting approval"],
    cancelled: ["error", "Cancelled"],
    error: ["error", "Error"],
  };
  const [cls, label] = map[state.sessionStatus] || map.idle;
  return `<span class="pill ${cls}">${label}</span>`;
}

function yoloPill() {
  return state.yolo
    ? `<span class="pill yolo">YOLO on</span>`
    : `<span class="pill">YOLO off</span>`;
}

function renderDiff(diff = state.lastDiff) {
  if (!diff) {
    return `<div class="muted small">No pending or recent diff. Run a demo turn that proposes an edit.</div>`;
  }
  return `
    <div class="diff">
      ${diff
        .map((line) => `<div class="diff-line ${line.t}">${escapeHtml(line.text)}</div>`)
        .join("")}
    </div>
  `;
}

function renderFileView() {
  const f = findFile(state.selectedFileId);
  if (!f) return `<div class="muted">Select a file</div>`;
  return `<div class="codeview">${escapeHtml(f.content)}</div>`;
}

function renderActivity() {
  if (!state.activity.length) {
    return `<div class="muted small">Activity will stream here (tool events, commands, approvals, errors).</div>`;
  }
  return `
    <div class="activity">
      ${state.activity
        .slice()
        .reverse()
        .map(
          (a) => `
        <div class="act ${a.kind}">
          <div class="t">${escapeHtml(a.at)}</div>
          <div><span class="k">${escapeHtml(a.key)}</span> — ${escapeHtml(a.text)}</div>
          <div></div>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function renderMessages() {
  if (!state.messages.length) {
    return `<div class="muted small">Conversation appears here once a project is open.</div>`;
  }
  return `
    <div class="chat">
      ${state.messages
        .map(
          (m) => `
        <div class="msg ${m.role}">
          <div class="who">${m.role} · ${escapeHtml(m.at)}</div>
          <div class="body">${escapeHtml(m.body)}</div>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function renderApproval(variantStyle) {
  const a = state.pendingApproval;
  if (!a) return "";
  const cls = variantStyle === "modal" ? "approval modal" : variantStyle === "sheet" ? "approval sheet" : "approval inline";
  const scrim = variantStyle === "modal" ? `<div class="modal-scrim" data-action="noop"></div>` : "";
  return `
    ${scrim}
    <div class="${cls}">
      <h3>Approval required · ${escapeHtml(a.kind)}</h3>
      <p><strong>${escapeHtml(a.title)}</strong><br/>${escapeHtml(a.detail)}${
        a.path ? `<br/><span class="mono">${escapeHtml(a.path)}</span>` : ""
      }</p>
      <div class="row">
        <button class="primary" data-action="approve">Approve</button>
        <button class="danger" data-action="deny">Deny</button>
        <button class="ghost" data-action="cancel">Cancel turn</button>
      </div>
    </div>
  `;
}

function renderRecovery() {
  if (!state.error) return "";
  return `
    <div class="recovery">
      <div>
        <strong>${escapeHtml(state.error.title)}</strong>
        <div class="small">${escapeHtml(state.error.detail)}</div>
      </div>
      <div class="row">
        <button class="primary" data-action="retry">Retry engine</button>
        <button data-action="reset">Reset session</button>
        <button data-action="cli-fallback">CLI fallback</button>
      </div>
    </div>
  `;
}

function renderComposer(extraHint = "") {
  const busy = state.sessionStatus === "running" || state.sessionStatus === "awaiting_approval";
  return `
    <div class="composer">
      ${renderRecovery()}
      <textarea
        data-field="draft"
        placeholder="Ask the coding agent… e.g. Add a /health endpoint"
        ${busy || state.sessionStatus === "error" ? "disabled" : ""}
      >${escapeHtml(state.draft)}</textarea>
      <div class="composer-actions">
        <button class="primary" data-action="send" ${busy || !state.project || state.sessionStatus === "error" ? "disabled" : ""}>Send</button>
        <button data-action="demo" ${busy || !state.project || state.sessionStatus === "error" ? "disabled" : ""}>Run demo turn</button>
        <button class="danger" data-action="cancel" ${!state.project ? "disabled" : ""}>Cancel / Stop</button>
        <button class="${state.yolo ? "yolo-on" : ""}" data-action="yolo" ${!state.project ? "disabled" : ""}>
          ${state.yolo ? "YOLO: ON" : "YOLO: off"}
        </button>
        <button data-action="force-error" ${!state.project ? "disabled" : ""}>Simulate error</button>
        <span class="spacer"></span>
        <span class="muted small">${escapeHtml(extraHint)}</span>
      </div>
    </div>
  `;
}

function renderTopbar() {
  if (!state.project) {
    return `
      <div class="topbar">
        <div class="title">Grok Coding Workspace</div>
        <span class="muted small">No project open</span>
        <div class="spacer"></div>
        ${statusPill()} ${yoloPill()}
      </div>
    `;
  }
  return `
    <div class="topbar">
      <div class="title">${escapeHtml(state.project.name)}</div>
      <div class="path">${escapeHtml(state.project.path)}</div>
      <div class="spacer"></div>
      ${statusPill()}
      ${yoloPill()}
      <button data-action="close-project">Close project</button>
    </div>
  `;
}

function renderBanner() {
  return `
    <div class="banner">
      <div>
        <strong>PROTOTYPE</strong> · issue #5 · throwaway UI for first-use coding workspace.
        Not wired to a real agent.
      </div>
      <div class="muted">State dumps bottom-right · switch variants below</div>
    </div>
  `;
}

function renderEmptyA() {
  return `
    <div class="empty-state">
      <div class="empty-card">
        <h1>Open a project to start</h1>
        <p>Workbench layout: files on the left, editor and diffs in the center, conversation on the right, activity along the bottom — familiar if you already live in an IDE.</p>
        <div class="recent-list">
          <button class="recent-item" data-action="open-demo">
            <strong>demo-api</strong>
            <span>C:\\Users\\you\\code\\demo-api</span>
          </button>
          <button class="recent-item" data-action="open-demo">
            <strong>notes-app</strong>
            <span>C:\\Users\\you\\code\\notes-app</span>
          </button>
        </div>
        <div class="row">
          <button class="primary" data-action="open-demo">Browse folder… (stub → demo-api)</button>
        </div>
      </div>
    </div>
  `;
}

function renderEmptyB() {
  return `
    <div class="empty-state">
      <div class="empty-card" style="text-align:center">
        <h1>What should we work on?</h1>
        <p>Conversation-first: open a project, then talk. Files and activity stay secondary until you need them.</p>
        <div class="stack" style="text-align:left; margin:1rem 0">
          <button class="primary" style="padding:0.85rem" data-action="open-demo">Open project folder…</button>
          <button data-action="open-demo">Continue recent: demo-api</button>
        </div>
        <p class="muted small">After open, the chat becomes the main surface. Diffs arrive as cards in the stream.</p>
      </div>
    </div>
  `;
}

function renderEmptyC() {
  return `
    <div class="empty-state" style="position:relative">
      <div class="muted">Mission Control idle — launch open-project wizard</div>
      <div class="wizard-backdrop">
        <div class="wizard">
          <div class="wizard-h">
            <h2>Start a coding session</h2>
            <div class="muted small">Guided first-use: pick a project, confirm trust, then enter the cockpit.</div>
          </div>
          <div class="wizard-b">
            <div class="wizard-steps">
              <span class="${state.wizardStep === 1 ? "on" : ""}">1 · Project</span>
              <span class="${state.wizardStep === 2 ? "on" : ""}">2 · Trust</span>
              <span class="${state.wizardStep === 3 ? "on" : ""}">3 · Ready</span>
            </div>
            ${
              state.wizardStep === 1
                ? `
              <p class="muted">Choose a local folder (one active project per window).</p>
              <div class="recent-list">
                <button class="recent-item" data-action="wizard-next">
                  <strong>demo-api</strong>
                  <span>C:\\Users\\you\\code\\demo-api</span>
                </button>
              </div>
              <button class="primary" data-action="wizard-next">Browse… (stub)</button>
            `
                : state.wizardStep === 2
                  ? `
              <p>Trust level for <strong>demo-api</strong></p>
              <ul class="muted small" style="line-height:1.5">
                <li>Safe reads: automatic</li>
                <li>Edits: show diff + approve (unless YOLO)</li>
                <li>Commands: approve with project trust</li>
                <li>Destructive / outside project: always explicit</li>
              </ul>
              <div class="row" style="margin-top:0.75rem">
                <button data-action="wizard-back">Back</button>
                <button class="primary" data-action="wizard-next">I understand — continue</button>
              </div>
            `
                  : `
              <p>Session controls on the left. Files, diffs, and terminal-style activity on the right.</p>
              <div class="row" style="margin-top:0.75rem">
                <button data-action="wizard-back">Back</button>
                <button class="primary" data-action="open-demo">Enter workspace</button>
              </div>
            `
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

// —— Variants ——

function renderVariantA() {
  if (!state.project) {
    return `${renderBanner()}${renderTopbar()}${renderEmptyA()}`;
  }
  return `
    ${renderBanner()}
    ${renderTopbar()}
    <div class="layout-a">
      <div class="panel files">
        <div class="panel-h"><span>Files</span></div>
        <div class="panel-b tree">${renderTree(state.project.files)}</div>
      </div>
      <div class="panel editor">
        <div class="editor-tabs">
          <button class="${state.editorTab === "file" ? "active" : ""}" data-action="tab-file">File</button>
          <button class="${state.editorTab === "diff" ? "active" : ""}" data-action="tab-diff">Diff</button>
        </div>
        <div class="panel-b">
          ${state.editorTab === "diff" ? renderDiff() : renderFileView()}
        </div>
      </div>
      <div class="panel chat" style="display:flex;flex-direction:column;padding:0">
        <div class="panel-h"><span>Conversation</span></div>
        <div class="panel-b" style="flex:1">${renderMessages()}</div>
        ${renderComposer("IDE density")}
      </div>
      <div class="panel activity">
        <div class="panel-h"><span>Activity / terminal</span><span class="muted small">tools · cmds · approvals</span></div>
        <div class="panel-b">${renderActivity()}</div>
      </div>
    </div>
    ${renderApproval("modal")}
  `;
}

function renderInlineDiffCard() {
  if (!state.lastDiff) return "";
  return `
    <div class="msg system">
      <div class="who">diff · src/server.js</div>
      ${renderDiff()}
      ${
        state.pendingApproval?.kind === "edit"
          ? `<div class="approval inline" style="margin-top:0.6rem">
              <h3>Apply this edit?</h3>
              <p>${escapeHtml(state.pendingApproval.detail)}</p>
              <div class="row">
                <button class="primary" data-action="approve">Approve edit</button>
                <button class="danger" data-action="deny">Deny</button>
              </div>
            </div>`
          : ""
      }
    </div>
  `;
}

function renderVariantB() {
  if (!state.project) {
    return `${renderBanner()}${renderTopbar()}${renderEmptyB()}`;
  }
  const cmdApproval =
    state.pendingApproval?.kind === "command"
      ? `
      <div class="msg system">
        <div class="who">approval · command</div>
        <div class="approval inline">
          <h3>${escapeHtml(state.pendingApproval.title)}</h3>
          <p class="mono">${escapeHtml(state.pendingApproval.detail)}</p>
          <div class="row">
            <button class="primary" data-action="approve">Approve command</button>
            <button class="danger" data-action="deny">Deny</button>
          </div>
        </div>
      </div>`
      : "";

  return `
    ${renderBanner()}
    ${renderTopbar()}
    <div class="layout-b">
      <div class="panel side-files">
        <div class="panel-h"><span>Project</span><button class="ghost small" data-action="close-project">Close</button></div>
        <div class="panel-b tree">${renderTree(state.project.files)}</div>
      </div>
      <div class="panel main-chat" style="display:flex;flex-direction:column;padding:0">
        <div class="panel-h">
          <span>Conversation</span>
          <span class="row">${statusPill()} ${yoloPill()}</span>
        </div>
        <div class="panel-b" style="flex:1">
          ${renderMessages()}
          ${state.lastDiff ? renderInlineDiffCard() : ""}
          ${cmdApproval}
        </div>
        ${renderComposer("Chat is primary; diffs travel in-stream")}
      </div>
      <div class="panel side-activity">
        <div class="panel-h"><span>Activity</span></div>
        <div class="panel-b">${renderActivity()}</div>
      </div>
    </div>
  `;
}

function renderVariantC() {
  if (!state.project) {
    return `${renderBanner()}${renderTopbar()}${renderEmptyC()}`;
  }
  return `
    ${renderBanner()}
    ${renderTopbar()}
    <div class="layout-c">
      <div class="left-col">
        <div class="session-controls stack">
          <div class="row">
            <strong>Session</strong>
            ${statusPill()}
            ${yoloPill()}
          </div>
          <div class="row">
            <button class="${state.yolo ? "yolo-on" : ""}" data-action="yolo">${state.yolo ? "Disable YOLO" : "Enable YOLO"}</button>
            <button class="danger" data-action="cancel">Emergency stop</button>
            <button data-action="force-error">Break engine</button>
          </div>
          <div class="muted small">Approvals freeze the agent until you answer (bottom sheet). YOLO still shows diffs and keeps stop.</div>
        </div>
        <div class="panel" style="flex:1;display:flex;flex-direction:column;padding:0;min-height:0">
          <div class="panel-h"><span>Conversation</span></div>
          <div class="panel-b" style="flex:1">${renderMessages()}</div>
          ${renderComposer("Cockpit controls above")}
        </div>
      </div>
      <div class="right-col">
        <div class="panel tabs-body" style="padding:0;display:flex;flex-direction:column">
          <div class="editor-tabs">
            <button class="${state.editorTab === "file" ? "active" : ""}" data-action="tab-file">Files</button>
            <button class="${state.editorTab === "diff" ? "active" : ""}" data-action="tab-diff">Diff</button>
            <button class="${state.editorTab === "term" ? "active" : ""}" data-action="tab-term">Terminal / activity</button>
          </div>
          <div class="panel-b" style="flex:1">
            ${
              state.editorTab === "diff"
                ? renderDiff()
                : state.editorTab === "term"
                  ? renderActivity()
                  : `<div class="stack">
                      <div class="tree">${renderTree(state.project.files)}</div>
                      <div class="sep"></div>
                      ${renderFileView()}
                    </div>`
            }
          </div>
        </div>
      </div>
      ${renderApproval("sheet")}
    </div>
  `;
}

function renderStateDump() {
  const dump = {
    variant: getVariantKey(),
    project: state.project?.name || null,
    sessionStatus: state.sessionStatus,
    yolo: state.yolo,
    pendingApproval: state.pendingApproval
      ? { kind: state.pendingApproval.kind, title: state.pendingApproval.title }
      : null,
    messages: state.messages.length,
    activity: state.activity.length,
    editorTab: state.editorTab,
    selectedFileId: state.selectedFileId,
    hasDiff: !!state.lastDiff,
    error: state.error?.title || null,
  };
  return `<div class="state-dump" aria-hidden="true">${escapeHtml(JSON.stringify(dump, null, 2))}</div>`;
}

function renderSwitcher() {
  const v = VARIANTS[getVariantKey()];
  document.getElementById("switcher").innerHTML = `
    <button type="button" data-switch="-1" aria-label="Previous variant">←</button>
    <div class="label">${v.key} — ${v.name}<div class="hint">${v.blurb}</div></div>
    <button type="button" data-switch="1" aria-label="Next variant">→</button>
  `;
}

function render() {
  const root = document.getElementById("app");
  const key = getVariantKey();
  let body = "";
  if (key === "A") body = renderVariantA();
  else if (key === "B") body = renderVariantB();
  else body = renderVariantC();
  root.innerHTML = `<div class="shell">${body}${renderStateDump()}</div>`;
  renderSwitcher();
}

// —— Events ——

document.addEventListener("click", (e) => {
  const switchBtn = e.target.closest("[data-switch]");
  if (switchBtn) {
    cycleVariant(Number(switchBtn.getAttribute("data-switch")));
    return;
  }

  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");

  switch (action) {
    case "open-demo":
      openProject();
      break;
    case "close-project":
      closeProject();
      break;
    case "select-file":
      selectFile(btn.getAttribute("data-id"));
      break;
    case "send":
      sendPrompt();
      break;
    case "demo":
      runDemoTurn();
      break;
    case "cancel":
      cancelTurn();
      break;
    case "yolo":
      toggleYolo();
      break;
    case "approve":
      respondApproval("approve");
      break;
    case "deny":
      respondApproval("deny");
      break;
    case "force-error":
      triggerError();
      break;
    case "retry":
      retryAfterError();
      break;
    case "reset":
      resetSession();
      break;
    case "cli-fallback":
      cliFallback();
      break;
    case "tab-file":
      setState({ editorTab: "file" });
      break;
    case "tab-diff":
      setState({ editorTab: "diff" });
      break;
    case "tab-term":
      setState({ editorTab: "term" });
      break;
    case "wizard-next":
      setState({ wizardStep: Math.min(3, state.wizardStep + 1) });
      break;
    case "wizard-back":
      setState({ wizardStep: Math.max(1, state.wizardStep - 1) });
      break;
    case "noop":
      break;
    default:
      break;
  }
});

document.addEventListener("input", (e) => {
  if (e.target.matches("[data-field=draft]")) {
    state = { ...state, draft: e.target.value };
  }
});

document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target.isContentEditable) {
    if (e.key === "Enter" && !e.shiftKey && tag === "textarea" && e.target.matches("[data-field=draft]")) {
      e.preventDefault();
      sendPrompt();
    }
    return;
  }
  if (e.key === "ArrowLeft") cycleVariant(-1);
  if (e.key === "ArrowRight") cycleVariant(1);
});

// boot
render();
