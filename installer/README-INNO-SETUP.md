# Direct-Xfer Windows installer

The installer is built with Inno Setup 6 from `Direct-Xfer.iss` after the Windows portable package has been created.

Environment variables used by CI:
- `DX_INNO_APP_VERSION`
- `DX_INNO_SOURCE_DIR`
- `DX_INNO_OUTPUT_DIR`
- `DX_INNO_DOTNET_RUNTIME_VERSION`

The installer targets x64 Windows. `Direct-Xfer.exe` and `Direct-Xfer.ServerHost.exe` are .NET 10 **framework-dependent single-file** apphosts configured for `AppHostDotNetSearch=AppRelative`. The installer carries one private shared .NET 10 runtime tree under `runtime\dotnet`, assembled by CI from the matching Microsoft `dotnet-runtime` and `windowsdesktop-runtime` ZIPs. Users do **not** need to install Microsoft .NET separately and the runtime is not duplicated between the two EXEs.

Direct-Xfer executables remain unsigned by design. The base installer packages the pinned Node.js runtime but **does not package rclone or Tesseract**. Those two heavyweight helpers are optional per-user components downloaded only after explicit activation from the Direct-Xfer system-tray menu. They are stored under `%LOCALAPPDATA%\Direct-Xfer\tools` rather than `{app}`, so upgrading Direct-Xfer does not redownload an already activated component.

`[InstallDelete]` deliberately removes the historical `{app}\runtime\rclone` and `{app}\runtime\tesseract` directories during an upgrade. This prevents old bundled copies from surviving after migration to the on-demand component model; it does not delete the current user's optional copies under `%LOCALAPPDATA%`.

Private .NET upgrades are deliberately non-destructive while `[Files]` is copied: Setup overwrites the shared runtime in place without pre-deleting `runtime\dotnet`. The explicit `runtime-build.txt` entry is installed last and immediately validates `dotnet.exe`, `hostfxr.dll`, CoreCLR/hostpolicy and the WinForms runtime. If that validation fails, Setup raises a fatal installation error before any `[Run]` entry can start Direct-Xfer. Once the rest of installation has completed, the first ServerHost `[Run]` entry calls `ValidateAndCleanupPrivateDotNet` through `BeforeInstall`; only then are stale patch-version directories removed. This keeps the previous private runtime available throughout the replaceable/rollback-sensitive file phase while guaranteeing that both EXEs start only against a complete shared runtime.
