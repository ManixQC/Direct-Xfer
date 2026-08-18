#define EnvAppVersion GetEnv("DX_INNO_APP_VERSION")
#if EnvAppVersion != ""
  #define AppVersion EnvAppVersion
#else
  #define AppVersion "1.66.6"
#endif
#define EnvSourceDir GetEnv("DX_INNO_SOURCE_DIR")
#if EnvSourceDir != ""
  #define SourceDir EnvSourceDir
#else
  #define SourceDir "..\dist\Direct-Xfer-1.66.6-Windows-CSharp"
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
#define NodeDownloadUrl "https://nodejs.org/download/release/v" + NodeVersion + "/win-x64/node.exe"
#define NodeTempBaseName "direct-xfer-node-v" + NodeVersion + "-win-x64.exe"
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
; Remove old heavyweight helpers left by <=1.66.4 bundled-component builds. New optional
; rclone/Tesseract installs live per-user under %LOCALAPPDATA%\Direct-Xfer\tools.
Type: filesandordirs; Name: "{app}\runtime\app"
Type: filesandordirs; Name: "{app}\runtime\rclone"
Type: filesandordirs; Name: "{app}\runtime\tesseract"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "runtime\app\runtime-build.txt"; Flags: ignoreversion recursesubdirs createallsubdirs
; Node.js is intentionally absent from SourceDir. PrepareToInstall downloads the pinned x64
; node.exe into {tmp} only when neither a valid existing Direct-Xfer node.exe nor a compatible
; system Node.js installation can be reused. This external entry then copies that verified file.
Source: "{tmp}\{#NodeTempBaseName}"; DestDir: "{app}\runtime\node"; DestName: "node.exe"; Flags: external ignoreversion; Check: ShouldCopyDownloadedNode
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
  Scs64BitBinary = 6;
  FileAttributeReparsePoint = $0400;
var
  NodeDownloadPage: TDownloadWizardPage;
  NodeNeedsDownload: Boolean;
  NodeUsesExistingPrivate: Boolean;
  NodeUsesExternal: Boolean;
  DetectedNodePath: String;
  DetectedNodeSha256: String;
  DetectedNodeVersion: String;

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

function NodeTempPath: String;
begin
  Result := ExpandConstant('{tmp}\{#NodeTempBaseName}');
end;

function IsSupportedNodeVersion(Major, Minor, Revision: Word): Boolean;
begin
  // Windows runtime reuse is intentionally stricter than generic Node compatibility.
  // Reject EOL/odd release lines and stale security patch levels; otherwise Setup
  // downloads Direct-Xfer's pinned Node 24 LTS runtime.
  Result := ((Major = 22) and ((Minor > 23) or ((Minor = 23) and (Revision >= 2)))) or
            ((Major = 24) and ((Minor > 19) or ((Minor = 19) and (Revision >= 0)))) or
            ((Major = 26) and ((Minor > 7) or ((Minor = 7) and (Revision >= 0))));
end;

function NodeRunsAsOriginalUser(const FileName: String): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  ResultCode := -1;
  try
    // Setup runs elevated, but ServerHost is launched with the original user's token.
    // A Node executable found only in the elevation account's profile must therefore
    // never be recorded as reusable for the real Direct-Xfer user.
    Result := ExecAsOriginalUser(FileName, '--version', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) and
              (ResultCode = 0);
  except
    Log('Node.js original-user execution probe failed for ' + FileName + ': ' + GetExceptionMessage);
    Result := False;
  end;
end;

function IsCompatibleNodeFile(const FileName: String; var Version, Sha256: String): Boolean;
var
  BinaryType: Cardinal;
  Attrs: LongWord;
  Size: Int64;
  Major, Minor, Revision, Build: Word;
begin
  Result := False;
  Version := '';
  Sha256 := '';
  if (FileName = '') or (not FileExists(FileName)) then exit;
  try
    Attrs := WinGetFileAttributes(FileName);
    if (Attrs and FileAttributeReparsePoint) <> 0 then exit;
    if (not GetBinaryType(FileName, BinaryType)) or (BinaryType <> Scs64BitBinary) then exit;
    if (not FileSize64(FileName, Size)) or (Size < 1024 * 1024) or (Size > 200 * 1024 * 1024) then exit;
    if not GetVersionComponents(FileName, Major, Minor, Revision, Build) then exit;
    if not IsSupportedNodeVersion(Major, Minor, Revision) then exit;
    Version := Format('%d.%d.%d', [Major, Minor, Revision]);
    Sha256 := Lowercase(GetSHA256OfFile(FileName));
    if Length(Sha256) <> 64 then exit;
    if not NodeRunsAsOriginalUser(FileName) then begin
      Log('Ignoring Node.js candidate that the original Direct-Xfer user cannot execute: ' + FileName);
      exit;
    end;
    Result := True;
  except
    Log('Node.js validation failed for ' + FileName + ': ' + GetExceptionMessage);
    Result := False;
  end;
end;

