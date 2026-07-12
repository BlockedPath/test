/**
 * Live smoke: discovery-shaped path, Authenticode, version, ACP initialize/auth/session.
 * Requires Windows grok.exe reachable from this host (WSL interop OK).
 */
import { existsSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNodeIdentityHost, nodeSpawnEngine } from "../src/engine/node-host.ts";
import { discoverEngine } from "../src/engine/discovery.ts";
import { verifyEngineIdentity, windowsAuthenticodeScript } from "../src/engine/identity.ts";
import { planEngineSpawn, assertDirectSpawn } from "../src/engine/spawn-plan.ts";
import { GrokAcpEngine } from "../src/engine/acp-engine.ts";

const execFileAsync = promisify(execFile);

const WIN_PATH = process.env.GROK_EXE || "C:\\Users\\justi\\.grok\\bin\\grok.exe";
const WSL_PATH =
  process.env.GROK_EXE_WSL ||
  WIN_PATH.replace(/^C:\\/i, "/mnt/c/").replace(/\\/g, "/");
const ENGINE_COMMAND = process.platform === "win32" ? WIN_PATH : WSL_PATH;
const PROJECT =
  process.env.SMOKE_PROJECT ||
  "C:\\Users\\justi\\AppData\\Local\\Temp\\grok-gui-ticket-11-smoke";
const PROJECT_PATH = process.platform === "win32" ? PROJECT : toWsl(PROJECT);

function toWsl(p) {
  if (p.startsWith("/")) return p;
  return p.replace(/^C:\\/i, "/mnt/c/").replace(/\\/g, "/");
}

const report = { steps: {}, ok: true };

function fail(step, err) {
  report.ok = false;
  report.steps[step] = { ok: false, error: String(err) };
  console.error(`FAIL ${step}:`, err);
}

// --- discovery (Windows layout via mapped paths) ---
try {
  const discoveryHost = {
    platform: "win32",
    env: {
      USERPROFILE: "C:\\Users\\justi",
      GROK_EXE: WIN_PATH,
    },
    fileExists: (p) => existsSync(toWsl(p)),
    joinPath: (...parts) => parts.join("\\"),
  };
  const d = await discoverEngine(discoveryHost);
  report.steps.discovery = d;
  if (d.status !== "found") throw new Error("engine not found");
  console.log("discovery: found", d.candidate.path);
} catch (e) {
  fail("discovery", e);
}

// --- version + Authenticode ---
try {
  const identity = {
    platform: "win32",
    readVersion: async () => {
      const { stdout, stderr } = await execFileAsync(ENGINE_COMMAND, ["--version"], {
        timeout: 15_000,
      });
      return `${stdout}\n${stderr}`;
    },
    readSignature: async () => {
      const script = windowsAuthenticodeScript(WIN_PATH);
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 30_000 },
      );
      const parsed = JSON.parse(stdout);
      const status = String(parsed.Status ?? "");
      const valid = status === "Valid";
      report.steps.authenticodeRaw = parsed;
      return {
        valid,
        publisher: parsed.Publisher ?? undefined,
        thumbprint: parsed.Thumbprint ?? undefined,
        detail: valid ? undefined : `Authenticode status: ${status}`,
      };
    },
  };
  const id = await verifyEngineIdentity(WIN_PATH, identity);
  report.steps.identity = id;
  if (!id.ok) throw new Error(id.message);
  console.log("identity: ok", id.version.version, id.signature.publisher?.slice(0, 80));
} catch (e) {
  fail("identity", e);
}

// --- spawn plan ---
try {
  const plan = planEngineSpawn({ enginePath: WIN_PATH });
  assertDirectSpawn(plan);
  report.steps.spawnPlan = plan;
  console.log("spawn plan:", plan.command, plan.args.join(" "), "shell=", plan.shell);
} catch (e) {
  fail("spawnPlan", e);
}

// --- live ACP (may fail without network/auth cache) ---
try {
  mkdirSync(PROJECT_PATH, { recursive: true });
  const identity = createNodeIdentityHost({ allowUnsignedNonWindows: true });
  // Prefer skipping double-check complexity: use our verified path
  const engine = new GrokAcpEngine({
    discovery: {
      platform: "win32",
      env: process.env,
      fileExists: () => true,
      joinPath: (...p) => p.join("\\"),
    },
    identity,
    enginePath: WSL_PATH,
    skipIdentity: true, // proven above; PE path for spawn differs
    spawn: (plan) =>
      nodeSpawnEngine({
        ...plan,
        command: ENGINE_COMMAND,
        env: { ...process.env, TERM: "dumb" },
      }),
    requestTimeoutMs: 60_000,
  });

  const events = [];
  engine.subscribe((e) => {
    if (e.type === "engine.error" || e.type === "engine.stderr") {
      events.push(e);
    } else {
      events.push({ type: e.type });
    }
  });

  await engine.start({ projectPath: PROJECT });
  report.steps.initialize = {
    ok: true,
    engineVersion: engine.getSnapshot()?.engineVersion,
    protocolVersion: engine.getSnapshot()?.protocolVersion,
  };
  console.log("initialize:", report.steps.initialize);

  await engine.authenticate();
  report.steps.authenticate = { ok: true };
  console.log("authenticate: ok");

  const sessionId = await engine.createSession({ cwd: PROJECT });
  report.steps.session = {
    ok: true,
    sessionId,
    engineVersion: engine.getSnapshot()?.engineVersion,
    protocolVersion: engine.getSnapshot()?.protocolVersion,
    state: engine.getSnapshot()?.state,
  };
  console.log("session:", report.steps.session);

  await engine.dispose();
  report.steps.eventsSample = events.slice(0, 20);
  console.log("SMOKE_OK");
} catch (e) {
  fail("acpLive", e);
  console.error(e);
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 2;
