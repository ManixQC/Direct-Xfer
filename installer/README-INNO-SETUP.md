# Direct-Xfer Windows installer

The installer is built with Inno Setup 6 from `Direct-Xfer.iss` after the Windows portable package has been created.

Environment variables used by CI:
- `DX_INNO_APP_VERSION`
- `DX_INNO_SOURCE_DIR`
- `DX_INNO_OUTPUT_DIR`
- `DX_INNO_DOTNET_RUNTIME_VERSION`
- `DX_INNO_NODE_VERSION`
- `DX_INNO_NODE_EXE_SHA256`

The installer is multilingual: it always presents an initial language selector for **Français, English and Español**, defaults to the current Windows UI language when possible, and localizes the wizard, Direct-Xfer task labels, launch text, common fatal validation errors, and the privacy information page.

The installer targets x64 Windows. `Direct-Xfer.exe` and `Direct-Xfer.ServerHost.exe` are .NET 10 **framework-dependent single-file** apphosts configured for `AppHostDotNetSearch=AppRelative`. The installer carries one private shared .NET 10 runtime tree under `runtime\dotnet`, assembled by CI from the matching Microsoft `dotnet-runtime` ZIP only. The launcher now uses native Win32 UI APIs, so `Microsoft.WindowsDesktop.App` is not bundled. Users do **not** need to install Microsoft .NET separately and the runtime is not duplicated between the two EXEs.

Direct-Xfer executables remain unsigned by design. The Windows payload **bundles the pinned Node.js 24.19.0 x64 executable** under `{app}\runtime\node\node.exe`. GitHub Actions downloads Node during the build, verifies its pinned SHA-256 and exact version, and then packages it into the installer. Setup itself performs no Node.js network download and no system-Node discovery. rclone and Tesseract remain optional per-user components downloaded only after explicit activation from the Direct-Xfer system-tray menu and stored under `%LOCALAPPDATA%\Direct-Xfer\tools`.

`[InstallDelete]` deliberately removes the historical `{app}\runtime\rclone` and `{app}\runtime\tesseract` directories during an upgrade and removes the obsolete `{app}\runtime\node\external-node.ini` receipt used by the former on-demand Node architecture. The current bundled `{app}\runtime\node\node.exe` is installed from the verified GitHub Actions payload. Optional copies under `%LOCALAPPDATA%` are not removed.

Private .NET upgrades are deliberately non-destructive while `[Files]` is copied: Setup overwrites the shared runtime in place without pre-deleting `runtime\dotnet`. The explicit `runtime-build.txt` entry is installed last and immediately validates `dotnet.exe`, `hostfxr.dll`, CoreCLR/hostpolicy and the core Microsoft.NETCore.App runtime. If that validation fails, Setup raises a fatal installation error before any `[Run]` entry can start Direct-Xfer. Once the rest of installation has completed, the first ServerHost `[Run]` entry calls `ValidateAndCleanupPrivateDotNet` through `BeforeInstall`; only then are stale patch-version directories removed. This keeps the previous private runtime available throughout the replaceable/rollback-sensitive file phase while guaranteeing that both EXEs start only against a complete shared runtime.
