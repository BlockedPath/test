/**
 * Verify Windows prerequisites that can be exercised from native Windows or
 * through WSL interop. This deliberately does not claim NSIS installation.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Match a real WebView2-style version (e.g. 150.0.4078.65). */
const WEBVIEW2_VERSION_RE = /^\d+\.\d+\.\d+/;

/**
 * Probe machine-wide 64-bit, 32-bit (WOW6432Node), and per-user WebView2
 * client keys. Returns first key with a usable `pv` version.
 */
async function readWebView2() {
  // Single-line PowerShell keeps WSL→powershell.exe -Command quoting simple.
  const script = [
    "$ErrorActionPreference='Stop';",
    "$keys=@(",
    "'HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',",
    "'HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'",
    ");",
    "$out=$null;",
    "foreach($k in $keys){",
    "  if(-not (Test-Path $k)){ continue };",
    "  $p=Get-ItemProperty -Path $k -ErrorAction SilentlyContinue;",
    "  if($null -eq $p){ continue };",
    "  $ver=[string]$p.pv;",
    "  if([string]::IsNullOrWhiteSpace($ver)){ continue };",
    "  $out=@{ present=$true; version=$ver; location=[string]$p.location; key=$k };",
    "  break",
    "};",
    "if($null -eq $out){ $out=@{ present=$false } };",
    "$out | ConvertTo-Json -Compress",
  ].join(" ");

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);

  // powershell.exe often emits UTF-8/ANSI with CRLF; strip BOM + whitespace.
  const text = stdout.replace(/^\uFEFF/, "").trim();
  if (!text) {
    return { present: false, error: "empty PowerShell WebView2 probe output" };
  }
  return JSON.parse(text);
}

function webView2Usable(info) {
  if (!info || info.present !== true) return false;
  return WEBVIEW2_VERSION_RE.test(String(info.version ?? ""));
}

async function runEngineSmoke() {
  const tsx = process.platform === "win32"
    ? "node_modules/.bin/tsx.cmd"
    : "node_modules/.bin/tsx";
  const { stdout, stderr } = await execFileAsync(
    tsx,
    ["scripts/windows-engine-smoke.mjs"],
    { cwd: process.cwd(), env: process.env, timeout: 120_000 },
  );
  return `${stdout}${stderr}`;
}

const report = {
  host: process.platform,
  webview2: null,
  engineSmoke: null,
  installer: {
    status: "unexecuted",
    detail:
      "NSIS install is intentionally separate and requires NSIS_SETUP plus a native Windows runner.",
  },
  ok: true,
};

try {
  report.webview2 = await readWebView2();
  if (!webView2Usable(report.webview2)) {
    throw new Error(
      `WebView2 runtime is missing a usable version (got ${JSON.stringify(report.webview2)})`,
    );
  }
} catch (error) {
  report.ok = false;
  report.webview2 = {
    present: false,
    error: String(error?.message ?? error),
  };
}

try {
  report.engineSmoke = await runEngineSmoke();
} catch (error) {
  report.ok = false;
  report.engineSmoke = { error: String(error) };
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
