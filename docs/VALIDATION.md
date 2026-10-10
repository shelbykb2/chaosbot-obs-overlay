# Validation of the local Windows installer

Validated on October 10, 2026 with OBS Studio 32.2.2 in an isolated portable installation. The normal streaming OBS installation was not used for plugin testing.

- Native Release build, TypeScript check and production UI build passed.
- All 69 frontend checks passed. Runtime checks covered feed contracts, expiry/refresh, event deduplication, goals, audio bands and gating, layout validation, asset sniffing, Windows credential encryption, hosted Pro gating and BYOK request contracts.
- The related ChaosBot integration passed all 38 focused ObsPluginLink tests, including revision conflicts, recovery files and media transfer.
- Installed HTTP/SignalR checks verified editor authentication, Origin/Host rejection, bearer authorization, revision conflicts, saved layouts, uploads and alert delivery.
- A browser source rendered the installed layout in OBS. Captured OBS output contained the text and countdown; the editor's mirror excluded the overlay browser source. Editing a coordinate remained stable through live preview refreshes and persisted after restarting OBS.
- Twitch accepted a device authorization request using the newly registered public plugin client ID. This check did not authorize a user's account.
- The installer and its native/runtime payloads have valid Azure Authenticode signatures and timestamps. Portable installation kept its uninstaller within the OBS test folder. Running-plugin mutex protection was observed. Uninstall removed installed program files, preserved saved layouts byte-for-byte and requested no Windows restart.

Final local installer SHA-256: `E2D0538B1780B2C0D90EE146D117EBD9FC60BDFA5B3CA25287FEA27DCEACF88F`.

Live Spotify, authorized Twitch event delivery and paid model calls require the respective user's accounts. Those account-based flows were not exercised end-to-end; token/provider contracts were tested with controlled HTTP responses. OBS 33+ folder routing is implemented but was not tested with an installed OBS 33 build. The source PR is reviewable; no public release or desktop feed promotion was performed.
