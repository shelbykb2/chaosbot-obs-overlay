# Windows installer

The Windows release is `ChaosBot-OBS-Overlay-Setup.exe`. It installs the OBS plugin and its bundled editor, overlay pages, locale files, and self-contained runtime. No .NET runtime or manual archive extraction is needed.

Setup asks you to select the OBS folder containing `bin\64bit\obs64.exe` and reads its version before choosing a plugin layout. OBS Studio 33 and later uses the current Windows layout under `%ProgramData%\obs-studio\plugins\chaosbot-overlay`: the plugin DLL sits directly in that folder and its files are under `data`. OBS Studio 31 and 32 use the older `bin\64bit` DLL layout in the same plugin folder. Setup needs administrator permission to write to `%ProgramData%`.

To use portable OBS, select **Install into a portable OBS installation** during setup and choose the OBS root folder. Setup checks that `<folder>\bin\64bit\obs64.exe` exists and reads its version before continuing. OBS 33 and later uses `<folder>\plugins\chaosbot-overlay\chaosbot-overlay.dll` with its files under that plugin's `data` folder. OBS 31 and 32 use the legacy DLL path `<folder>\obs-plugins\64bit` and plugin data path `<folder>\data\obs-plugins\chaosbot-overlay`.

Close OBS before installing or uninstalling. Setup asks Windows to close `obs64.exe` so the plugin DLL can be replaced. Upgrades replace files owned by the installer. The plugin keeps its saved site and configuration in OBS's plugin configuration folder, outside the install directory, so uninstalling the plugin leaves that data intact.

## Build the installer

Use Windows 64-bit with Visual Studio 2022 or later and the C++ workload, its bundled CMake, .NET 10 SDK, Node.js, and Inno Setup 6. The build fetches OBS's pinned build dependencies on its first CMake configure.

```powershell
./tools/Build-Installer.ps1
```

The script builds the native OBS plugin, runs `npm ci` and the UI production build, publishes the .NET runtime self-contained for `win-x64`, checks the complete package layout, and compiles the installer. The resulting file is `package\installer-output\ChaosBot-OBS-Overlay-Setup.exe`.

To sign the native plugin DLL, runtime executable and app assembly, and installer with the configured Azure Artifact Signing account, use `./tools/Build-Installer.ps1 -Sign`. The signing helper uses `DefaultAzureCredential` and verifies each Authenticode signature and RFC 3161 timestamp before proceeding.

CI runs the UI and runtime tests, builds an unsigned validation installer, and uploads it as a build artifact. Tag release publishing refuses unsigned installers; a signed release build must be supplied before publishing. Existing release assets are never overwritten.

Close OBS before setup or uninstall. The plugin and its runtime hold an application mutex while running, so setup and uninstall refuse to replace or remove a running plugin. Portable setup keeps its uninstaller in `<OBS folder>\chaosbot-overlay-setup`; layouts remain in OBS's plugin configuration directory.
