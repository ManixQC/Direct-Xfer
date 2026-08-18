#define EnvAppVersion GetEnv("DX_INNO_APP_VERSION")
#if EnvAppVersion != ""
  #define AppVersion EnvAppVersion
#else
  #define AppVersion "1.66.3"
#endif
#define EnvSourceDir GetEnv("DX_INNO_SOURCE_DIR")
#if EnvSourceDir != ""
  #define SourceDir EnvSourceDir
#else
  #define SourceDir "..\dist\Direct-Xfer-1.66.3-Windows-CSharp"
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
Type: filesandordirs; Name: "{app}\runtime\app"
Type: filesandordirs; Name: "{app}\runtime\node"
Type: filesandordirs; Name: "{app}\runtime\rclone"
Type: filesandordirs; Name: "{app}\runtime\tesseract"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "runtime\app\runtime-build.txt"; Flags: ignoreversion recursesubdirs createallsubdirs
; Runtime marker is copied explicitly because dot/marker-style files are too important to rely on wildcard packaging semantics.
Source: "{#SourceDir}\runtime\app\runtime-build.txt"; DestDir: "{app}\runtime\app"; DestName: "runtime-build.txt"; Flags: ignoreversion; AfterInstall: ValidateInstalledPrivateDotNet

[Icons]
Name: "{autoprograms}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"
Name: "{userstartup}\Direct-Xfer Server Host"; Filename: "{app}\Direct-Xfer.ServerHost.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\Direct-Xfer"; Filename: "{app}\{#AppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Direct-Xfer.ServerHost.exe"; WorkingDir: "{app}"; Flags: nowait runasoriginaluser; BeforeInstall: ValidateAndCleanupPrivateDotNet
Filename: "{app}\{#AppExeName}"; Description: "Launch Direct-Xfer"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: PrivateDotNetVersionIsComplete

[Code]
const
  EventModifyState = $0002;
function OpenEvent(dwDesiredAccess: LongWord; bInheritHandle: Boolean; lpName: string): THandle;
  external 'OpenEventW@kernel32.dll stdcall';
function SetEvent(hEvent: THandle): Boolean;
  external 'SetEvent@kernel32.dll stdcall';
function CloseHandle(hObject: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
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

function PrivateDotNetVersionIsComplete: Boolean;
var Root, Version: String;
begin
  Root := ExpandConstant('{app}\runtime\dotnet');
  Version := '{#DotNetRuntimeVersion}';
  Result := FileExists(Root + '\dotnet.exe') and
            FileExists(Root + '\host\fxr\' + Version + '\hostfxr.dll') and
            FileExists(Root + '\shared\Microsoft.NETCore.App\' + Version + '\coreclr.dll') and
            FileExists(Root + '\shared\Microsoft.NETCore.App\' + Version + '\hostpolicy.dll') and
            FileExists(Root + '\shared\Microsoft.WindowsDesktop.App\' + Version + '\System.Windows.Forms.dll');
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
  CleanupOldDotNetVersionsIn(Root + '\shared\Microsoft.WindowsDesktop.App', Version);
end;

procedure ValidateAndCleanupPrivateDotNet;
begin
  ValidateInstalledPrivateDotNet;
  CleanupOldPrivateDotNetVersions;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if StopServerHostAndWait then Result := '' else Result := 'Direct-Xfer Server Host did not stop in time. Close the current Windows session or restart Windows, then run the installer again.';
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin if CurUninstallStep = usUninstall then StopServerHostAndWait; end;
