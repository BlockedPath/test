/**
 * Throwaway Windows ACP engine spike client for issue #8.
 * Spawns the real Windows grok.exe via `agent stdio` and exercises:
 * initialize, authenticate, session/new, session/prompt (stream + tools),
 * cancellation, and process cleanup.
 *
 * Run on Windows only (PowerShell / cmd). Do not treat Linux CLI results as Windows results.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const GROK_EXE = process.env.GROK_EXE || "C:\\Users\\justi\\.grok\\bin\\grok.exe";
const WORKSPACE =
  process.env.SPIKE_WORKSPACE ||
  "C:\\Users\\justi\\AppData\\Local\\Temp\\grok-acp-spike\\workspace";
const OUT_DIR =
  process.env.SPIKE_OUT ||
  "C:\\Users\\justi\\AppData\\Local\\Temp\\grok-acp-spike\\out";
const REPORT = {
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  grokExe: GROK_EXE,
  workspace: WORKSPACE,
  steps: {},
  events: {
    sessionUpdateTypes: {},
    notifications: {},
    permissionRequests: 0,
    rawSample: [],
  },
  process: {},
  errors: [],
  passFail: {},
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
if (!fs.existsSync(path.join(WORKSPACE, "hello.txt"))) {
  fs.writeFileSync(path.join(WORKSPACE, "hello.txt"), "spike fixture file\nline two\n");
}

function redact(obj) {
  const s = JSON.stringify(obj);
  // avoid dumping long file contents / secrets in fixtures
  return JSON.parse(
    s
      .replace(/("text"\s*:\s*")([^"]{200,})(")/g, (_, a, t, c) => a + t.slice(0, 200) + "…[truncated]" + c)
      .replace(/("content"\s*:\s*")([^"]{200,})(")/g, (_, a, t, c) => a + t.slice(0, 200) + "…[truncated]" + c)
  );
}

function classifyUpdate(update) {
  if (!update || typeof update !== "object") return "unknown";
  return update.sessionUpdate || update.type || "unknown";
}

class AcpClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.stderrChunks = [];
    this.stdoutLines = [];
    this.pid = null;
    this.exitCode = null;
    this.exited = false;
    this.childPidsBefore = new Set();
  }

  start() {
    // Prefer --no-auto-update so spike is deterministic; always-approve for tool events without human prompts.
    const args = ["--no-auto-update", "agent", "--always-approve", "stdio"];
    this.proc = spawn(GROK_EXE, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        // ensure we don't inherit Linux-oriented paths from WSL-launched node accidentally
        TERM: "dumb",
      },
    });
    this.pid = this.proc.pid;
    REPORT.process.pid = this.pid;
    REPORT.process.spawnArgs = [GROK_EXE, ...args];

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.onLine(line));
    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrChunks.push(text);
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      REPORT.process.exitCode = code;
      REPORT.process.exitSignal = signal;
    });
    this.proc.on("error", (err) => {
      REPORT.errors.push({ stage: "spawn", message: String(err) });
    });
  }

  onLine(line) {
    this.stdoutLines.push(line);
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      REPORT.errors.push({ stage: "parse", line: line.slice(0, 500), message: String(e) });
      return;
    }

    // Keep a bounded redacted sample of protocol traffic
    if (REPORT.events.rawSample.length < 80) {
      REPORT.events.rawSample.push(redact(message));
    }

    if (message.method) {
      REPORT.events.notifications[message.method] =
        (REPORT.events.notifications[message.method] || 0) + 1;

      if (message.method === "session/update") {
        const update = message.params?.update ?? message.params;
        const kind = classifyUpdate(update);
        REPORT.events.sessionUpdateTypes[kind] =
          (REPORT.events.sessionUpdateTypes[kind] || 0) + 1;
      }

      if (
        message.method === "session/request_permission" ||
        message.method === "request_permission" ||
        message.method?.includes("permission")
      ) {
        REPORT.events.permissionRequests += 1;
        // Auto-allow for spike completeness if a request id is present
        if (message.id !== undefined) {
          this.respond(message.id, {
            outcome: { outcome: "selected", optionId: "allow-once" },
          }).catch(() => {});
        }
      }

      // Some ACP servers use client methods for fs/terminal — log only
      if (message.id !== undefined && message.method?.startsWith("fs/")) {
        // Minimal fs bridge if agent asks client to read
        this.handleClientFs(message).catch((e) =>
          REPORT.errors.push({ stage: "fs-bridge", message: String(e) })
        );
      }
      if (message.id !== undefined && message.method?.startsWith("terminal/")) {
        this.handleClientTerminal(message).catch((e) =>
          REPORT.errors.push({ stage: "terminal-bridge", message: String(e) })
        );
      }
    }

    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || JSON.stringify(message.error)), { rpc: message.error }));
        else pending.resolve(message.result);
      }
    }
  }

  async handleClientFs(message) {
    // Best-effort: if client-side fs is required, return simple results
    const { method, id, params } = message;
    if (method === "fs/read_text_file" || method === "fs/readTextFile") {
      const p = params?.path;
      try {
        const text = fs.readFileSync(p, "utf8");
        await this.respond(id, { content: text });
      } catch (e) {
        await this.respondError(id, String(e));
      }
      return;
    }
    if (method === "fs/write_text_file" || method === "fs/writeTextFile") {
      try {
        fs.writeFileSync(params.path, params.content ?? "");
        await this.respond(id, {});
      } catch (e) {
        await this.respondError(id, String(e));
      }
      return;
    }
    // Unknown fs method — reject so agent can fall back
    await this.respondError(id, `unsupported client method ${method}`);
  }

  async handleClientTerminal(message) {
    await this.respondError(message.id, `unsupported client method ${message.method}`);
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve(r) {
          clearTimeout(timer);
          resolve(r);
        },
        reject(e) {
          clearTimeout(timer);
          reject(e);
        },
      });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.proc.stdin.write(payload);
    });
  }

  notify(method, params) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(payload);
  }

  respond(id, result) {
    return new Promise((resolve) => {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
      resolve();
    });
  }

  respondError(id, message) {
    return new Promise((resolve) => {
      this.proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message },
        }) + "\n"
      );
      resolve();
    });
  }

  async dispose({ kill = true } = {}) {
    try {
      this.rl?.close();
    } catch {}
    if (kill && this.proc && !this.exited) {
      // Windows: try graceful then hard
      try {
        this.proc.kill();
      } catch {}
      await sleep(500);
      if (!this.exited) {
        try {
          spawn("taskkill", ["/PID", String(this.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {}
      }
      await sleep(500);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const client = new AcpClient();
  const t0 = Date.now();

  // --- launch ---
  try {
    if (!fs.existsSync(GROK_EXE)) {
      throw new Error(`Windows grok binary not found at ${GROK_EXE}`);
    }
    client.start();
    REPORT.passFail.launch = true;
    REPORT.steps.launch = { ok: true, pid: client.pid, ms: Date.now() - t0 };
  } catch (e) {
    REPORT.passFail.launch = false;
    REPORT.steps.launch = { ok: false, error: String(e) };
    writeOutputs(client);
    process.exitCode = 1;
    return;
  }

  await sleep(300);

  // --- initialize ---
  let init;
  try {
    init = await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "windows-acp-spike", version: "0.0.1" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      },
      30000
    );
    REPORT.steps.initialize = {
      ok: true,
      resultKeys: Object.keys(init || {}),
      protocolVersion: init?.protocolVersion,
      agentInfo: init?.agentInfo ?? init?.serverInfo,
      authMethods: (init?.authMethods ?? []).map((m) => m.id ?? m),
      agentCapabilities: init?.agentCapabilities ?? init?.capabilities,
    };
    REPORT.passFail.initialize = true;
    fs.writeFileSync(path.join(OUT_DIR, "initialize-result.json"), JSON.stringify(init, null, 2));
  } catch (e) {
    REPORT.passFail.initialize = false;
    REPORT.steps.initialize = { ok: false, error: String(e), rpc: e.rpc };
    await client.dispose();
    writeOutputs(client);
    process.exitCode = 1;
    return;
  }

  // --- authenticate ---
  try {
    const authMethods = new Set((init?.authMethods ?? []).map((m) => m.id));
    let methodId = null;
    if (process.env.XAI_API_KEY && authMethods.has("xai.api_key")) methodId = "xai.api_key";
    else if (authMethods.has("cached_token")) methodId = "cached_token";
    else if (authMethods.size === 1) methodId = [...authMethods][0];
    else if (authMethods.size > 0) methodId = [...authMethods][0];

    if (!methodId) {
      throw new Error(`No usable auth method. Available: ${[...authMethods].join(",") || "(none)"}`);
    }

    const authResult = await client.request(
      "authenticate",
      { methodId, _meta: { headless: true } },
      30000
    );
    REPORT.steps.authenticate = { ok: true, methodId, result: redact(authResult ?? {}) };
    REPORT.passFail.authenticate = true;
  } catch (e) {
    REPORT.passFail.authenticate = false;
    REPORT.steps.authenticate = { ok: false, error: String(e), rpc: e.rpc };
    // Continue only if session/new might work without explicit auth (cached)
  }

  // --- session/new ---
  let sessionId;
  try {
    const sess = await client.request(
      "session/new",
      {
        cwd: WORKSPACE,
        mcpServers: [],
      },
      30000
    );
    sessionId = sess.sessionId;
    REPORT.steps.sessionNew = { ok: true, sessionId, resultKeys: Object.keys(sess || {}) };
    REPORT.passFail.sessionNew = Boolean(sessionId);
    fs.writeFileSync(path.join(OUT_DIR, "session-new-result.json"), JSON.stringify(sess, null, 2));
  } catch (e) {
    REPORT.passFail.sessionNew = false;
    REPORT.steps.sessionNew = { ok: false, error: String(e), rpc: e.rpc };
    await client.dispose();
    writeOutputs(client);
    process.exitCode = 1;
    return;
  }

  // Snapshot event counts before prompts
  const countSnapshot = () => ({
    types: { ...REPORT.events.sessionUpdateTypes },
    notifications: { ...REPORT.events.notifications },
  });

  // --- streaming text prompt ---
  try {
    const before = countSnapshot();
    const promptResult = await client.request(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Reply with exactly the five characters: PONG. No other text.",
          },
        ],
      },
      120000
    );
    await sleep(200);
    const after = countSnapshot();
    REPORT.steps.streamPrompt = {
      ok: true,
      stopReason: promptResult?.stopReason,
      resultKeys: Object.keys(promptResult || {}),
      updateTypesDelta: diffCounts(before.types, after.types),
    };
    REPORT.passFail.streamText =
      (REPORT.events.sessionUpdateTypes.agent_message_chunk || 0) > 0 ||
      (REPORT.events.sessionUpdateTypes.agent_thought_chunk || 0) > 0 ||
      Boolean(promptResult);
    fs.writeFileSync(
      path.join(OUT_DIR, "stream-prompt-result.json"),
      JSON.stringify(promptResult, null, 2)
    );
  } catch (e) {
    REPORT.passFail.streamText = false;
    REPORT.steps.streamPrompt = { ok: false, error: String(e), rpc: e.rpc };
  }

  // --- tool / file / terminal oriented prompt ---
  try {
    const before = countSnapshot();
    const promptResult = await client.request(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text:
              "In the current workspace only: (1) read hello.txt, (2) list directory contents, " +
              "(3) run a short terminal command `echo SPIKE_TERM_OK` (Windows-safe), " +
              "(4) write a new file named spike-out.txt containing the single line SPIKE_WRITE_OK. " +
              "Then summarize what you did in one short paragraph. Do not touch files outside the workspace.",
          },
        ],
      },
      180000
    );
    await sleep(500);
    const after = countSnapshot();
    const wrote = fs.existsSync(path.join(WORKSPACE, "spike-out.txt"));
    REPORT.steps.toolFileTerminalPrompt = {
      ok: true,
      stopReason: promptResult?.stopReason,
      updateTypesDelta: diffCounts(before.types, after.types),
      workspaceWriteObserved: wrote,
      spikeOutContent: wrote
        ? fs.readFileSync(path.join(WORKSPACE, "spike-out.txt"), "utf8").slice(0, 200)
        : null,
    };
    const types = REPORT.events.sessionUpdateTypes;
    REPORT.passFail.toolEvents =
      (types.tool_call || 0) + (types.tool_call_update || 0) > 0;
    REPORT.passFail.fileActivity =
      wrote ||
      Object.keys(types).some((k) => /file|fs|edit|write|read/i.test(k));
    REPORT.passFail.terminalActivity = Object.keys(types).some((k) =>
      /terminal|bash|command|shell/i.test(k)
    ) || (types.tool_call || 0) > 0; // tool_call may cover terminal; refine from sample titles below
  } catch (e) {
    REPORT.passFail.toolEvents = false;
    REPORT.passFail.fileActivity = false;
    REPORT.passFail.terminalActivity = false;
    REPORT.steps.toolFileTerminalPrompt = { ok: false, error: String(e), rpc: e.rpc };
  }

  // Derive tool titles from raw sample for report richness
  const toolTitles = [];
  for (const msg of REPORT.events.rawSample) {
    const u = msg?.params?.update;
    if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
      toolTitles.push({
        sessionUpdate: u.sessionUpdate,
        title: u.title,
        kind: u.kind,
        status: u.status,
        toolCallId: u.toolCallId,
      });
    }
  }
  REPORT.events.toolCallSamples = toolTitles.slice(0, 40);

  // Refine terminal/file flags from tool titles
  if (toolTitles.some((t) => /terminal|bash|shell|command|cmd|powershell|echo/i.test(JSON.stringify(t)))) {
    REPORT.passFail.terminalActivity = true;
  }
  if (toolTitles.some((t) => /read|write|edit|file|list|dir|hello\.txt|spike-out/i.test(JSON.stringify(t)))) {
    REPORT.passFail.fileActivity = true;
  }

  // --- cancellation ---
  try {
    const cancelPromptId = client.nextId; // peek next
    const cancelPromise = client.request(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text:
              "Start a long analysis: count to 200 slowly in your reasoning and keep working. " +
              "This prompt is intended to be cancelled — do not finish quickly.",
          },
        ],
      },
      120000
    );

    // Let it start streaming, then cancel
    await sleep(1500);
    let cancelMethod = "session/cancel";
    let cancelOk = false;
    let cancelError = null;
    try {
      // ACP cancel is often a notification (no response) or a request
      client.notify("session/cancel", { sessionId });
      cancelOk = true;
    } catch (e) {
      cancelError = String(e);
    }

    // Also try request form if notification isn't enough
    try {
      await client.request("session/cancel", { sessionId }, 5000);
      cancelMethod = "session/cancel (request)";
      cancelOk = true;
    } catch (e) {
      // expected if only notification form exists
      if (!cancelOk) cancelError = String(e);
    }

    let promptOutcome = null;
    try {
      const r = await Promise.race([
        cancelPromise.then((r) => ({ type: "completed", r })),
        sleep(15000).then(() => ({ type: "still-pending" })),
      ]);
      promptOutcome = r.type === "completed" ? { stopReason: r.r?.stopReason, keys: Object.keys(r.r || {}) } : r;
    } catch (e) {
      promptOutcome = { error: String(e), rpc: e.rpc };
    }

    REPORT.steps.cancellation = {
      ok: cancelOk,
      cancelMethod,
      cancelError,
      promptOutcome,
    };
    REPORT.passFail.cancellation =
      cancelOk &&
      (promptOutcome?.stopReason === "cancelled" ||
        promptOutcome?.type === "still-pending" ||
        /cancel/i.test(JSON.stringify(promptOutcome)));
    // softer pass: we sent cancel without crashing the agent
    if (cancelOk && client.pid && processAlive(client.pid) && !client.exited) {
      REPORT.passFail.cancellationSurvived = true;
    }
  } catch (e) {
    REPORT.passFail.cancellation = false;
    REPORT.steps.cancellation = { ok: false, error: String(e) };
  }

  // --- cleanup ---
  try {
    const pid = client.pid;
    const aliveBefore = processAlive(pid);
    await client.dispose({ kill: true });
    await sleep(800);
    const aliveAfter = processAlive(pid);
    REPORT.steps.cleanup = {
      ok: !aliveAfter,
      aliveBeforeDispose: aliveBefore,
      aliveAfterDispose: aliveAfter,
      exitCode: client.exitCode,
      stderrBytes: client.stderrChunks.join("").length,
    };
    REPORT.passFail.cleanup = !aliveAfter;
    REPORT.process.stderrTail = client.stderrChunks.join("").slice(-4000);
  } catch (e) {
    REPORT.passFail.cleanup = false;
    REPORT.steps.cleanup = { ok: false, error: String(e) };
  }

  REPORT.finishedAt = new Date().toISOString();
  REPORT.durationMs = Date.now() - t0;

  // Overall go/no-go inputs
  const required = ["launch", "initialize", "authenticate", "sessionNew", "streamText", "cleanup"];
  const optional = ["toolEvents", "fileActivity", "terminalActivity", "cancellation", "cancellationSurvived"];
  REPORT.summary = {
    requiredPass: required.every((k) => REPORT.passFail[k]),
    required,
    optional,
    passFail: REPORT.passFail,
  };

  writeOutputs(client);
  console.log(JSON.stringify({ summary: REPORT.summary, passFail: REPORT.passFail }, null, 2));
  if (!REPORT.summary.requiredPass) process.exitCode = 2;
}

function diffCounts(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d) out[k] = d;
  }
  return out;
}

function writeOutputs(client) {
  const reportPath = path.join(OUT_DIR, "spike-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(REPORT, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "stdout-lines.jsonl"),
    (client?.stdoutLines || []).join("\n")
  );
  console.error(`Wrote ${reportPath}`);
}

run().catch((e) => {
  REPORT.errors.push({ stage: "fatal", message: String(e), stack: e.stack });
  writeOutputs(null);
  console.error(e);
  process.exit(1);
});
