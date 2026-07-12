/**
 * Safety policy boundary tests — pure Session safety decisions.
 * Seam: decideAction / decideFileBatch / applyYoloChange / rememberAllowSimilar.
 */
import { describe, expect, it } from "vitest";
import {
  applyYoloChange,
  commandFingerprint,
  createSessionSafetyState,
  decideAction,
  decideFileBatch,
  isCredentialAdjacentPath,
  isInsideProject,
  rememberAllowSimilar,
  resetSessionSafety,
  YOLO_WARNING,
} from "./index";
import { containsRawSecret, redactForDisplay } from "./secrets";

const PROJECT = "/home/user/my-project";

function state(yolo = false, allowlist: string[] = []) {
  return {
    ...createSessionSafetyState(PROJECT),
    yoloEnabled: yolo,
    commandAllowlist: allowlist,
  };
}

describe("path scope", () => {
  it("treats Project-relative and nested absolute paths as in-Project", () => {
    expect(isInsideProject(PROJECT, "src/main.ts")).toBe(true);
    expect(isInsideProject(PROJECT, `${PROJECT}/src/main.ts`)).toBe(true);
    expect(isInsideProject(PROJECT, `${PROJECT}/../other/secret.ts`)).toBe(
      false,
    );
    expect(isInsideProject(PROJECT, "/etc/passwd")).toBe(false);
  });

  it("flags credential-adjacent basenames and segments", () => {
    expect(isCredentialAdjacentPath(`${PROJECT}/.env`)).toBe(true);
    expect(isCredentialAdjacentPath(`${PROJECT}/.env.local`)).toBe(true);
    expect(isCredentialAdjacentPath(`${PROJECT}/.ssh/id_rsa`)).toBe(true);
    expect(isCredentialAdjacentPath(`${PROJECT}/secrets/prod.json`)).toBe(true);
    expect(isCredentialAdjacentPath(`${PROJECT}/src/main.ts`)).toBe(false);
  });
});

describe("reads", () => {
  it("auto-allows in-Project reads", () => {
    const d = decideAction(state(), { kind: "read", path: "src/app.ts" });
    expect(d).toMatchObject({
      decision: "allow",
      source: "policy",
      tier: "auto",
    });
  });

  it("prompts for outside-Project reads", () => {
    const d = decideAction(state(), {
      kind: "read",
      path: "/etc/hosts",
    });
    expect(d.decision).toBe("prompt");
    if (d.decision === "prompt") {
      expect(d.tier).toBe("normal");
      expect(d.allowSimilarEligible).toBe(false);
    }
  });

  it("still auto-allows in-Project reads when YOLO is on", () => {
    const d = decideAction(state(true), { kind: "read", path: "README.md" });
    expect(d.decision).toBe("allow");
  });
});

