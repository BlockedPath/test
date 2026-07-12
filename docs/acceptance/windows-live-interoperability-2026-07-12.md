# Windows live interoperability check

Date: 2026-07-12

This check ran from WSL through Windows interop. It is separate from the NSIS
clean-profile install gate and does not claim that an installer was built or
installed.

## Results

- WebView2 runtime: **PASS**, version `150.0.4078.65`
- Engine discovery: **PASS**, `C:\Users\justi\.grok\bin\grok.exe`
- Engine version: **PASS**, `0.2.93`
- Authenticode: **PASS**, X.AI LLC certificate, valid signature
- ACP initialize: **PASS**, protocol version `1`
- CLI-owned authentication: **PASS**
- Session creation: **PASS**, reached `idle`
- NSIS install: **UNEXECUTED**, no setup artifact or Windows Rust/NSIS build toolchain was present

Run it again with:

```text
npm run test:windows-live
```

The native Windows NSIS gate remains:

```text
npm run test:packaging-smoke
```

with `NSIS_SETUP` pointing to a real current-user installer on native Windows.
