# ChaosBot OBS Overlay

A free, open-source overlay creator for OBS Studio on Windows. Create and save layouts directly in the **Overlay** dock. The editor and live overlays run with OBS; ChaosBot is optional.

The editor includes text, pictures, shapes, webcam frames, countdowns, Twitch chat, alerts and goals, Spotify cards and an audio visualizer. Use multiple scenes and game-based switching, and position elements against a live preview of OBS. Imported ChaosBot layouts retain their saved data; bot-control and mascot features belong to ChaosBot.

## Install

Build or obtain `ChaosBot-OBS-Overlay-Setup.exe`, close OBS and run it. Setup supports standard and portable installations of OBS 31 or later on 64-bit Windows. It bundles the local runtime, so users do not need to install .NET or extract a ZIP. Open **Docks → Overlay**, then add these OBS browser sources:

| Source | URL |
| --- | --- |
| Full overlay | `http://127.0.0.1:5260/` |
| Spotify card | `http://127.0.0.1:5260/spotify/` |

The plugin owns its layouts and media in OBS's plugin configuration directory. Uninstalling removes installed program files and preserves those layouts. See [installer details](docs/INSTALLER.md).

## Connections and generation

Open **Connections** in the editor. Twitch sign-in uses the bundled public app and device authorization; users do not need a client secret or their own app registration. An advanced client ID override supports forks. The public registration is `r0se55c0m8ba1fsmp6iewuq8md6l2b`; [Twitch documents device authorization here](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow).

Spotify requires your Spotify app's client ID and the redirect URI `http://127.0.0.1:5261/auth/spotify/callback`. Authorization uses PKCE without a client secret. Provider account and application restrictions still apply.

**Describe an overlay** supports either ChaosBot account sign-in with Pro access, or your own OpenAI, Anthropic, Gemini or compatible-provider API key. Generated layouts appear as a draft before you apply them. Provider keys and connection tokens are encrypted for the current Windows account and excluded from layouts. Usage follows the selected provider's billing and limits.

## Connect ChaosBot

ChaosBot discovers `%LOCALAPPDATA%\ChaosBot Overlay\plugin.json` while OBS is running and syncs authenticated requests to port 5260. The compatible desktop integration shares edits in both directions and copies referenced media. Concurrent local edits are saved in ChaosBot's `overlay-conflicts` directory before loading the plugin's latest document. Older desktop versions can send their legacy overlay cache; modern synchronization takes precedence. Closing ChaosBot leaves the standalone overlay and connections available in OBS.

Discovery includes `port`, `token`, `pid`, `version`, `standalone` and `runtimePort`. The token changes each OBS start. `CHAOSBOT_OVERLAY_DATA_DIR` changes the discovery directory for isolated tests.

## Development

Prerequisites: Visual Studio 2022 or later with C++, .NET 10, Node.js 22.12+ and Inno Setup 6. OBS dependency versions are pinned in `buildspec.json`.

```powershell
./tools/Build-Installer.ps1
# Azure Artifact Signing, with the configured signing account:
./tools/Build-Installer.ps1 -Sign
```

Output: `package/installer-output/ChaosBot-OBS-Overlay-Setup.exe`. The signature helper verifies Authenticode and a timestamp. CI builds an installer artifact; publishing a release requires an explicit version tag. Test with a separate portable OBS installation.

```powershell
dotnet run --project runtime-tests/OverlayRuntime.Tests.csproj -c Release
cd overlay-ui
npm ci
npm test
npm run build
```

The native server is restricted to loopback and serves overlay pages on 5260. The runtime uses 5261; editor requests require a per-start authentication cookie, and scene synchronization requires a bearer token and revision match. OBS preview captures exclude this plugin's browser sources and run only while requested by the editor.

GPL-2.0; see [LICENSE](LICENSE) and [third-party notices](third_party/NOTICE.md).