describe("writes and multi-file selection", () => {
  it("prompts for normal in-Project edits when YOLO is off", () => {
    const d = decideAction(state(), {
      kind: "edit",
      path: "src/a.ts",
      content: "export const a = 1;\n",
    });
    expect(d).toMatchObject({
      decision: "prompt",
      tier: "normal",
    });
  });

  it("YOLO auto-allows only normal in-Project edits", () => {
    const d = decideAction(state(true), {
      kind: "edit",
      path: "src/a.ts",
      content: "export const a = 1;\n",
    });
    expect(d).toMatchObject({ decision: "allow", source: "yolo" });
  });

  it("elevates outside-Project writes even with YOLO", () => {
    const d = decideAction(state(true), {
      kind: "write",
      path: "/tmp/outside.txt",
      content: "nope",
    });
    expect(d).toMatchObject({ decision: "prompt", tier: "elevated" });
    expect(d.decision === "allow" ? d.source : null).not.toBe("yolo");
  });

  it("elevates credential-adjacent writes even with YOLO", () => {
    const d = decideAction(state(true), {
      kind: "edit",
      path: ".env",
      content: "DEBUG=1\n",
    });
    expect(d).toMatchObject({ decision: "prompt", tier: "elevated" });
  });

  it("hard-blocks raw secrets in write content even with YOLO", () => {
    const d = decideAction(state(true), {
      kind: "edit",
      path: "src/config.ts",
      content: 'const key = "xai-abcdef1234567890";\n',
    });
    expect(d.decision).toBe("hard_block");
  });

  it("never broadens multi-file selection beyond selected files", () => {
    const batch = decideFileBatch(state(true), [
      {
        path: "src/a.ts",
        selected: true,
        content: "a",
        kind: "edit",
      },
      {
        path: "src/b.ts",
        selected: false,
        content: "b",
        kind: "edit",
      },
      {
        path: "/tmp/out.ts",
        selected: true,
        content: "out",
        kind: "write",
      },
    ]);
    // Unselected in-project file must not appear as writable.
    expect(batch.writablePaths).not.toContain("src/b.ts");
    // YOLO may auto-allow selected in-project file.
    expect(batch.writablePaths).toContain("src/a.ts");
    // Outside path still needs elevated prompt, not auto-written.
    expect(batch.writablePaths).not.toContain("/tmp/out.ts");
    expect(batch.needsElevatedPrompt).toBe(true);
  });

  it("surfaces hard blocks on selected files without applying them", () => {
    const batch = decideFileBatch(state(true), [
      {
        path: "src/leak.ts",
        selected: true,
        content: "token=sk-supersecrettokenvalue",
        kind: "edit",
      },
    ]);
    expect(batch.hasHardBlock).toBe(true);
    expect(batch.writablePaths).toEqual([]);
  });
});

describe("commands and Session allowlist", () => {
  it("prompts for project-local commands by default", () => {
    const d = decideAction(state(), {
      kind: "command",
      command: "npm",
      args: ["test"],
      cwd: PROJECT,
    });
    expect(d).toMatchObject({
      decision: "prompt",
      tier: "normal",
      allowSimilarEligible: true,
    });
  });

  it("allow-similar is Session-scoped and narrow (exact fingerprint)", () => {
    let s = state();
    const remembered = rememberAllowSimilar(s, "npm", ["test"]);
    expect(remembered.added).toBe(true);
    s = remembered.state;

    const same = decideAction(s, {
      kind: "command",
      command: "npm",
      args: ["test"],
      cwd: PROJECT,
    });
    expect(same).toMatchObject({ decision: "allow", source: "allowlist" });

    // Broader sibling is NOT covered.
    const broader = decideAction(s, {
      kind: "command",
      command: "npm",
      args: ["run", "build"],
      cwd: PROJECT,
    });
    expect(broader.decision).toBe("prompt");

    // Different first arg is NOT covered.
    const install = decideAction(s, {
      kind: "command",
      command: "npm",
      args: ["install"],
      cwd: PROJECT,
    });
    expect(install.decision).toBe("prompt");
  });

  it("never stores elevated commands on the Session allowlist", () => {
    const s = state();
    const result = rememberAllowSimilar(s, "rm", ["-rf", "/"]);
    expect(result.added).toBe(false);
    expect(result.state.commandAllowlist).toEqual([]);
    expect(result.reason).toMatch(/elevated/i);
  });

  it("elevated commands still prompt under YOLO and are not allowlist-eligible", () => {
    const d = decideAction(state(true), {
      kind: "command",
      command: "git",
      args: ["push", "--force"],
      cwd: PROJECT,
    });
    expect(d).toMatchObject({
      decision: "prompt",
      tier: "elevated",
      allowSimilarEligible: false,
    });
  });

  it("YOLO auto-allows only normal project-local commands", () => {
    const d = decideAction(state(true), {
      kind: "command",
      command: "npm",
      args: ["test"],
      cwd: PROJECT,
    });
    expect(d).toMatchObject({ decision: "allow", source: "yolo" });
  });

  it("commands with outside-Project cwd are elevated even under YOLO", () => {
    const d = decideAction(state(true), {
      kind: "command",
      command: "ls",
      args: [],
      cwd: "/tmp",
    });
    expect(d).toMatchObject({ decision: "prompt", tier: "elevated" });
  });

  it("hard-blocks raw secrets in command lines under YOLO", () => {
    const d = decideAction(state(true), {
      kind: "command",
      command: "echo",
      args: ["xai-abcdef1234567890"],
      cwd: PROJECT,
    });
    expect(d.decision).toBe("hard_block");
  });

  it("fingerprints are exact argv shapes", () => {
    expect(commandFingerprint("npm", ["test"])).toBe(
      commandFingerprint("/usr/bin/npm", ["test"]),
    );
    expect(commandFingerprint("npm", ["test"])).not.toBe(
      commandFingerprint("npm", ["run", "test"]),
    );
  });
});

