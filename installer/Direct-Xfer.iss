#define EnvAppVersion GetEnv("DX_INNO_APP_VERSION")
#if EnvAppVersion != ""
  #define AppVersion EnvAppVersion
#else
  #define AppVersion "1.71.34"
#endif
#define EnvSourceDir GetEnv("DX_INNO_SOURCE_DIR")
#if EnvSourceDir != ""
  #define SourceDir EnvSourceDir
#else
  #define SourceDir "..\dist\Direct-Xfer-1.71.34-Windows-CSharp"
#endif
#define EnvOutputDir GetEnv("DX_INNO_OUTPUT_DIR")
#if EnvOutputDir != ""
  #define OutputDir EnvOutputDir
#else
  #define OutputDir "..\dist\installer"
#endif
#define EnvDotNetRuntimeVersion GetEnv("DX_INNO_DOTNET_RUNTIME_VERSION")
#if EnvDotNetRuntimeVersion != ""
  #define DotNetRuntimeVersion EnvDotNetRuntimeVersion
#else
  #define DotNetRuntimeVersion "10.0.11"
#endif
#define EnvNodeVersion GetEnv("DX_INNO_NODE_VERSION")
#if EnvNodeVersion != ""
  #define NodeVersion EnvNodeVersion
#else
  #define NodeVersion "24.19.0"
#endif
#define EnvNodeExeSha256 GetEnv("DX_INNO_NODE_EXE_SHA256")
#if EnvNodeExeSha256 != ""
  #define NodeExeSha256 EnvNodeExeSha256
