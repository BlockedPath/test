/**
 * Keep credentials out of GUI state, errors, and diagnostics.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\b(xai-[A-Za-z0-9_-]{10,})\b/gi,
  /\b(sk-[A-Za-z0-9_-]{10,})\b/gi,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[_-]?key\s*[:=]\s*)([^\s"',}]+)/gi,
  /\b((?:access_|refresh_|id_)?token\s*[:=]\s*)([^\s"',}]+)/gi,
  /\b(password\s*[:=]\s*)([^\s"',}]+)/gi,
  /\b(authorization\s*[:=]\s*)([^\s"',}]+)/gi,
  /("?(?:access_token|refresh_token|id_token|api_key|apiKey|client_secret)"?\s*:\s*")([^"]+)(")/gi,
];

const REDACTED = "[REDACTED]";

/** Redact known secret shapes from free-form diagnostic text. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, g1?: string, g2?: string, g3?: string) => {
      // JSON "key": "value"
      if (
        typeof g1 === "string" &&
        typeof g2 === "string" &&
        typeof g3 === "string" &&
        g3 === `"`
      ) {
        return `${g1}${REDACTED}${g3}`;
      }
      // Prefix + value (api_key=, token=, Bearer )
      if (typeof g1 === "string" && typeof g2 === "string") {
        if (/bearer\s+$/i.test(g1) || /[:=]\s*$/.test(g1)) {
          return `${g1}${REDACTED}`;
        }
        // Whole-token match like xai-… / sk-… where g1 is the secret
        if (/^(xai-|sk-)/i.test(g1) && g2 === undefined) {
          return REDACTED;
        }
        if (/^(xai-|sk-)/i.test(match)) {
          return REDACTED;
        }
      }
      // Single capture whole secret
      if (typeof g1 === "string" && g2 === undefined) {
        return REDACTED;
      }
      return REDACTED;
    });
  }
  return out;
}

/** Deep-clone JSON-like values while redacting string leaves. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|api[_-]?key|authorization|credential/i.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as T;
  }
  return value;
}

export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return redactSecrets(err.message);
  }
  return redactSecrets(String(err));
}