function IsPinnedPrivateNode: Boolean;
var
  Version, Sha256: String;
begin
  Result := IsCompatibleNodeFile(PrivateNodePath, Version, Sha256) and
            (CompareText(Sha256, '{#NodeExeSha256}') = 0) and
            (CompareText(Version, '{#NodeVersion}') = 0);
end;

function TryNodeCandidate(const Candidate: String; var NodePath, NodeVersion, NodeSha256: String): Boolean;
var
  Version, Sha256: String;
begin
  Result := False;
  if Candidate = '' then exit;
  if CompareText(Candidate, PrivateNodePath) = 0 then exit;
  if not IsCompatibleNodeFile(Candidate, Version, Sha256) then exit;
  NodePath := Candidate;
  NodeVersion := Version;
  NodeSha256 := Sha256;
  Result := True;
end;

function TryExistingNodeReceipt(var NodePath, NodeVersion, NodeSha256: String): Boolean;
var
  Receipt, Candidate, ReceiptVersion, ReceiptSha, CurrentVersion, CurrentSha: String;
  ReceiptSize: Int64;
  ReceiptAttrs: LongWord;
begin
  Result := False;
  Receipt := NodeReceiptPath;
  if not FileExists(Receipt) then exit;
  ReceiptAttrs := WinGetFileAttributes(Receipt);
  if (ReceiptAttrs and FileAttributeReparsePoint) <> 0 then exit;
  if (not FileSize64(Receipt, ReceiptSize)) or (ReceiptSize <= 0) or (ReceiptSize > 16 * 1024) then exit;

  Candidate := GetIniString('node', 'path', '', Receipt);
  ReceiptVersion := GetIniString('node', 'version', '', Receipt);
  ReceiptSha := Lowercase(GetIniString('node', 'sha256', '', Receipt));
  if (Candidate = '') or (ReceiptVersion = '') or (Length(ReceiptSha) <> 64) then exit;
  if CompareText(Candidate, PrivateNodePath) = 0 then exit;
  if not IsCompatibleNodeFile(Candidate, CurrentVersion, CurrentSha) then exit;
  if (CompareText(CurrentVersion, ReceiptVersion) <> 0) or
     (CompareText(CurrentSha, ReceiptSha) <> 0) then exit;
  NodePath := Candidate;
  NodeVersion := CurrentVersion;
  NodeSha256 := CurrentSha;
  Result := True;
end;

function FindCompatibleNodeOnPath(var NodePath, NodeVersion, NodeSha256: String): Boolean;
var
  Remaining, Entry, Candidate: String;
  DelimiterPos: Integer;
begin
  Result := False;
  Remaining := GetEnv('PATH');
  while Remaining <> '' do begin
    DelimiterPos := Pos(';', Remaining);
    if DelimiterPos > 0 then begin
      Entry := Copy(Remaining, 1, DelimiterPos - 1);
      Delete(Remaining, 1, DelimiterPos);
    end else begin
      Entry := Remaining;
      Remaining := '';
    end;

    Entry := Trim(Entry);
    if (Length(Entry) >= 2) and (Entry[1] = '"') and (Entry[Length(Entry)] = '"') then
      Entry := Copy(Entry, 2, Length(Entry) - 2);
    if Entry <> '' then begin
      Candidate := AddBackslash(Entry) + 'node.exe';
      if TryNodeCandidate(Candidate, NodePath, NodeVersion, NodeSha256) then begin
        Result := True;
        exit;
      end;
    end;
  end;
end;

function FindCompatibleSystemNode(var NodePath, NodeVersion, NodeSha256: String): Boolean;
var
  Candidate, InstallPath: String;
begin
  Result := False;

  // Inspect every PATH entry, not only the first node.exe. A stale/incompatible
  // shim earlier in PATH must not force a download when another compatible Node exists.
  if FindCompatibleNodeOnPath(NodePath, NodeVersion, NodeSha256) then begin Result := True; exit; end;

  Candidate := ExpandConstant('{autopf64}\nodejs\node.exe');
  if TryNodeCandidate(Candidate, NodePath, NodeVersion, NodeSha256) then begin Result := True; exit; end;

  Candidate := ExpandConstant('{localappdata}\Programs\nodejs\node.exe');
  if TryNodeCandidate(Candidate, NodePath, NodeVersion, NodeSha256) then begin Result := True; exit; end;

  InstallPath := '';
  if RegQueryStringValue(HKCU, 'SOFTWARE\Node.js', 'InstallPath', InstallPath) then begin
    Candidate := AddBackslash(InstallPath) + 'node.exe';
    if TryNodeCandidate(Candidate, NodePath, NodeVersion, NodeSha256) then begin Result := True; exit; end;
  end;

  InstallPath := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', InstallPath) then begin
    Candidate := AddBackslash(InstallPath) + 'node.exe';
    if TryNodeCandidate(Candidate, NodePath, NodeVersion, NodeSha256) then begin Result := True; exit; end;
  end;
end;

