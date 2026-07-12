/**
 * Verify Windows prerequisites that can be exercised from native Windows or
 * through WSL interop. This deliberately does not claim NSIS installation.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readWebView2() {
  const script = [
    "$keys=@(",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',",
    "'HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'",
    ");",
    "$found=$keys | Where-Object { Test-Path $_ } | Select-Object -First 1;",
    "if (-not $found) { @{ present = $false } | ConvertTo-Json -Compress; exit 0 };",
    "$p=Get-ItemProperty $found; @{ present = $true; version = $p.pv; location = $p.location } | ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  return JSON.parse(stdout.trim());
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
  if (!report.webview2.present) throw new Error("WebView2 runtime not found");
} catch (error) {
  report.ok = false;
  report.webview2 = { present: false, error: String(error) };
}

try {
  report.engineSmoke = await runEngineSmoke();
} catch (error) {
  report.ok = false;
  report.engineSmoke = { error: String(error) };
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
