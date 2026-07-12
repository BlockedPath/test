import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "./redact";

describe("redactSecrets", () => {
  it("redacts API keys and bearer tokens", () => {
    expect(redactSecrets("key=xai-abcdef1234567890")).toContain("[REDACTED]");
    expect(redactSecrets("Bearer supersecrettokenvalue")).toContain("[REDACTED]");
    expect(redactSecrets("Bearer supersecrettokenvalue")).not.toContain(
      "supersecret",
    );
  });

  it("redacts sensitive object keys", () => {
    const out = redactDeep({
      methodId: "xai.api_key",
      access_token: "leak-me-please",
      nested: { api_key: "also-secret" },
    });
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.nested.api_key).toBe("[REDACTED]");
    expect(out.methodId).toBe("xai.api_key");
  });
});