#else
  #define NodeExeSha256 "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237"
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
AppPublisherURL=https://github.com/ManixQC/Direct-Xfer
AppSupportURL=https://github.com/ManixQC/Direct-Xfer/issues
AppUpdatesURL=https://github.com/ManixQC/Direct-Xfer/releases
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoCopyright=Copyright © Direct-Xfer 2026
VersionInfoDescription=Direct-Xfer Windows Installer
VersionInfoOriginalFileName=Direct-Xfer-Setup-{#AppVersion}.exe
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
InfoBeforeFile=..\PRIVACY.md

[Tasks]
Name: "autostart"; Description: "Start Direct-Xfer automatically with Windows"; GroupDescription: "Installation options:"
Name: "updatecheck"; Description: "Allow automatic update checks (contacts Docker Hub)"; GroupDescription: "Privacy and network options:"
Name: "publicip"; Description: "Allow public IP discovery at startup (contacts public IP services)"; GroupDescription: "Privacy and network options:"
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[InstallDelete]
; Remove old heavyweight helpers left by <=1.66.4 bundled-component builds. New optional
; rclone/Tesseract installs live per-user under %LOCALAPPDATA%\Direct-Xfer\tools.
Type: filesandordirs; Name: "{app}\runtime\app"
Type: filesandordirs; Name: "{app}\runtime\rclone"
Type: filesandordirs; Name: "{app}\runtime\tesseract"
; Retire the external-Node receipt used by the short-lived on-demand installer architecture.
Type: files; Name: "{app}\runtime\node\external-node.ini"
; Re-evaluate privacy choices on every install/upgrade. The selected marker is consumed by the server after it is durably applied to settings.
Type: files; Name: "{localappdata}\Direct-Xfer\install-update-check-enable.flag"
Type: files; Name: "{localappdata}\Direct-Xfer\install-update-check-disable.flag"
Type: files; Name: "{localappdata}\Direct-Xfer\install-public-ip-enable.flag"
Type: files; Name: "{localappdata}\Direct-Xfer\install-public-ip-disable.flag"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "runtime\app\runtime-build.txt"; Flags: ignoreversion recursesubdirs createallsubdirs
; Node.js is bundled in SourceDir\runtime\node\node.exe by GitHub Actions. Setup performs
; no Node.js download and always installs the pinned private runtime.
; Runtime marker is copied explicitly because dot/marker-style files are too important to rely on wildcard packaging semantics.
Source: "{#SourceDir}\runtime\app\runtime-build.txt"; DestDir: "{app}\runtime\app"; DestName: "runtime-build.txt"; Flags: ignoreversion; AfterInstall: ValidateInstalledPrivateDotNet
; These one-shot markers communicate the installer privacy choices to the first server launch.
Source: "install-preference.flag"; DestDir: "{localappdata}\Direct-Xfer"; DestName: "install-update-check-enable.flag"; Flags: ignoreversion; Check: UpdateCheckSelected
Source: "install-preference.flag"; DestDir: "{localappdata}\Direct-Xfer"; DestName: "install-update-check-disable.flag"; Flags: ignoreversion; Check: UpdateCheckDisabled
Source: "install-preference.flag"; DestDir: "{localappdata}\Direct-Xfer"; DestName: "install-public-ip-enable.flag"; Flags: ignoreversion; Check: PublicIpSelected
Source: "install-preference.flag"; DestDir: "{localappdata}\Direct-Xfer"; DestName: "install-public-ip-disable.flag"; Flags: ignoreversion; Check: PublicIpDisabled

[Icons]
Name: "{autoprograms}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{userstartup}\Direct-Xfer Server Host"; Filename: "{app}\Direct-Xfer.ServerHost.exe"; WorkingDir: "{app}"; Tasks: autostart
Name: "{autodesktop}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Direct-Xfer.ServerHost.exe"; WorkingDir: "{app}"; Flags: nowait runasoriginaluser; BeforeInstall: ValidateAndCleanupPrivateDotNet
Filename: "{app}\{#AppExeName}"; Description: "Launch Direct-Xfer"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: PrivateDotNetVersionIsComplete

[Code]
const
  EventModifyState = $0002;
  Scs64BitBinary = 6;
  FileAttributeReparsePoint = $0400;

function UpdateCheckSelected: Boolean;
begin Result := WizardIsTaskSelected('updatecheck'); end;
function UpdateCheckDisabled: Boolean;
begin Result := not WizardIsTaskSelected('updatecheck'); end;
function PublicIpSelected: Boolean;
begin Result := WizardIsTaskSelected('publicip'); end;
function PublicIpDisabled: Boolean;
begin Result := not WizardIsTaskSelected('publicip'); end;

function OpenEvent(dwDesiredAccess: LongWord; bInheritHandle: Boolean; lpName: string): THandle;
  external 'OpenEventW@kernel32.dll stdcall';
function SetEvent(hEvent: THandle): Boolean;
  external 'SetEvent@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function GetBinaryType(lpApplicationName: string; var lpBinaryType: Cardinal): Boolean;
  external 'GetBinaryTypeW@kernel32.dll stdcall';
function WinGetFileAttributes(lpFileName: string): LongWord;
  external 'GetFileAttributesW@kernel32.dll stdcall';

procedure SignalServerHostStop;
var StopEvent: THandle;
begin
  StopEvent := OpenEvent(EventModifyState, False, 'Local\DirectXferServerHostStop');
  if StopEvent <> 0 then begin SetEvent(StopEvent); CloseHandle(StopEvent); end;
end;
function StopServerHostAndWait: Boolean;
var I: Integer;
begin
  SignalServerHostStop;
  for I := 0 to 100 do begin
    if not CheckForMutexes('Local\DirectXferServerHostInstance') then begin Result := True; exit; end;
    if (I mod 10) = 0 then SignalServerHostStop;
    Sleep(100);
  end;
  Result := not CheckForMutexes('Local\DirectXferServerHostInstance');
end;

function NodeRoot: String;
begin
  Result := ExpandConstant('{app}\runtime\node');
end;

function PrivateNodePath: String;
begin
  Result := NodeRoot + '\node.exe';
end;

function NodeReceiptPath: String;
begin
  Result := NodeRoot + '\external-node.ini';
end;

function NodeRunsAsOriginalUser(const FileName: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  ResultCode := -1;
  try
    // ServerHost runs under the original user's token, so validate that the bundled
    // executable is actually launchable by that user before Setup starts Direct-Xfer.
    Result := ExecAsOriginalUser(FileName, '--version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and
              (ResultCode = 0);
  except
    Log('Bundled Node.js original-user execution probe failed for ' + FileName + ': ' + GetExceptionMessage);
    Result := False;
  end;
end;

function IsPinnedPrivateNode: Boolean;
var
  BinaryType: Cardinal;
  Attrs: LongWord;
  Size: Int64;
  Major, Minor, Revision, Build: Word;
  Version, Sha256: String;
begin
  Result := False;
  if not FileExists(PrivateNodePath) then exit;
  try
    Attrs := WinGetFileAttributes(PrivateNodePath);
    if (Attrs and FileAttributeReparsePoint) <> 0 then exit;
    if (not GetBinaryType(PrivateNodePath, BinaryType)) or (BinaryType <> Scs64BitBinary) then exit;
    if (not FileSize64(PrivateNodePath, Size)) or (Size < 1024 * 1024) or (Size > 200 * 1024 * 1024) then exit;
    if not GetVersionComponents(PrivateNodePath, Major, Minor, Revision, Build) then exit;
    Version := Format('%d.%d.%d', [Major, Minor, Revision]);
    if CompareText(Version, '{#NodeVersion}') <> 0 then exit;
    Sha256 := Lowercase(GetSHA256OfFile(PrivateNodePath));
    if CompareText(Sha256, '{#NodeExeSha256}') <> 0 then exit;
    if not NodeRunsAsOriginalUser(PrivateNodePath) then exit;
    Result := True;
  except
    Log('Bundled Node.js validation failed: ' + GetExceptionMessage);
    Result := False;
  end;
end;

procedure FinalizeAndValidateNodeRuntime;
begin
  if not IsPinnedPrivateNode then
    RaiseException('The bundled Node.js {#NodeVersion} runtime is missing, corrupt, wrong-architecture, or cannot be executed by the Direct-Xfer user. Re-run the installer and check antivirus/quarantine logs.');
  // Old 1.66.5-1.67.1 on-demand builds could leave an external-node receipt behind.
  // The bundled runtime is authoritative again, so remove that obsolete fallback record.
  DeleteFile(NodeReceiptPath);
  Log('Validated bundled Direct-Xfer Node.js {#NodeVersion}.');
end;

function PrivateDotNetVersionIsComplete: Boolean;
var Root, Version: String;
begin
  Root := ExpandConstant('{app}\runtime\dotnet');
  Version := '{#DotNetRuntimeVersion}';
  Result := FileExists(Root + '\dotnet.exe') and
            FileExists(Root + '\host\fxr\' + Version + '\hostfxr.dll') and
            FileExists(Root + '\shared\Microsoft.NETCore.App\' + Version + '\coreclr.dll') and
            FileExists(Root + '\shared\Microsoft.NETCore.App\' + Version + '\hostpolicy.dll');
end;

procedure ValidateInstalledPrivateDotNet;
begin
  if not PrivateDotNetVersionIsComplete then
    RaiseException('The bundled private .NET runtime is incomplete after installation. Direct-Xfer was not started. Re-run the installer and check antivirus/quarantine logs if the problem persists.');
end;

procedure CleanupOldDotNetVersionsIn(const BaseDir, KeepVersion: String);
var
  FindRec: TFindRec;
  EntryPath: String;
begin
  if not DirExists(BaseDir) then exit;
  if FindFirst(AddBackslash(BaseDir) + '*', FindRec) then begin
    try
      repeat
        if ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and
           (FindRec.Name <> '.') and (FindRec.Name <> '..') and
           (CompareText(FindRec.Name, KeepVersion) <> 0) then begin
          EntryPath := AddBackslash(BaseDir) + FindRec.Name;
          if DelTree(EntryPath, True, True, True) then
            Log('Removed stale private .NET runtime directory: ' + EntryPath)
          else
            Log('Could not remove stale private .NET runtime directory: ' + EntryPath);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

procedure CleanupOldPrivateDotNetVersions;
var Root, Version: String;
begin
  if not PrivateDotNetVersionIsComplete then begin
    Log('Skipping private .NET cleanup because the newly installed runtime is incomplete.');
    exit;
  end;
  Root := ExpandConstant('{app}\runtime\dotnet');
  Version := '{#DotNetRuntimeVersion}';
  CleanupOldDotNetVersionsIn(Root + '\host\fxr', Version);
  CleanupOldDotNetVersionsIn(Root + '\shared\Microsoft.NETCore.App', Version);
  if DirExists(Root + '\shared\Microsoft.WindowsDesktop.App') then begin
    if DelTree(Root + '\shared\Microsoft.WindowsDesktop.App', True, True, True) then
      Log('Removed retired Microsoft.WindowsDesktop.App runtime tree.')
    else
      Log('Could not remove retired Microsoft.WindowsDesktop.App runtime tree.');
  end;
end;

procedure ValidateAndCleanupPrivateDotNet;
begin
  ValidateInstalledPrivateDotNet;
  CleanupOldPrivateDotNetVersions;
  FinalizeAndValidateNodeRuntime;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if not StopServerHostAndWait then begin
    Result := 'Direct-Xfer Server Host did not stop in time. Close the current Windows session or restart Windows, then run the installer again.';
    exit;
  end;
  Result := '';
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin if CurUninstallStep = usUninstall then StopServerHostAndWait; end;
