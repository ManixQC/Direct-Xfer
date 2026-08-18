# Direct-Xfer Windows installer

The installer is built with Inno Setup 6 from `Direct-Xfer.iss` after the Windows portable package has been created.

Environment variables used by CI:
- `DX_INNO_APP_VERSION`
- `DX_INNO_SOURCE_DIR`
- `DX_INNO_OUTPUT_DIR`
- `DX_INNO_DOTNET_RUNTIME_VERSION`
- `DX_INNO_NODE_VERSION`
- `DX_INNO_NODE_EXE_SHA256`

The installer targets x64 Windows. `Direct-Xfer.exe` and `Direct-Xfer.ServerHost.exe` are .NET 10 **framework-dependent single-file** apphosts configured for `AppHostDotNetSearch=AppRelative`. The installer carries one private shared .NET 10 runtime tree under `runtime\dotnet`, assembled by CI from the matching Microsoft `dotnet-runtime` ZIP only. The launcher now uses native Win32 UI APIs, so `Microsoft.WindowsDesktop.App` is not bundled. Users do **not** need to install Microsoft .NET separately and the runtime is not duplicated between the two EXEs.

Direct-Xfer executables remain unsigned by design. The base installer **does not package Node.js, rclone or Tesseract**. During `PrepareToInstall`, Setup reuses an already valid Direct-Xfer private Node.js or a compatible x64 system Node.js. Only when Node.js is missing does Setup download the pinned Node.js 24.19.0 x64 executable directly from nodejs.org, validate its pinned SHA-256, and copy it to `{app}\runtime\node\node.exe`. When system Node.js is reused, Setup records its exact path/version/hash in `{app}\runtime\node\external-node.ini`, which ServerHost validates on every start. rclone and Tesseract remain optional per-user components downloaded only after explicit activation from the Direct-Xfer system-tray menu and stored under `%LOCALAPPDATA%\Direct-Xfer\tools`.

`[InstallDelete]` deliberately removes the historical `{app}\runtime\rclone` and `{app}\runtime\tesseract` directories during an upgrade. It intentionally does **not** delete `{app}\runtime\node`, allowing a valid Node.js already downloaded by an earlier Direct-Xfer installer to be reused without network access. This prevents old bundled copies from surviving after migration to the on-demand component model; it does not delete the current user's optional copies under `%LOCALAPPDATA%`.

Private .NET upgrades are deliberately non-destructive while `[Files]` is copied: Setup overwrites the shared runtime in place without pre-deleting `runtime\dotnet`. The explicit `runtime-build.txt` entry is installed last and immediately validates `dotnet.exe`, `hostfxr.dll`, CoreCLR/hostpolicy and the core Microsoft.NETCore.App runtime. If that validation fails, Setup raises a fatal installation error before any `[Run]` entry can start Direct-Xfer. Once the rest of installation has completed, the first ServerHost `[Run]` entry calls `ValidateAndCleanupPrivateDotNet` through `BeforeInstall`; only then are stale patch-version directories removed. This keeps the previous private runtime available throughout the replaceable/rollback-sensitive file phase while guaranteeing that both EXEs start only against a complete shared runtime.
