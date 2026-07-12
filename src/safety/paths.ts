/**
 * Path scope and credential-adjacent classification relative to a Project root.
 * Browser-safe (no node:path) so the workspace UI can import the policy.
 */

/** Normalize for comparison: unify separators, drop trailing slash (except root). */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, "/");
  // Collapse repeated slashes (keep leading // for UNC lightly as /)
  out = out.replace(/\/+/g, "/");
  if (out.length > 1 && out.endsWith("/")) {
    out = out.slice(0, -1);
  }
  return out;
}

function isAbsolutePath(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  return n.startsWith("/") || /^[A-Za-z]:\//.test(n);
}

function joinPath(root: string, rel: string): string {
  const r = normalizePath(root);
  const rest = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rest || rest === ".") return r;
  return normalizePath(`${r}/${rest}`);
}

/**
 * Resolve `.` / `..` segments without a filesystem.
 */
function resolveSegments(input: string): string {
  const normalized = normalizePath(input);
  const isAbs = isAbsolutePath(normalized);
  const drive = normalized.match(/^([A-Za-z]:)/);
  let rest = drive ? normalized.slice(drive[1].length) : normalized;
  if (rest.startsWith("/")) rest = rest.slice(1);

  const parts = rest.split("/").filter((p) => p && p !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      // Above root: ignore extra ..
    } else {
      stack.push(part);
    }
  }
  if (drive) {
    return normalizePath(`${drive[1]}/${stack.join("/")}`);
  }
  if (isAbs) {
    return normalizePath(`/${stack.join("/")}`);
  }
  return stack.join("/") || ".";
}

/**
 * True when `target` is the Project root or a path strictly inside it.
 * Relative paths are resolved against the Project root.
 */
export function isInsideProject(projectPath: string, targetPath: string): boolean {
  const root = resolveSegments(projectPath);
  const target = isAbsolutePath(targetPath)
    ? resolveSegments(targetPath)
    : resolveSegments(joinPath(root, targetPath));

  if (target === root) return true;
  const prefix = root.endsWith("/") ? root : root + "/";
  // Case-insensitive compare for Windows drive paths
  if (/^[A-Za-z]:\//.test(root)) {
    return target.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return target.startsWith(prefix);
}

/**
 * Resolve a path for policy checks: relative → under project; absolute as-is.
 */
export function resolveAgainstProject(
  projectPath: string,
  targetPath: string,
): string {
  if (isAbsolutePath(targetPath)) return resolveSegments(targetPath);
  return resolveSegments(joinPath(projectPath, targetPath));
}

function basename(targetPath: string): string {
  const n = normalizePath(targetPath);
  const idx = n.lastIndexOf("/");
  return idx === -1 ? n : n.slice(idx + 1);
}

const CREDENTIAL_BASENAME =
  /^(?:\.env(?:\..+)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|credentials|secrets?|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.(?:pem|key|p12|pfx|jks)|token|auth\.json|secrets\.json)$/i;

const CREDENTIAL_SEGMENTS =
  /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.docker|credentials|secrets)(?:\/|$)/i;

/**
 * Paths that hold or commonly sit next to credentials.
 * These require elevated handling (or hard-block when raw secrets are present).
 */
export function isCredentialAdjacentPath(targetPath: string): boolean {
  const normalized = normalizePath(targetPath);
  const base = basename(normalized);
  if (CREDENTIAL_BASENAME.test(base)) return true;
  if (CREDENTIAL_SEGMENTS.test(normalized)) return true;
  return false;
}
