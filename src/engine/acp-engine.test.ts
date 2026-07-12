/**
 * Bridge contract tests: initialize, authenticate, session creation,
 * stderr, protocol errors, and process exit — via fake ACP transport.
 */

import { describe, expect, it } from "vitest";
import { GrokAcpEngine } from "./acp-engine";
import { FakeAcpAgentProcess } from "./acp/fake-agent-process";
import type { DiscoveryHost } from "./discovery";
import type { IdentityHost } from "./identity";
import type { GuiEvent } from "./types";
import { EXPECTED_PUBLISHER } from "./constants";
import { redactSecrets } from "./redact";

function testDiscovery(path = "C:\\fake\\grok.exe"): DiscoveryHost {
  return {
    platform: "win32",
    env: { USERPROFILE: "C:\\Users\\demo" },
    fileExists: (p) => p === path,
    joinPath: (...parts) => parts.join("\\"),
  };
}

function testIdentity(): IdentityHost {
  return {
    platform: "win32",
    readVersion: async () => "grok 0.2.93 (test) [stable]",
    readSignature: async () => ({
      valid: true,
      publisher: EXPECTED_PUBLISHER,
      thumbprint: "C4550B58C79C51C04390FAC323E600A1459186EB",
    }),
  };
}

function createEngine(
  agent: FakeAcpAgentProcess,
  path = "C:\\fake\\grok.exe",
  onSpawn?: (plan: {
    command: string;
    args: string[];
    shell: false;
  }) => void,
) {
  return new GrokAcpEngine({
    discovery: testDiscovery(path),
    identity: testIdentity(),
    enginePath: path,
    spawn: (plan) => {
      onSpawn?.(plan);
      return agent;
    },
    requestTimeoutMs: 5_000,
  });
}

