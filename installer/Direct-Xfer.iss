#define EnvAppVersion GetEnv("DX_INNO_APP_VERSION")
#if EnvAppVersion != ""
  #define AppVersion EnvAppVersion
#else
  #define AppVersion "1.65.5"
#endif
#define EnvSourceDir GetEnv("DX_INNO_SOURCE_DIR")
#if EnvSourceDir != ""
  #define SourceDir EnvSourceDir
#else
  #define SourceDir "..\dist\Direct-Xfer-1.65.5-Windows-CSharp"
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
  EventModifyState = $0002;
  DotNet10DesktopRuntimeUrl = 'https://dotnet.microsoft.com/en-us/download/dotnet/10.0';
function HasNet10DesktopRuntimeAt(const DotnetRoot: String): Boolean;
var
  FindRec: TFindRec;
  RuntimeRoot: String;
begin
  Result := False;
  if DotnetRoot = '' then exit;
  RuntimeRoot := AddBackslash(DotnetRoot) + 'shared\Microsoft.WindowsDesktop.App\10.*';
  if FindFirst(RuntimeRoot, FindRec) then begin
    try
      repeat
        if ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and (Pos('10.', FindRec.Name) = 1) and (Pos('-', FindRec.Name) = 0) then begin
          Result := True;
          exit;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;
function HasNet10DesktopRuntime: Boolean;
var
  DotnetRoot: String;
begin
  Result := False;
  DotnetRoot := GetEnv('DOTNET_ROOT_X64');
  if HasNet10DesktopRuntimeAt(DotnetRoot) then begin Result := True; exit; end;
  DotnetRoot := GetEnv('DOTNET_ROOT');
  if HasNet10DesktopRuntimeAt(DotnetRoot) then begin Result := True; exit; end;
  if RegQueryStringValue(HKLM64, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64', 'InstallLocation', DotnetRoot) and HasNet10DesktopRuntimeAt(DotnetRoot) then begin Result := True; exit; end;
  Result := HasNet10DesktopRuntimeAt(ExpandConstant('{pf64}\dotnet'));
end;
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
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if StopServerHostAndWait then Result := '' else Result := 'Direct-Xfer Server Host did not stop in time. Close the current Windows session or restart Windows, then run the installer again.';
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin if CurUninstallStep = usUninstall then StopServerHostAndWait; end;
procedure OfferNet10DesktopRuntimeDownload;
var
  ErrorCode: Integer;
begin
  if MsgBox(
    'Direct-Xfer requires Microsoft .NET 10 Desktop Runtime x64, but it is not installed.' + #13#10 + #13#10 +
    'Would you like to open the official Microsoft .NET 10 download page now?' + #13#10 +
    'Choose the .NET Desktop Runtime installer for Windows x64.',
    mbConfirmation, MB_YESNO) = IDYES then
  begin
    if not ShellExec('', DotNet10DesktopRuntimeUrl, '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode) then
      MsgBox('Unable to open the Microsoft download page automatically.' + #13#10 + #13#10 +
        'Open this address in your browser:' + #13#10 + DotNet10DesktopRuntimeUrl,
        mbError, MB_OK);
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := HasNet10DesktopRuntime;
  if not Result then OfferNet10DesktopRuntimeDownload;
end;
