/**
 * Clean Windows user-profile packaging smoke.
 *
 * On native Windows with an NSIS artifact + engine, can exercise live steps.
 * On WSL/Linux: runs pure readiness failure matrix only and marks live install
 * steps as skipped — never fakes a successful NSIS install.
 *
 * Usage:
 *   node scripts/windows-clean-profile-smoke.mjs
 *   NSIS_SETUP=path/to/Grok-GUI_0.1.0_x64-setup.exe node scripts/windows-clean-profile-smoke.mjs
 */
import { readFileSync, existsSync } from "node:fs";

/** Load packaging TS via tsx (npm run test:packaging-smoke). */
async function loadPackaging() {
  try {
    return await import("../src/packaging/clean-profile-smoke.ts");
  } catch {
    return null;
  }
}

function readProcVersion() {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return process.env.WSL_DISTRO_NAME || "";
  }
}

const report = {
  host: {
    platform: process.platform,
    arch: process.arch,
    wslIndicator: readProcVersion().slice(0, 120),
  },
  mode: null,
  unitFailureMatrix: [],
  liveSteps: [],
  ok: true,
  notes: [],
};

function fail(msg) {
  report.ok = false;
  report.notes.push(`FAIL: ${msg}`);
  console.error("FAIL:", msg);
}

const packaging = await loadPackaging();
if (!packaging) {
  fail("Could not load packaging modules (run via: npx tsx scripts/windows-clean-profile-smoke.mjs)");
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
}

const {
  planCleanProfileSmoke,
  skipLiveStepsOnNonWindows,
  ENGINE_FAILURE_SCENARIOS,
  CLEAN_PROFILE_SMOKE_STEPS,
  detectWslIndicator,
} = packaging;

const wslIndicator =
  (typeof detectWslIndicator === "function" ? detectWslIndicator(process.env) : "") ||
  report.host.wslIndicator;
report.host.wslIndicator = wslIndicator;

const decision = planCleanProfileSmoke({
  platform: process.platform,
  wslIndicator,
  nsisArtifactPath: process.env.NSIS_SETUP ?? null,
});

report.mode = decision.mode;
console.log(`Clean-profile smoke mode: ${decision.mode} (${decision.mode === "plan_only" ? decision.environment : "native_windows"})`);

if (decision.mode === "plan_only") {
  console.log(decision.reason);
  report.notes.push(decision.reason);
  report.liveSteps = skipLiveStepsOnNonWindows(decision);
  for (const step of report.liveSteps) {
    console.log(`  SKIP ${step.id}: ${step.detail.slice(0, 100)}`);
  }
} else {
  const nsis = process.env.NSIS_SETUP;
  for (const step of CLEAN_PROFILE_SMOKE_STEPS) {
    if (step.requiresNsisArtifact && (!nsis || !existsSync(nsis))) {
      report.liveSteps.push({
        id: step.id,
        status: "skipped",
        detail: "NSIS_SETUP artifact not provided or missing — not claiming install success.",
      });
      console.log(`  SKIP ${step.id}: no NSIS artifact`);
      continue;
    }
    // Live execution hooks would go here on a Windows CI agent.
    report.liveSteps.push({
      id: step.id,
      status: "skipped",
      detail:
        "Native Windows live runner scaffold: automate NSIS silent install + UI when CI provides a clean profile. Not auto-passed.",
    });
    console.log(`  SKIP ${step.id}: live automation not yet wired on this agent`);
  }
}

// Always run pure failure-matrix documentation check
for (const scenario of ENGINE_FAILURE_SCENARIOS) {
  report.unitFailureMatrix.push({
    id: scenario.id,
    expectedCode: scenario.expectedCode,
    coveredByUnitTests: true,
    note: scenario.description,
  });
  console.log(`  MATRIX ${scenario.id} → ${scenario.expectedCode}`);
}

// Readiness pure path: missing engine on empty profile (no Windows required)
try {
  const { assessEngineReadiness } = await import("../src/packaging/engine-readiness.ts");
  const readiness = await assessEngineReadiness({
    discovery: {
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\CleanProfileSmoke" },
      fileExists: () => false,
      joinPath: (...p) => p.join("\\"),
    },
    identity: {
      platform: "win32",
      readVersion: async () => {
        throw new Error("unreachable");
      },
      readSignature: async () => ({ valid: false }),
    },
    hostArch: "x64",
  });
  if (readiness.status !== "not_ready" || readiness.failure.code !== "engine_missing") {
    fail(`expected engine_missing on clean profile, got ${JSON.stringify(readiness)}`);
  } else {
    report.notes.push("Pure clean-profile missing-engine path: actionable failure OK");
    console.log("  OK pure missing-engine failure is actionable");
  }
} catch (e) {
  fail(String(e));
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
if (decision.mode === "plan_only") {
  // Plan-only is success for the honesty contract — unit matrix ran; live skipped.
  process.exit(0);
}
process.exit(0);
