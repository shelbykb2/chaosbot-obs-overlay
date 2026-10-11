# Validation of the local Windows installer

Validated on October 10, 2026 with OBS Studio 32.2.2 in an isolated portable installation. The normal streaming OBS installation was not used for plugin testing.

- Native Release build, TypeScript check and production UI build passed.
- All 69 frontend checks passed. Runtime checks covered feed contracts, expiry/refresh, event deduplication, goals, audio bands and gating, layout validation, asset sniffing, Windows credential encryption, hosted Pro gating and BYOK request contracts.
- The related ChaosBot integration passed all 38 focused ObsPluginLink tests, including revision conflicts, recovery files and media transfer.
- Installed HTTP/SignalR checks verified editor authentication, Origin/Host rejection, bearer authorization, revision conflicts, saved layouts, uploads and alert delivery.
- A browser source rendered the installed layout in OBS. Captured OBS output contained the text and countdown; the editor's mirror excluded the overlay browser source. Editing a coordinate remained stable through live preview refreshes and persisted after restarting OBS.
- Twitch accepted a device authorization request using the newly registered public plugin client ID. This check did not authorize a user's account.
- The installer and its native/runtime payloads have valid Azure Authenticode signatures and timestamps. Portable installation kept its uninstaller within the OBS test folder. Running-plugin mutex protection was observed. Uninstall removed installed program files, preserved saved layouts byte-for-byte and requested no Windows restart.

Signed 1.1.0-beta.1 installer SHA-256: `2083E5A75ACAD5943A9E6B731A9B5084349F237CF78600E07894738493D19C5B`.

Live Spotify, authorized Twitch event delivery and paid model calls require the respective user's accounts. Those account-based flows were not exercised end-to-end; token/provider contracts were tested with controlled HTTP responses. OBS 33+ folder routing is implemented but was not tested with an installed OBS 33 build. Beta setup and uninstall were also verified with DisplayVersion 1.1.0-beta.1. The separate desktop integration remains a review PR; no desktop feed promotion was performed.

## Audit fixes after beta.1

- All 71 frontend checks and the production TypeScript/Vite build passed. Retained feed tests cover multiple goal IDs, late-mounted chat, moderation, bounded history and disposal.
- Runtime checks cover the live chat envelope, Twitch chat-clear subscription, timeout target, short startup retry, expiry refresh between periodic validations, and manual layout selection until the next game change.
- `node tools/Test-RuntimeBoundary.mjs` launches a temporary runtime and verifies actual WebSocket upgrades and SignalR negotiation: local origins work, foreign origins receive HTTP 403. It also runs in CI.
- The real editor created a second layout, made it live, deleted it and saved the remaining layout with a valid active ID. This used a temporary runtime without installing the plugin into OBS.
- The related desktop integration passed 82 focused sync, scene-store and scene-switch checks, including an edit made during media download, atomic conditional replacement, media upload order and failed-upload retry.
- The full desktop test suite passed all 3,175 tests with no skips.

These checks validate source changes after the published beta.1 installer. They do not re-sign, publish or install an updated beta, and do not exercise authorized Twitch or Spotify accounts.
