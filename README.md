# ChaosBot Overlay (OBS plugin)

An OBS plugin that keeps a streamer's ChaosBot overlay up when ChaosBot is closed.

ChaosBot copies the overlay pages, the saved layouts, and the pictures and sounds they use into
the plugin. The plugin serves that copy on `http://127.0.0.1:5260/`, so the two browser sources
point at the plugin instead of ChaosBot:

| Source       | Address                              |
|--------------|--------------------------------------|
| Overlay      | `http://127.0.0.1:5260/`             |
| Spotify card | `http://127.0.0.1:5260/spotify/`     |

When ChaosBot runs, the pages connect to its hub on port 5051 and are live as before. When it is
closed, the Overlay source draws the last layout ChaosBot sent.

The plugin also renders a small JPEG of OBS's output (without ChaosBot's own sources) for the
editor's "Live from OBS" view. Nothing is rendered unless the editor asked in the last 2 seconds.

A dock called **Overlay** shows the two addresses and whether ChaosBot is connected.

## How ChaosBot finds it

On load the plugin writes `%LOCALAPPDATA%\ChaosBot Overlay\plugin.json`:

```json
{ "port": 5260, "token": "<random per start>", "pid": 1234, "version": "1.0.0" }
```

ChaosBot reads it, checks `GET /health`, and syncs with the token. The file is removed when OBS
exits. `CHAOSBOT_OVERLAY_DATA_DIR` moves it, for tests only.

## HTTP routes

Only `127.0.0.1:5260` and `localhost:5260` are accepted as the Host (421 otherwise).

| Route | Auth | What |
|-------|------|------|
| `GET /health` | none | `{"ok":true,"version":...}` |
| `GET /`, `/spotify/`, `/scene/*`, other files | none | the synced site |
| `GET /api/*` | none | proxied to ChaosBot on 5051; 502 when it is closed |
| `GET /mirror.jpg` | none | the latest OBS frame; 404 until one exists |
| `GET /sync/manifest` | Bearer | `{"files":{"<path>":"<sha256>"}}` |
| `PUT` / `DELETE /sync/files/<path>` | Bearer | write or remove one file |

Writes are allowed only under `index.html`, `chaos/`, `scene/`, `spotify/`, `ui/` and `overlay/`.

## Installing (Windows)

1. Close OBS.
2. Download `chaosbot-overlay-windows-x64.zip` from the
   [releases](https://github.com/shelbykb2/chaosbot-obs-overlay/releases).
3. Unzip it into your OBS folder (usually `C:\Program Files\obs-studio`), so the DLL lands in
   `obs-plugins\64bit` and the locale files in `data\obs-plugins\chaosbot-overlay`.
4. Start OBS and ChaosBot. ChaosBot finds the plugin by itself and copies the overlay over.
5. Point your browser sources at the addresses above.

Needs OBS 31 or later on Windows x64.

## Building (Windows)

Needs Visual Studio 2022 or later with the C++ workload, and CMake 3.28 or later. The preset names
Visual Studio 2026; add `-G "Visual Studio 17 2022"` to build with 2022. The first configure downloads
the OBS sources and dependencies named in `buildspec.json`.

```
cmake --preset windows-x64
cmake --build build_x64 --config Release
```

The plugin is `build_x64/Release/chaosbot-overlay.dll`. Copy it with `data/` into an OBS plugins
folder. Test with a portable OBS, never your streaming install.

## Not here yet

- The plugin's own Twitch and Spotify sign-ins (live data still comes from ChaosBot).
- Editing the overlay inside OBS.
- Switching layouts by game while ChaosBot is closed.
- An installer. The zip is unpacked by hand for now.

The build scaffolding comes from the OBS plugin template (GPL-2.0, see `LICENSE`).
