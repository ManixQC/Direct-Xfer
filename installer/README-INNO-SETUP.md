# Direct-Xfer Windows installer

The installer is built with Inno Setup 6 from `Direct-Xfer.iss` after the Windows portable package has been created.

Environment variables used by CI:
- `DX_INNO_APP_VERSION`
- `DX_INNO_SOURCE_DIR`
- `DX_INNO_OUTPUT_DIR`
- `DX_INNO_DOTNET_RUNTIME_VERSION`

The installer targets x64 Windows. `Direct-Xfer.exe` and `Direct-Xfer.ServerHost.exe` are .NET 10 **framework-dependent single-file** apphosts configured for `AppHostDotNetSearch=AppRelative`. The installer carries one private shared .NET 10 Desktop Runtime under `runtime\dotnet`, so users do **not** need to install Microsoft .NET separately and the runtime is not duplicated between the two EXEs.

Direct-Xfer executables remain unsigned by design. The installer also packages the pinned Node.js runtime, rclone and Tesseract runtime assembled by GitHub Actions.

Private .NET upgrades are deliberately non-destructive while `[Files]` is copied: Setup overwrites the shared runtime in place without pre-deleting `runtime\dotnet`. The explicit `runtime-build.txt` entry is installed last and immediately validates `dotnet.exe`, `hostfxr.dll`, CoreCLR/hostpolicy and the WinForms runtime. If that validation fails, Setup raises a fatal installation error before any `[Run]` entry can start Direct-Xfer. Once the rest of installation has completed, the first ServerHost `[Run]` entry calls `ValidateAndCleanupPrivateDotNet` through `BeforeInstall`; only then are stale patch-version directories removed. This keeps the previous private runtime available throughout the replaceable/rollback-sensitive file phase while guaranteeing that both EXEs start only against a complete shared runtime.
