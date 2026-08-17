# Direct-Xfer Windows installer

The installer is built with Inno Setup 6 from `Direct-Xfer.iss` after the Windows portable package has been created.

Environment variables used by CI:
- `DX_INNO_APP_VERSION`
- `DX_INNO_SOURCE_DIR`
- `DX_INNO_OUTPUT_DIR`

The installer targets x64 Windows and requires .NET Framework 4.8. Direct-Xfer executables remain unsigned by design.
