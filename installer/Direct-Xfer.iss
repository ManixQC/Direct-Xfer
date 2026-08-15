#define EnvAppVersion GetEnv("DX_INNO_APP_VERSION")
#if EnvAppVersion != ""
  #define AppVersion EnvAppVersion
#else
  #define AppVersion "1.59.5"
#endif

#define EnvSourceDir GetEnv("DX_INNO_SOURCE_DIR")
#if EnvSourceDir != ""
  #define SourceDir EnvSourceDir
#else
  #define SourceDir "..\dist\Direct-Xfer-1.59.5-Windows-CSharp"
#endif

#define EnvOutputDir GetEnv("DX_INNO_OUTPUT_DIR")
#if EnvOutputDir != ""
  #define OutputDir EnvOutputDir
#else
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

[InstallDelete]
; Runtime trees are immutable build artifacts. Purge them before an upgrade so
; removed dependencies/assets from an older release cannot survive beside 1.59.5.
Type: filesandordirs; Name: "{app}\runtime\app"
Type: filesandordirs; Name: "{app}\runtime\node"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{userstartup}\Direct-Xfer Server Host"; Filename: "{app}\Direct-Xfer.ServerHost.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Direct-Xfer.ServerHost.exe"; WorkingDir: "{app}"; Flags: nowait runasoriginaluser
Filename: "{app}\{#AppExeName}"; Description: "Launch Direct-Xfer"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runasoriginaluser

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

const
  EventModifyState = $0002;

function OpenEvent(dwDesiredAccess: LongWord; bInheritHandle: Boolean; lpName: string): THandle;
  external 'OpenEventW@kernel32.dll stdcall';
function SetEvent(hEvent: THandle): Boolean;
  external 'SetEvent@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

procedure SignalServerHostStop;
var
  StopEvent: THandle;
begin
  StopEvent := OpenEvent(EventModifyState, False, 'Local\DirectXferServerHostStop');
  if StopEvent <> 0 then
  begin
    SetEvent(StopEvent);
    CloseHandle(StopEvent);
  end;
end;

function StopServerHostAndWait: Boolean;
var
  I: Integer;
begin
  SignalServerHostStop;
  for I := 0 to 100 do
  begin
    if not CheckForMutexes('Local\DirectXferServerHostInstance') then
    begin
      Result := True;
      exit;
    end;
    if (I mod 10) = 0 then SignalServerHostStop;
    Sleep(100);
  end;
  Result := not CheckForMutexes('Local\DirectXferServerHostInstance');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if StopServerHostAndWait then
    Result := ''
  else
    Result := 'Direct-Xfer Server Host did not stop in time. Close the current Windows session or restart Windows, then run the installer again.';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then StopServerHostAndWait;
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
