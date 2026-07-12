/**
 * Detect raw secret material for hard-blocks (and reuse redaction).
 */

import { redactSecrets } from "../engine/redact";

const RAW_SECRET_PATTERNS: RegExp[] = [
  /\bxai-[A-Za-z0-9_-]{10,}\b/i,
  /\bsk-[A-Za-z0-9_-]{10,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b(?:api[_-]?key|access_token|refresh_token|client_secret|password)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
];

/** True when free-form text appears to contain raw credential material. */
export function containsRawSecret(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const pattern of RAW_SECRET_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/** Redact secrets for logs, diffs, activity, and errors. */
export function redactForDisplay(text: string): string {
  return redactSecrets(text);
}

export { redactSecrets };
