/**
 * Command classification and narrow Session allowlist fingerprints.
 */

const ELEVATED_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\b(?:rm\s+-[a-zA-Z]*r[a-zA-Z]*f|rm\s+-[a-zA-Z]*f[a-zA-Z]*r|del\s+\/s|rd\s+\/s|rmdir\s+\/s)\b/i,
    reason: "Destructive recursive delete requires elevated approval",
  },
  {
    re: /\bgit\s+(?:push\s+.*(?:--force|-f)\b|reset\s+--hard|filter-branch|filter-repo|push\s+--mirror)\b/i,
    reason: "Git history or force-publish risk requires elevated approval",
  },
  {
    re: /\b(?:sudo|doas|runas|pkexec)\b/i,
    reason: "Privilege elevation requires elevated approval",
  },
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+.*-g\b|\bnpm\s+install\s+-g\b|\bpip(?:3)?\s+install\b.*--(?:user|break-system-packages)\b|\bapt(?:-get)?\s+install\b|\bchoco\s+install\b|\bwinget\s+install\b/i,
    reason: "Global or system package mutation requires elevated approval",
  },
  {
    re: /\|\s*(?:sh|bash|zsh|powershell|pwsh|cmd)(?:\s|$)/i,
    reason: "Pipe-to-shell requires elevated approval",
  },
  {
    re: /\b(?:curl|wget)\b.+\|\s*(?:sh|bash|zsh)/i,
    reason: "Remote script execution requires elevated approval",
  },
  {
    re: /\b(?:kill\s+-9|killall|taskkill)\b/i,
    reason: "Process kill outside the agent tree requires elevated approval",
  },
  {
    re: /\b(?:chmod\s+777|icacls\b.*\/grant)\b/i,
    reason: "Broad permission changes require elevated approval",
  },
  {
    re: /\b(?:format\s+[a-z]:|diskpart|mkfs)\b/i,
    reason: "Disk format operations require elevated approval",
  },
];

function shellLine(command: string, args?: string[]): string {
  const parts = [command, ...(args ?? [])].map((p) => p.trim()).filter(Boolean);
  return parts.join(" ");
}

/** True when the command matches elevated / destructive heuristics. */
export function isElevatedCommand(command: string, args?: string[]): boolean {
  return classifyCommandElevation(command, args) !== null;
}

export function classifyCommandElevation(
  command: string,
  args?: string[],
): string | null {
  const line = shellLine(command, args);
  for (const { re, reason } of ELEVATED_COMMAND_PATTERNS) {
    if (re.test(line)) return reason;
  }
  // Bare elevated binaries without args
  const base = baseCommandName(command);
  if (
    ["sudo", "doas", "pkexec", "diskpart", "format", "taskkill", "killall"].includes(
      base,
    )
  ) {
    return "Privileged or destructive binary requires elevated approval";
  }
  return null;
}

/**
 * Narrow fingerprint for "allow similar" — exact argv shape after normalizing
 * the executable basename. Does not broaden to whole tool families.
 */
export function commandFingerprint(command: string, args?: string[]): string {
  const base = baseCommandName(command);
  const normalizedArgs = (args ?? []).map((a) => a.trim()).filter(Boolean);
  return JSON.stringify([base, ...normalizedArgs]);
}

export function baseCommandName(command: string): string {
  const trimmed = command.trim();
  // Shell one-liners: fingerprint the whole line so "allow similar" stays narrow.
  if (/[|&;<>]/.test(trimmed) || /\s/.test(trimmed)) {
    // Prefer first token basename when it's a simple "cmd arg arg" form.
    const first = trimmed.split(/\s+/)[0] ?? trimmed;
    if (!/[|&;<>]/.test(first) && !trimmed.includes("|")) {
      const base = first.replace(/^.*[/\\]/, "").toLowerCase();
      const rest = trimmed.slice(first.length).trim();
      return rest ? `${base} ${rest}` : base;
    }
    return trimmed.toLowerCase();
  }
  return trimmed.replace(/^.*[/\\]/, "").toLowerCase();
}

/**
 * When the engine only supplies a single command string (no args array),
 * split lightly for fingerprinting.
 */
export function parseCommandLine(commandLine: string): {
  command: string;
  args: string[];
} {
  const parts = commandLine.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { command: "", args: [] };
  return { command: parts[0]!, args: parts.slice(1) };
}
