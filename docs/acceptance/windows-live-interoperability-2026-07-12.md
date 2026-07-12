# Windows live interoperability check

Date: 2026-07-12

This check ran from WSL through Windows interop (`powershell.exe` / native
`grok.exe`). It is separate from the NSIS clean-profile install gate and does
not claim that an installer was built or installed.

## Results

| Check | Status | Detail |
| --- | --- | --- |
| WebView2 runtime | **PASS** | `150.0.4078.65` (`HKLM:\SOFTWARE\WOW6432Node\...`, location `C:\Program Files (x86)\Microsoft\EdgeWebView\Application`) |
| Engine discovery | **PASS** | `C:\Users\justi\.grok\bin\grok.exe` (env + user_bin) |
| Engine version | **PASS** | `0.2.93` (`grok 0.2.93 (f00f96316d) [stable]`) |
| Authenticode | **PASS** | Valid; publisher X.AI LLC; thumbprint `C4550B58C79C51C04390FAC323E600A1459186EB` |
| ACP initialize | **PASS** | protocol version `1`, engine `0.2.93` |
| CLI-owned authentication | **PASS** | `authenticate: ok` |
| Session creation | **PASS** | sessionId `019f5735-484e-7322-bf58-55a9db66da50`, state `idle` |
| NSIS install | **UNEXECUTED** | No setup artifact or Windows Rust/NSIS build toolchain; requires `NSIS_SETUP` on a native Windows runner |

Overall: `ok: true` (exit 0). Host platform for the harness: `linux` (WSL2).

## Command

```text
npm run test:windows-live
```

The native Windows NSIS gate remains:

```text
npm run test:packaging-smoke
```

with `NSIS_SETUP` pointing to a real current-user installer on native Windows.
