#define AppName "ChaosBot OBS Overlay"
#ifndef AppVersion
  #define AppVersion "1.1.0"
#endif
#define AppPublisher "ChaosBot"
#define AppURL "https://github.com/shelbykb2/chaosbot-obs-overlay"

[Setup]
AppId={{7D11C2BD-EC5F-4E23-9F15-9083B847B6B9}
AppName={#AppName}
AppMutex=ChaosBotOBSOverlayRunning
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
DefaultDirName={commonappdata}\obs-studio\plugins\chaosbot-overlay
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
MinVersion=10.0
CloseApplications=yes
CloseApplicationsFilter=*.exe,*.dll
RestartApplications=no
OutputDir=output
OutputBaseFilename=ChaosBot-OBS-Overlay-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} installer
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}

[Tasks]
Name: "portableobs"; Description: "Install into a portable OBS installation"; GroupDescription: "Installation location:"; Flags: unchecked

[Files]
Source: "..\package\installer-stage\bin\64bit\chaosbot-overlay.dll"; DestDir: "{code:GetPluginBinaryDir}"; Flags: ignoreversion
Source: "..\package\installer-stage\data\locale\*"; DestDir: "{code:GetPluginDataDir}\locale"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\package\installer-stage\data\site\*"; DestDir: "{code:GetPluginDataDir}\site"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\package\installer-stage\data\runtime\*"; DestDir: "{code:GetPluginDataDir}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\LICENSE"; DestDir: "{code:GetPluginDataDir}\licenses"; Flags: ignoreversion
Source: "..\third_party\NOTICE.md"; DestDir: "{code:GetPluginDataDir}\licenses"; Flags: ignoreversion
Source: "..\third_party\*.txt"; DestDir: "{code:GetPluginDataDir}\licenses"; Flags: ignoreversion

[Code]
var
  ObsRootPage: TInputDirWizardPage;
  ObsMajorVersion: Cardinal;
  LastPortableChoice: Boolean;
  CommandLineObsRoot: String;

function IsPortableInstall: Boolean;
begin
  Result := WizardIsTaskSelected('portableobs');
end;

function DefaultObsRoot: String;
var
  Root: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OBS Studio_is1', 'InstallLocation', Root) and (Root <> '') then
    Result := Root;
  if (Result = '') and RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\OBS Studio_is1', 'InstallLocation', Root) and (Root <> '') then
    Result := Root;
  if (Result = '') and RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OBS Studio_is1', 'InstallLocation', Root) and (Root <> '') then
    Result := Root;
  if (Result = '') then begin
    Root := ExpandConstant('{pf}\obs-studio');
    if FileExists(Root + '\bin\64bit\obs64.exe') then Result := Root;
  end;
end;

function SelectedObsRoot: String;
begin
  if CommandLineObsRoot <> '' then
    Result := RemoveBackslashUnlessRoot(CommandLineObsRoot)
  else
    Result := RemoveBackslashUnlessRoot(ObsRootPage.Values[0]);
end;

function GetPluginBinaryDir(Param: String): String;
begin
  if IsPortableInstall then begin
    if ObsMajorVersion >= 33 then
      Result := SelectedObsRoot + '\plugins\chaosbot-overlay'
    else
      Result := SelectedObsRoot + '\obs-plugins\64bit';
  end else if ObsMajorVersion >= 33 then
    Result := ExpandConstant('{commonappdata}\obs-studio\plugins\chaosbot-overlay')
  else
    Result := ExpandConstant('{commonappdata}\obs-studio\plugins\chaosbot-overlay\bin\64bit');
end;

function GetPluginDataDir(Param: String): String;
begin
  if IsPortableInstall then begin
    if ObsMajorVersion >= 33 then
      Result := SelectedObsRoot + '\plugins\chaosbot-overlay\data'
    else
      Result := SelectedObsRoot + '\data\obs-plugins\chaosbot-overlay';
  end else
    Result := ExpandConstant('{commonappdata}\obs-studio\plugins\chaosbot-overlay\data');
end;

