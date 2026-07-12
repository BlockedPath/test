/**
 * Pinned engine identity and official acquisition guidance.
 * Sources: docs/research/windows-acp-engine-spike.md, grok-cli-engine-boundary.md
 */

/** Minimum / preferred Windows CLI version for v1. */
export const PINNED_ENGINE_VERSION = "0.2.93";

/** Expected Authenticode publisher subject (substring match). */
export const EXPECTED_PUBLISHER = "X.AI LLC";

/**
 * Optional hard pin of the EV signer thumbprint from the Windows spike.
 * Cert rotation will break a hard pin — prefer publisher + valid signature,
 * and treat thumbprint as an optional stricter policy.
 */
export const EXPECTED_SIGNER_THUMBPRINT =
  "C4550B58C79C51C04390FAC323E600A1459186EB";

/** Official Windows install channel (PowerShell). */
export const OFFICIAL_WINDOWS_INSTALL_COMMAND =
  "irm https://x.ai/cli/install.ps1 | iex";

/** npm alternative (still proprietary; installs platform optional deps). */
export const OFFICIAL_NPM_PACKAGE = "@xai-official/grok";

/** Documented launch argv — never via cmd.exe / PowerShell intermediary. */
export const ENGINE_STDIO_ARGS = [
  "--no-auto-update",
  "agent",
  "stdio",
] as const;

export const ACQUISITION_HELP = {
  summary:
    "Install the official Grok Build CLI for Windows, then relaunch the app.",
  windowsPowerShell: OFFICIAL_WINDOWS_INSTALL_COMMAND,
  pinVersion: `Set GROK_VERSION=${PINNED_ENGINE_VERSION} before install, or use the installer -Version flag when available.`,
  npmAlternative: `npm install -g ${OFFICIAL_NPM_PACKAGE}@${PINNED_ENGINE_VERSION}`,
  defaultBinaryHint: "%USERPROFILE%\\.grok\\bin\\grok.exe",
  docsUrl: "https://docs.x.ai/build/overview",
} as const;

export const CLIENT_INFO = {
  name: "grok-gui",
  version: "0.1.0",
} as const;
