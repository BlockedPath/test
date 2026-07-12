/**
 * Reproducible pass/fail record for the personal v1 acceptance walkthrough.
 */

import {
  classifyHostEnvironment,
  type HostEnvironmentKind,
} from "../packaging/clean-profile-smoke";
import {
  PERSONAL_V1_WALKTHROUGH,
  type ScenarioId,
  type WalkthroughScenario,
} from "./scenarios";

export type ScenarioStatus =
  | "passed"
  | "failed"
  | "unexecuted"
  | "skipped";

export type GapClassification =
  | "environment"
  | "product"
  | "out_of_scope"
  | "deferred";

export type AcceptanceGap = {
  id: string;
  classification: GapClassification;
  summary: string;
  detail?: string;
};

export type ScenarioResult = {
  id: ScenarioId;
  title: string;
  status: ScenarioStatus;
  /** Free-form evidence lines (assertions, DOM text, event types). */
  evidence: string[];
  /** Why unexecuted/skipped, or failure detail. */
  detail?: string;
  passCriteria: string[];
};

export type AcceptanceRecord = {
  issue: 19;
  title: string;
  generatedAt: string;
  host: {
    platform: string;
    arch: string;
    environment: HostEnvironmentKind;
    wslIndicator: string | null;
    nodeVersion: string;
  };
  git: {
    branch: string | null;
    commit: string | null;
  };
  suite: {
    name: string;
    scenarios: ScenarioResult[];
  };
  gaps: AcceptanceGap[];
  summary: {
    passed: number;
    failed: number;
    unexecuted: number;
    skipped: number;
    total: number;
    /** True only when every executable scenario passed and no failures. */
    readyForCoordinator: boolean;
  };
};

export function buildHostMeta(input: {
  platform: string;
  arch: string;
  wslIndicator?: string | null;
  nodeVersion?: string;
}): AcceptanceRecord["host"] {
  return {
    platform: input.platform,
    arch: input.arch,
    environment: classifyHostEnvironment({
      platform: input.platform,
      wslIndicator: input.wslIndicator,
    }),
    wslIndicator: input.wslIndicator ?? null,
    nodeVersion: input.nodeVersion ?? "unknown",
  };
}

export function emptyScenarioResult(
  scenario: WalkthroughScenario,
  status: ScenarioStatus,
  detail?: string,
): ScenarioResult {
  return {
    id: scenario.id,
    title: scenario.title,
    status,
    evidence: [],
    detail,
    passCriteria: [...scenario.passCriteria],
  };
}

export function summarize(
  scenarios: ScenarioResult[],
): AcceptanceRecord["summary"] {
  const counts = {
    passed: 0,
    failed: 0,
    unexecuted: 0,
    skipped: 0,
    total: scenarios.length,
    readyForCoordinator: false,
  };
  for (const s of scenarios) {
    counts[s.status] += 1;
  }
  // Unexecuted native Windows steps are expected on WSL/Linux; failures block ready.
  counts.readyForCoordinator =
    counts.failed === 0 &&
    scenarios
      .filter((s) => {
        const def = PERSONAL_V1_WALKTHROUGH.find((w) => w.id === s.id);
        return def?.executionMode === "fake_port";
      })
      .every((s) => s.status === "passed");
  return counts;
}

export function buildAcceptanceRecord(input: {
  host: AcceptanceRecord["host"];
  git?: AcceptanceRecord["git"];
  scenarios: ScenarioResult[];
  gaps: AcceptanceGap[];
  generatedAt?: string;
}): AcceptanceRecord {
  return {
    issue: 19,
    title: "Personal v1 acceptance walkthrough",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    host: input.host,
    git: input.git ?? { branch: null, commit: null },
    suite: {
      name: "personal-v1-walkthrough",
      scenarios: input.scenarios,
    },
    gaps: input.gaps,
    summary: summarize(input.scenarios),
  };
}