procedure ResetNodePlan;
begin
  NodeNeedsDownload := False;
  NodeUsesExistingPrivate := False;
  NodeUsesExternal := False;
  DetectedNodePath := '';
  DetectedNodeSha256 := '';
  DetectedNodeVersion := '';
end;

function PrepareNodeRuntime: String;
begin
  Result := '';
  ResetNodePlan;

  if IsPinnedPrivateNode then begin
    NodeUsesExistingPrivate := True;
    Log('Reusing existing Direct-Xfer Node.js {#NodeVersion}: ' + PrivateNodePath);
    exit;
  end;

  if TryExistingNodeReceipt(DetectedNodePath, DetectedNodeVersion, DetectedNodeSha256) then begin
    NodeUsesExternal := True;
    Log('Reusing previously validated external Node.js ' + DetectedNodeVersion + ': ' + DetectedNodePath);
    exit;
  end;

  if FindCompatibleSystemNode(DetectedNodePath, DetectedNodeVersion, DetectedNodeSha256) then begin
    NodeUsesExternal := True;
    Log('Reusing compatible system Node.js ' + DetectedNodeVersion + ': ' + DetectedNodePath);
    exit;
  end;

  NodeNeedsDownload := True;
  try
    Log('No compatible x64 Node.js installation found. Downloading pinned Node.js {#NodeVersion}.');
    NodeDownloadPage.Clear;
    NodeDownloadPage.Add('{#NodeDownloadUrl}', '{#NodeTempBaseName}', '{#NodeExeSha256}');
    NodeDownloadPage.Show;
    try
      NodeDownloadPage.Download;
    finally
      NodeDownloadPage.Hide;
    end;
    if (not FileExists(NodeTempPath)) or
       (CompareText(Lowercase(GetSHA256OfFile(NodeTempPath)), '{#NodeExeSha256}') <> 0) then
      RaiseException('The downloaded Node.js file failed its SHA-256 verification.');
  except
    Result := 'Node.js is required by Direct-Xfer and no compatible local installation was found. ' +
              'The verified Node.js {#NodeVersion} download failed: ' + GetExceptionMessage;
  end;
end;

function ShouldCopyDownloadedNode: Boolean;
begin
  Result := NodeNeedsDownload;
end;

procedure WriteExternalNodeReceipt;
var
  Receipt: String;
begin
  Receipt := NodeReceiptPath;
  ForceDirectories(NodeRoot);
  if not SetIniString('node', 'path', DetectedNodePath, Receipt) then
    RaiseException('Could not write the Direct-Xfer external Node.js path receipt.');
  if not SetIniString('node', 'version', DetectedNodeVersion, Receipt) then
    RaiseException('Could not write the Direct-Xfer external Node.js version receipt.');
  if not SetIniString('node', 'sha256', Lowercase(DetectedNodeSha256), Receipt) then
    RaiseException('Could not write the Direct-Xfer external Node.js integrity receipt.');
end;

procedure FinalizeAndValidateNodeRuntime;
var
  CurrentVersion, CurrentSha: String;
begin
  if NodeNeedsDownload then begin
    if not IsPinnedPrivateNode then
      RaiseException('The pinned Node.js runtime is missing or invalid after installation.');
    DeleteFile(NodeReceiptPath);
    Log('Installed verified Direct-Xfer Node.js {#NodeVersion} on demand.');
    exit;
  end;

  if NodeUsesExistingPrivate then begin
    if not IsPinnedPrivateNode then
      RaiseException('The existing Direct-Xfer Node.js runtime became invalid during installation.');
    DeleteFile(NodeReceiptPath);
    exit;
  end;

  if NodeUsesExternal then begin
    if not IsCompatibleNodeFile(DetectedNodePath, CurrentVersion, CurrentSha) or
       (CompareText(CurrentVersion, DetectedNodeVersion) <> 0) or
       (CompareText(CurrentSha, DetectedNodeSha256) <> 0) then
      RaiseException('The compatible system Node.js installation changed during Direct-Xfer setup.');

    // A stale private node.exe must not shadow the validated external runtime.
    if FileExists(PrivateNodePath) and (not IsPinnedPrivateNode) then begin
      if DeleteFile(PrivateNodePath) then
        Log('Removed stale Direct-Xfer private node.exe before using system Node.js.')
      else
        RaiseException('Could not remove stale Direct-Xfer private node.exe.');
    end;
    WriteExternalNodeReceipt;
    exit;
  end;

  RaiseException('Direct-Xfer setup has no valid Node.js runtime plan.');
end;

procedure InitializeWizard;
begin
  NodeDownloadPage := CreateDownloadPage(
    'Downloading Node.js',
    'Direct-Xfer requires Node.js. It is downloaded only because no compatible x64 Node.js installation was found.',
    nil);
  NodeDownloadPage.ShowBaseNameInsteadOfUrl := True;
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
  Result := PrepareNodeRuntime;
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin if CurUninstallStep = usUninstall then StopServerHostAndWait; end;