describe("GrokAcpEngine bridge contracts", () => {
  it("initializes ACP, authenticates, creates a session, and reports health/version", async () => {
    const agent = new FakeAcpAgentProcess({
      agentVersion: "0.2.93",
      sessionId: "sess-contract-1",
    });
    let spawnPlan: { command: string; args: string[]; shell: false } | null =
      null;
    const engine = createEngine(agent, "C:\\fake\\grok.exe", (plan) => {
      spawnPlan = plan;
    });
    const events: GuiEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.start({ projectPath: "C:\\proj" });
    await engine.authenticate();
    const sessionId = await engine.createSession({ cwd: "C:\\proj" });

    // Direct spawn: no shell intermediary; exact stdio argv from research spike
    expect(spawnPlan).not.toBeNull();
    expect(spawnPlan!.shell).toBe(false);
    expect(spawnPlan!.command).toBe("C:\\fake\\grok.exe");
    expect(spawnPlan!.args).toEqual([
      "--no-auto-update",
      "agent",
      "stdio",
    ]);

    expect(sessionId).toBe("sess-contract-1");
    const snap = engine.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.sessionId).toBe("sess-contract-1");
    expect(snap!.engineVersion).toBe("0.2.93");
    expect(snap!.protocolVersion).toBe(1);
    expect(snap!.projectPath).toBe("C:\\proj");
    expect(snap!.state).toBe("idle");

    const types = events.map((e) => e.type);
    expect(types).toContain("engine.started");
    expect(types).toContain("engine.authenticated");
    expect(types).toContain("session.created");

    const started = events.find((e) => e.type === "engine.started");
    expect(started?.type).toBe("engine.started");
    if (started?.type === "engine.started") {
      expect(started.payload.engineVersion).toBe("0.2.93");
      expect(started.payload.protocolVersion).toBe(1);
    }

    await engine.dispose();
    expect(engine.getSnapshot()?.state).toBe("disposed");
  });

  it("surfaces stderr without crashing the bridge", async () => {
    const agent = new FakeAcpAgentProcess({
      stderrOnStart: "agent diagnostic: warming model cache\n",
    });
    const engine = createEngine(agent);
    const events: GuiEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.start({ projectPath: "C:\\proj" });
    await new Promise((r) => setTimeout(r, 20));

    const stderr = events.filter((e) => e.type === "engine.stderr");
    expect(stderr.length).toBeGreaterThan(0);
    if (stderr[0]?.type === "engine.stderr") {
      expect(stderr[0].payload.text).toMatch(/warming model cache/);
    }

    await engine.dispose();
  });

  it("maps protocol initialize errors to engine.error", async () => {
    const agent = new FakeAcpAgentProcess({
      failInitialize: {
        code: -32000,
        message: "protocol version unsupported",
      },
    });
    const engine = createEngine(agent);
    const events: GuiEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await expect(engine.start({ projectPath: "C:\\proj" })).rejects.toThrow(
      /protocol version unsupported/i,
    );

    const err = events.find((e) => e.type === "engine.error");
    expect(err?.type).toBe("engine.error");
    if (err?.type === "engine.error") {
      expect(err.payload.code).toBe("initialize_failed");
      expect(err.payload.message).toMatch(/protocol version unsupported/i);
    }
  });

  it("represents browser, device-code, and API-key auth failures without secrets", async () => {
    const cases: Array<{
      methodId: string;
      policy: "browser" | "device" | "api_key";
      message: string;
      expectCode: string;
      secretInMessage: string;
    }> = [
      {
        methodId: "grok.com",
        policy: "browser",
        message: "browser OIDC failed; token=xai-supersecretvalue99",
        expectCode: "auth_browser_failed",
        secretInMessage: "xai-supersecretvalue99",
      },
      {
        methodId: "device_code",
        policy: "device",
        message: "device code expired; access_token=leakytokenvalue",
        expectCode: "auth_device_code_failed",
        secretInMessage: "leakytokenvalue",
      },
      {
        methodId: "xai.api_key",
        policy: "api_key",
        message: "invalid api_key=sk-should-not-appear-in-ui",
        expectCode: "auth_api_key_failed",
        secretInMessage: "sk-should-not-appear-in-ui",
      },
    ];

    for (const c of cases) {
      const agent = new FakeAcpAgentProcess({
        authMethods: [
          { id: c.methodId, name: c.methodId },
          { id: "cached_token", name: "cached" },
        ],
        authFailures: {
          [c.methodId]: { code: -32000, message: c.message },
        },
      });
      const engine = createEngine(agent);
      const events: GuiEvent[] = [];
      engine.subscribe((e) => events.push(e));

      await engine.start({
        projectPath: "C:\\proj",
        authPolicy: c.policy,
      });
      await expect(engine.authenticate()).rejects.toThrow();

      const err = events.find((e) => e.type === "engine.error");
      expect(err?.type).toBe("engine.error");
      if (err?.type === "engine.error") {
        expect(err.payload.code).toBe(c.expectCode);
        expect(err.payload.message).not.toContain(c.secretInMessage);
        expect(redactSecrets(err.payload.message)).toBe(err.payload.message);
      }

      await engine.dispose();
    }
  });

  it("emits engine.exited when the process exits", async () => {
    const agent = new FakeAcpAgentProcess({
      exitAfterMs: 80,
      exitCode: 7,
    });
    const engine = createEngine(agent);
    const events: GuiEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await engine.start({ projectPath: "C:\\proj" });
    await new Promise((r) => setTimeout(r, 150));

    const exited = events.find((e) => e.type === "engine.exited");
    expect(exited?.type).toBe("engine.exited");
    if (exited?.type === "engine.exited") {
      expect(exited.payload.exitCode).toBe(7);
    }
    const fault = events.find((e) => e.type === "engine.error");
    expect(fault?.type).toBe("engine.error");
  });

  it("fails start with acquisition guidance when CLI is missing", async () => {
    const agent = new FakeAcpAgentProcess();
    const engine = new GrokAcpEngine({
      discovery: {
        platform: "win32",
        env: { USERPROFILE: "C:\\Users\\demo" },
        fileExists: () => false,
        joinPath: (...p) => p.join("\\"),
      },
      identity: testIdentity(),
      // no enginePath — force discovery
      spawn: () => agent,
    });
    const events: GuiEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await expect(
      engine.start({ projectPath: "C:\\proj" }),
    ).rejects.toThrow(/No supported Grok Build CLI/i);

    const err = events.find((e) => e.type === "engine.error");
    expect(err?.type).toBe("engine.error");
    if (err?.type === "engine.error") {
      expect(err.payload.code).toBe("engine_missing");
      expect(err.payload.message).toMatch(/install\.ps1|Acquisition/i);
    }
  });

  it("fails start when signature verification fails", async () => {
    const agent = new FakeAcpAgentProcess();
    const engine = new GrokAcpEngine({
      discovery: testDiscovery(),
      identity: {
        platform: "win32",
        readVersion: async () => "grok 0.2.93 (test)",
        readSignature: async () => ({
          valid: false,
          detail: "Authenticode status: HashMismatch",
        }),
      },
      enginePath: "C:\\fake\\grok.exe",
      spawn: () => agent,
    });
    const events: GuiEvent[] = [];
    engine.subscribe((e) => events.push(e));

    await expect(engine.start({ projectPath: "C:\\proj" })).rejects.toThrow(
      /HashMismatch|invalid/i,
    );
    const err = events.find((e) => e.type === "engine.error");
    expect(err?.type).toBe("engine.error");
    if (err?.type === "engine.error") {
      expect(err.payload.code).toBe("signature_invalid");
    }
  });

  it("never exposes raw ACP method names on the GuiEvent type stream", async () => {
    const agent = new FakeAcpAgentProcess();
    const engine = createEngine(agent);
    const types: string[] = [];
    engine.subscribe((e) => types.push(e.type));

    await engine.start({ projectPath: "C:\\proj" });
    await engine.authenticate();
    await engine.createSession();
    await engine.sendPrompt("hi");
    await engine.dispose();

    for (const t of types) {
      expect(t).not.toMatch(/session\/|jsonrpc|initialize/i);
    }
  });
});