describe("YOLO enablement", () => {
  it("is off by default", () => {
    expect(createSessionSafetyState(PROJECT).yoloEnabled).toBe(false);
  });

  it("requires warning confirmation to enable", () => {
    const denied = applyYoloChange(state(), { enabled: true });
    expect(denied.result.ok).toBe(false);
    expect(denied.state.yoloEnabled).toBe(false);

    const ok = applyYoloChange(state(), {
      enabled: true,
      acknowledgeWarning: true,
    });
    expect(ok.result).toEqual({ ok: true, enabled: true });
    expect(ok.state.yoloEnabled).toBe(true);
    expect(YOLO_WARNING.length).toBeGreaterThan(40);
  });

  it("can be turned off without a warning", () => {
    const on = applyYoloChange(state(), {
      enabled: true,
      acknowledgeWarning: true,
    }).state;
    const off = applyYoloChange(on, { enabled: false });
    expect(off.state.yoloEnabled).toBe(false);
    expect(off.result).toEqual({ ok: true, enabled: false });
  });

  it("resetSessionSafety clears YOLO and allowlists (Emergency Stop / new Session)", () => {
    let s = applyYoloChange(state(), {
      enabled: true,
      acknowledgeWarning: true,
    }).state;
    s = rememberAllowSimilar(s, "npm", ["test"]).state;
    const reset = resetSessionSafety(s);
    expect(reset.yoloEnabled).toBe(false);
    expect(reset.commandAllowlist).toEqual([]);
    expect(reset.projectPath).toBe(PROJECT);
  });
});

describe("redaction", () => {
  it("redacts secret values for activity/logs/diffs/errors", () => {
    const raw = "Authorization: Bearer supersecrettokenvalue";
    const out = redactForDisplay(raw);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("supersecret");
  });

  it("detects raw secrets independently of redaction", () => {
    expect(containsRawSecret("xai-abcdef1234567890")).toBe(true);
    expect(containsRawSecret("hello world")).toBe(false);
  });

  it("YOLO does not disable redaction", () => {
    // Policy still hard-blocks secret writes; display redaction remains available.
    const d = decideAction(state(true), {
      kind: "edit",
      path: "a.ts",
      content: "api_key=sk-abcdefghijklmnop",
    });
    expect(d.decision).toBe("hard_block");
    expect(redactForDisplay("api_key=sk-abcdefghijklmnop")).toContain(
      "[REDACTED]",
    );
  });
});

describe("Cancel and Emergency Stop invariants (policy level)", () => {
  it("YOLO does not prevent hard_block or elevated prompts (cancel/stop remain available)", () => {
    // These decisions stay prompt/hard_block so Cancel can still dismiss pending
    // elevated approvals and Emergency Stop can still tear down the session.
    const elevated = decideAction(state(true), {
      kind: "command",
      command: "sudo",
      args: ["rm", "-rf", "/"],
      cwd: PROJECT,
    });
    expect(elevated.decision).toBe("prompt");
    if (elevated.decision === "prompt") {
      expect(elevated.tier).toBe("elevated");
    }

    const blocked = decideAction(state(true), {
      kind: "write",
      path: "src/x.ts",
      content: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n",
    });
    expect(blocked.decision).toBe("hard_block");
  });
});
