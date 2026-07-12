/**
 * Discover a supported Grok Build CLI, or describe the official acquisition path.
 */

import {
  ACQUISITION_HELP,
  PINNED_ENGINE_VERSION,
} from "./constants";

export type EngineCandidate = {
  path: string;
  source:
    | "env"
    | "user_bin"
    | "path"
    | "downloads"
    | "configured";
};

export type DiscoveryResult =
  | {
      status: "found";
      candidate: EngineCandidate;
      /** Additional candidates that were considered (for diagnostics). */
      alsoFound: EngineCandidate[];
    }
  | {
      status: "missing";
      searched: string[];
      acquisition: typeof ACQUISITION_HELP;
      message: string;
    };

export type DiscoveryHost = {
  platform: NodeJS.Platform | string;
  env: Record<string, string | undefined>;
  /** Return true if path exists and is a regular file. */
  fileExists: (path: string) => boolean | Promise<boolean>;
  /** Resolve `which`-style PATH lookup; empty when not found. */
  which?: (command: string) => string | null | Promise<string | null>;
  /** Path join that respects the host OS separator. */
  joinPath: (...parts: string[]) => string;
};

function homeDir(env: Record<string, string | undefined>): string | undefined {
  return env.USERPROFILE || env.HOME || undefined;
}

/**
 * Candidate locations for the official Windows CLI (and Linux/mac for dev).
 * Windows v1 is the product target; other platforms help local testing.
 */
export function candidatePaths(host: DiscoveryHost): EngineCandidate[] {
  const out: EngineCandidate[] = [];
  const envPath = host.env.GROK_EXE || host.env.GROK_PATH;
  if (envPath) {
    out.push({ path: envPath, source: "env" });
  }

  const home = homeDir(host.env);
  if (home) {
    if (host.platform === "win32" || host.env.GROK_FORCE_WIN_LAYOUT === "1") {
      out.push({
        path: host.joinPath(home, ".grok", "bin", "grok.exe"),
        source: "user_bin",
      });
      // Versioned download cache (spike observation)
      out.push({
        path: host.joinPath(
          home,
          ".grok",
          "downloads",
          `grok-${PINNED_ENGINE_VERSION}-windows-x86_64`,
          "grok.exe",
        ),
        source: "downloads",
      });
    } else {
      out.push({
        path: host.joinPath(home, ".grok", "bin", "grok"),
        source: "user_bin",
      });
    }
  }

  return out;
}

export async function discoverEngine(
  host: DiscoveryHost,
): Promise<DiscoveryResult> {
  const candidates = candidatePaths(host);
  const searched: string[] = candidates.map((c) => c.path);
  const found: EngineCandidate[] = [];

  for (const c of candidates) {
    if (await host.fileExists(c.path)) {
      found.push(c);
    }
  }

  // PATH lookup last so explicit env/user_bin win
  if (host.which) {
    const names =
      host.platform === "win32"
        ? ["grok.exe", "grok"]
        : ["grok"];
    for (const name of names) {
      const resolved = await host.which(name);
      if (resolved) {
        searched.push(`PATH:${name}`);
        if (!found.some((f) => f.path === resolved)) {
          found.push({ path: resolved, source: "path" });
        }
      }
    }
  }

  if (found.length === 0) {
    return {
      status: "missing",
      searched,
      acquisition: ACQUISITION_HELP,
      message:
        "No supported Grok Build CLI was found. Install the official Windows CLI, then retry.",
    };
  }

  return {
    status: "found",
    candidate: found[0]!,
    alsoFound: found.slice(1),
  };
}
