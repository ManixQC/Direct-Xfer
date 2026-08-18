# Direct-Xfer Windows installer

The installer is built with Inno Setup 6 from `Direct-Xfer.iss` after the Windows portable package has been created.

Environment variables used by CI:
- `DX_INNO_APP_VERSION`
- `DX_INNO_SOURCE_DIR`
- `DX_INNO_OUTPUT_DIR`

The installer targets x64 Windows. `Direct-Xfer.exe` and `Direct-Xfer.ServerHost.exe` are .NET 10 **self-contained single-file** applications, so users do **not** need to install the Microsoft .NET 10 Desktop Runtime separately.

Direct-Xfer executables remain unsigned by design. The installer also packages the pinned Node.js runtime, rclone and Tesseract runtime assembled by GitHub Actions.