/**
 * Default remaining gaps for personal v1 on a non-Windows CI/agent host.
 * Product gaps that still need a native Windows pass are environment-classified.
 */
export function defaultGapsForHost(
  environment: HostEnvironmentKind,
): AcceptanceGap[] {
  const gaps: AcceptanceGap[] = [];
  if (environment !== "native_windows") {
    gaps.push({
      id: "native-windows-nsis-install",
      classification: "environment",
      summary:
        "Live current-user NSIS install + WebView2 bootstrap not executed on this host",
      detail: `Host environment is ${environment}; requires native Windows with NSIS artifact.`,
    });
    gaps.push({
      id: "real-pinned-cli-process",
      classification: "environment",
      summary:
        "Real pinned Grok CLI process tests (spawn, cancel tree, live auth browser flow) not executed",
      detail:
        "Walkthrough used FakeAgentEngine + packaging plan-only smoke. Process tests require native Windows + pinned engine.",
    });
  }
  gaps.push({
    id: "visual-density-review",
    classification: "deferred",
    summary:
      "Manual Windows visual review (keyboard, focus, contrast, density) not automated",
    detail:
      "Spec requires manual visual review against prototype B direction; not claimed by this suite.",
  });
  gaps.push({
    id: "multi-day-audit-export",
    classification: "out_of_scope",
    summary: "Persistent multi-day audit history / exportable audit files",
    detail: "Explicitly out of scope for v1.",
  });
  return gaps;
}

/** Markdown report for docs/acceptance and GitHub comments. */
export function formatAcceptanceMarkdown(record: AcceptanceRecord): string {
  const lines: string[] = [];
  lines.push(`# ${record.title}`);
  lines.push("");
  lines.push(`- **Issue:** #${record.issue}`);
  lines.push(`- **Generated:** ${record.generatedAt}`);
  lines.push(
    `- **Host:** ${record.host.platform}/${record.host.arch} (${record.host.environment})`,
  );
  if (record.host.wslIndicator) {
    lines.push(`- **WSL indicator:** ${record.host.wslIndicator}`);
  }
  lines.push(`- **Node:** ${record.host.nodeVersion}`);
  if (record.git.commit) {
    lines.push(
      `- **Git:** \`${record.git.branch ?? "?"}\` @ \`${record.git.commit}\``,
    );
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `| passed | failed | unexecuted | skipped | ready |`,
  );
  lines.push(`| --- | --- | --- | --- | --- |`);
  lines.push(
    `| ${record.summary.passed} | ${record.summary.failed} | ${record.summary.unexecuted} | ${record.summary.skipped} | ${record.summary.readyForCoordinator ? "yes" : "no"} |`,
  );
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  for (const s of record.suite.scenarios) {
    const badge =
      s.status === "passed"
        ? "PASS"
        : s.status === "failed"
          ? "FAIL"
          : s.status === "unexecuted"
            ? "UNEXECUTED"
            : "SKIPPED";
    lines.push(`### ${s.title} — ${badge}`);
    lines.push("");
    lines.push(`- **id:** \`${s.id}\``);
    if (s.detail) lines.push(`- **detail:** ${s.detail}`);
    lines.push("- **pass criteria:**");
    for (const c of s.passCriteria) {
      lines.push(`  - ${c}`);
    }
    if (s.evidence.length) {
      lines.push("- **evidence:**");
      for (const e of s.evidence) {
        lines.push(`  - ${e}`);
      }
    }
    lines.push("");
  }
  lines.push("## Remaining gaps");
  lines.push("");
  if (record.gaps.length === 0) {
    lines.push("_None recorded._");
  } else {
    for (const g of record.gaps) {
      lines.push(
        `- **[${g.classification}]** \`${g.id}\`: ${g.summary}${g.detail ? ` — ${g.detail}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "_Do not treat unexecuted native Windows steps as passed. Re-run on native Windows with NSIS + pinned CLI to close environment gaps._",
  );
  lines.push("");
  return lines.join("\n");
}
