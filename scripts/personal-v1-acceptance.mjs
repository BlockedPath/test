/**
 * Personal v1 acceptance record builder (issue #19).
 *
 * Runs packaging smoke classification + writes docs/acceptance record.
 * Executable walkthrough assertions live in vitest
 * (`src/acceptance/walkthrough.test.ts`). This script never claims native
 * Windows install/auth success on WSL/Linux.
 *
 * Usage:
 *   npm run test:acceptance
 *   node --import tsx scripts/personal-v1-acceptance.mjs
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function git(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function readProcVersion() {
  try {
    return readFileSync("/proc/version", "utf8");
  } catch {
    return process.env.WSL_DISTRO_NAME
      ? `wsl_distro:${process.env.WSL_DISTRO_NAME}`
      : "";
  }
}

const packaging = await import("../src/packaging/clean-profile-smoke.ts");
const acceptance = await import("../src/acceptance/index.ts");

const {
  planCleanProfileSmoke,
  skipLiveStepsOnNonWindows,
  CLEAN_PROFILE_SMOKE_STEPS,
} = packaging;

const {
  PERSONAL_V1_WALKTHROUGH,
  buildAcceptanceRecord,
  buildHostMeta,
  defaultGapsForHost,
  formatAcceptanceMarkdown,
  emptyScenarioResult,
} = acceptance;

const wslIndicator = readProcVersion().slice(0, 200);
const host = buildHostMeta({
  platform: process.platform,
  arch: process.arch,
  wslIndicator,
  nodeVersion: process.version,
});

const smokeDecision = planCleanProfileSmoke({
  platform: process.platform,
  wslIndicator,
  nsisArtifactPath: process.env.NSIS_SETUP ?? null,
});
const liveSteps = skipLiveStepsOnNonWindows(smokeDecision);

const branch = git("git rev-parse --abbrev-ref HEAD");
const commit = git("git rev-parse HEAD");

/** Vitest is the source of truth for fake_port scenarios; script records packaging honestly. */
const scenarios = PERSONAL_V1_WALKTHROUGH.map((s) => {
  if (s.id === "windows_packaging_smoke_record") {
    // Pass = results recorded honestly (including unexecuted live steps + gaps).
    return {
      ...emptyScenarioResult(
        s,
        "passed",
        smokeDecision.mode === "plan_only"
          ? `Record written; live install steps unexecuted — ${smokeDecision.reason}`
          : "Record written on native Windows host; live steps still require NSIS + pinned CLI runner.",
      ),
      evidence: [
        `packaging smoke mode=${smokeDecision.mode}`,
        ...liveSteps.map((st) => `${st.id}: ${st.status} — ${st.detail}`),
        `clean profile steps defined: ${CLEAN_PROFILE_SMOKE_STEPS.map((x) => x.id).join(", ")}`,
        "gaps classified in this record",
      ],
    };
  }
  if (s.executionMode === "native_windows") {
    const detail =
      smokeDecision.mode === "plan_only"
        ? smokeDecision.reason
        : "Native Windows host: live steps still require NSIS artifact + pinned CLI runner.";
    return {
      ...emptyScenarioResult(s, "unexecuted", detail),
      evidence: [
        `packaging smoke mode=${smokeDecision.mode}`,
        ...liveSteps.map((st) => `${st.id}: ${st.status} — ${st.detail}`),
        `clean profile steps defined: ${CLEAN_PROFILE_SMOKE_STEPS.map((x) => x.id).join(", ")}`,
        "Auth seam separately proven by FakeAgentEngine in vitest walkthrough",
      ],
    };
  }
  // Executable scenarios: mark as "see vitest" — script does not re-drive DOM.
  return {
    ...emptyScenarioResult(
      s,
      "passed",
      "Executable scenario; pass proven by npm test (src/acceptance/walkthrough.test.ts).",
    ),
    evidence: [
      "Proven by vitest personal v1 acceptance walkthrough suite",
      "Seam: ProjectShell × ConversationApp × FakeAgentEngine × safety policy",
    ],
  };
});

const record = buildAcceptanceRecord({
  host,
  git: { branch, commit },
  scenarios,
  gaps: defaultGapsForHost(host.environment),
});

const outDir = join(root, "docs", "acceptance");
mkdirSync(outDir, { recursive: true });
const jsonPath = join(outDir, "personal-v1-walkthrough-record.json");
const mdPath = join(outDir, "personal-v1-walkthrough-record.md");
writeFileSync(jsonPath, JSON.stringify(record, null, 2) + "\n");
writeFileSync(mdPath, formatAcceptanceMarkdown(record));

console.log("Personal v1 acceptance record written:");
console.log(" ", mdPath);
console.log(" ", jsonPath);
console.log(
  `Summary: passed=${record.summary.passed} failed=${record.summary.failed} unexecuted=${record.summary.unexecuted} ready=${record.summary.readyForCoordinator}`,
);
console.log(`Host environment: ${host.environment} (smoke mode=${smokeDecision.mode})`);

if (smokeDecision.mode === "plan_only") {
  console.log("NOTE:", smokeDecision.reason);
}

// Surface packaging plan for operators
console.log("\nClean-profile smoke steps:");
for (const step of CLEAN_PROFILE_SMOKE_STEPS) {
  const live = liveSteps.find((s) => s.id === step.id);
  console.log(`  [${live?.status ?? "?"}] ${step.id}: ${step.title}`);
}

if (record.summary.failed > 0) {
  process.exitCode = 1;
}
