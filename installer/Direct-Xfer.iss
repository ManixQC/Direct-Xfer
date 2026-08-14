#ifndef AppVersion
  #define AppVersion "1.58.4"
#endif

#ifndef SourceDir
  #define SourceDir "..\dist\Direct-Xfer-1.58.4-Windows-CSharp"
#endif

#ifndef OutputDir
  #define OutputDir "..\dist\installer"
#endif

#define AppName "Direct-Xfer"
#define AppPublisher "Direct-Xfer"
#define AppExeName "Direct-Xfer.exe"
#define AppId "{{DEBC77E6-A8DD-5E45-8389-F6158219D839}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Direct-Xfer Windows Installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
DefaultDirName={autopf64}\Direct-Xfer
DefaultGroupName=Direct-Xfer
DisableProgramGroupPage=yes
DisableDirPage=auto
OutputDir={#OutputDir}
OutputBaseFilename=Direct-Xfer-Setup-{#AppVersion}
SetupIconFile=..\windows-launcher\direct-xfer.ico
UninstallDisplayIcon={app}\{#AppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
CloseApplications=yes
RestartApplications=no
AppMutex=Local\DirectXferLauncherInstance
UsePreviousAppDir=yes
SetupLogging=yes
Uninstallable=yes
CreateUninstallRegKey=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch Direct-Xfer"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
const
  Net48Release = 528040;

function HasNetFramework48OrLater: Boolean;
var
  ReleaseValue: Cardinal;
begin
  Result := RegQueryDWordValue(
    HKLM64,
    'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full',
    'Release',
    ReleaseValue
  ) and (ReleaseValue >= Net48Release);
end;

function InitializeSetup: Boolean;
begin
  Result := HasNetFramework48OrLater;
  if not Result then
  begin
    MsgBox(
      'Direct-Xfer requires Microsoft .NET Framework 4.8 or later. ' +
      'Install the approved Microsoft .NET Framework package, then run this installer again.',
      mbError,
      MB_OK
    );
  end;
end;