procedure InitializeWizard;
begin
  ObsRootPage := CreateInputDirPage(wpSelectTasks,
    'OBS Studio location', 'Choose the OBS Studio folder',
    'Select the folder containing bin\64bit\obs64.exe. Setup uses this OBS version and install type to choose the plugin layout.', False, '');
  ObsRootPage.Add('OBS Studio folder:');
  ObsRootPage.Values[0] := DefaultObsRoot;
  if CommandLineObsRoot <> '' then
    ObsRootPage.Values[0] := CommandLineObsRoot;
  if ObsRootPage.Values[0] = '' then
    ObsRootPage.Values[0] := ExpandConstant('{userdocs}\OBS Portable');
  LastPortableChoice := False;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = ObsRootPage.ID) and (LastPortableChoice <> IsPortableInstall) then begin
    if IsPortableInstall then
      ObsRootPage.Values[0] := ExpandConstant('{userdocs}\OBS Portable')
    else begin
      ObsRootPage.Values[0] := DefaultObsRoot;
      if ObsRootPage.Values[0] = '' then
        ObsRootPage.Values[0] := ExpandConstant('{userdocs}\OBS Portable');
    end;
    LastPortableChoice := IsPortableInstall;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
end;

function DetectSelectedObsVersion(var ErrorMessage: String): Boolean; forward;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ErrorMessage: String;
begin
  Result := True;
  if CurPageID = ObsRootPage.ID then
    Result := DetectSelectedObsVersion(ErrorMessage);
  if not Result then
    MsgBox(ErrorMessage, mbError, MB_OK);
end;

function DetectSelectedObsVersion(var ErrorMessage: String): Boolean;
var
  ObsExe, Root: String;
  VersionMS, VersionLS: Cardinal;
begin
  Result := False;
  Root := SelectedObsRoot;
  ObsExe := Root + '\bin\64bit\obs64.exe';
  if not FileExists(ObsExe) then begin
    ErrorMessage := 'This folder is not an OBS installation. Select the folder containing bin\64bit\obs64.exe.';
    exit;
  end;
  if not GetVersionNumbers(ObsExe, VersionMS, VersionLS) then begin
    ErrorMessage := 'Setup could not read the OBS version from obs64.exe.';
    exit;
  end;
  ObsMajorVersion := VersionMS shr 16;
  if ObsMajorVersion < 31 then begin
    ErrorMessage := 'ChaosBot Overlay requires OBS Studio 31 or later.';
    exit;
  end;
  Result := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ErrorMessage: String;
begin
  if not IsAdminInstallMode and not IsPortableInstall then
    Result := 'A standard OBS installation writes to the shared ProgramData plugin folder and requires administrator mode. Select the portable OBS task to install into a portable OBS folder.'
  else if not DetectSelectedObsVersion(ErrorMessage) then
    Result := ErrorMessage
  else begin
    if IsPortableInstall then
      WizardForm.DirEdit.Text := SelectedObsRoot + '\chaosbot-overlay-setup'
    else
      WizardForm.DirEdit.Text := ExpandConstant('{commonappdata}\obs-studio\plugins\chaosbot-overlay');
    Result := '';
  end;
end;

function GetObsRootParameter: String;
var
  I: Integer;
  Parameter: String;
begin
  Result := '';
  for I := 1 to ParamCount do begin
    Parameter := ParamStr(I);
    if CompareText(Copy(Parameter, 1, 9), '/OBSROOT=') = 0 then begin
      Result := Copy(Parameter, 10, Length(Parameter));
      if (Length(Result) >= 2) and (Copy(Result, 1, 1) = '"') and (Copy(Result, Length(Result), 1) = '"') then
        Result := Copy(Result, 2, Length(Result) - 2);
      exit;
    end;
  end;
end;

function InitializeSetup: Boolean;
begin
  CommandLineObsRoot := GetObsRootParameter;
  Result := True;
  if IsWin64 = False then begin
    MsgBox('ChaosBot OBS Overlay requires 64-bit Windows and 64-bit OBS 31 or later.', mbError, MB_OK);
    Result := False;
  end;
end;
