# Phase 2 final verification — PR #7

Verified on 2026-11-18 on `feat/desktop-phase2-lyrics`, starting at `6db1072adb1811d3c25f2e134aae636584d3fc71`. Scope is Phase 2 only; no merge or Phase 3 work.

## Deployment

GitHub CLI inspection of PR #7 confirmed the current head's **Vercel SUCCESS** check and the Vercel bot's **Ready** deployment, `867wkBA7xYQJ74EA3WVe9WpsvZVG`. The bot links the [branch preview](https://gmusic-git-feat-desktop-phase2-lyrics-syte001s-projects.vercel.app). There was no failing deployment to repair at the starting head. The final pushed head must have its own successful check; the starting-head status is not a substitute.

GitHub CLI initially had no configured login. The existing repository-scoped Git Credential Manager credential authenticated subsequent read operations in process; no credential was printed, written to the repository, or passed in command-line arguments. No Vercel account settings or production deployment were changed.

## Confirmed defect and fix

Actual Tauri discovery for synthetic metadata (`Clock Check`, `Phase Two QA`, 90 seconds) displayed `lrcmux: HTTP 400`. Targeted live provider requests established the sequence:

- Exact `/get` with artist/title: **404**, `no lyrics found`.
- Compatibility search with artist/title: **200**, empty list.
- Compatibility search with title only: **400**, `provide either ISRC or both artist and title`.

Rust's unsupported title-only fallback incorrectly converted a confirmed no-result into an error, preventing negative caching. `providers.rs` now sends lrcmux only supported artist/title requests and avoids requesting it with an empty/whitespace artist. LRCLIB's title-only fallback, HTTP-error reporting, provider bounds and privacy boundaries are unchanged.

The new local HTTP regression failed before the fix with `["lrcmux: HTTP 400"]`, then passed after the fix. It checks the supported request sequence and reusable negative cache. A second regression verifies that missing artist metadata causes no unsupported lrcmux request. Tracked by `music-oda`.

## Browser attachment investigation (`music-82d`)

The historical failure belongs to ZCode's in-app browser guest lifecycle, not an established Gmusic runtime fault. Host log `C:/Users/User/.zcode/v2/logs/2026-11-18.log`, lines 56–59, records `newTab` followed by `waitForGuest timeout` and `ok=false elapsedMs=10067` at 00:10:49–00:10:59 local time, before page navigation. No guest attachment is recorded for that tab. The previously reported error was `browser guest not attached (webview not ready)`.

In this verification session, `mcp__node_repl__js` is absent from the callable tool inventory. The browser-use skill was loaded, but its required host entry point cannot be invoked. Thus the original host attachment retry and ordinary controlled-browser web/preview smoke checks could not be executed. No host settings were changed and no unsupported substitute was used to drive ZCode's browser. Delegate agents also failed to start with `provider-not-found` for their configured `account:zai-start-plan/GLM-5.3-Flash`; checks were performed directly instead.

## Actual Tauri runtime observations

This was not a browser page pretending to be desktop. The x64 `gmusic.exe` launched WebView2 154.0.4258.62, serving `http://tauri.localhost/`; a read-only runtime check confirmed `__TAURI_INTERNALS__` exists.

Preparation used a new isolated `WEBVIEW2_USER_DATA_FOLDER` under `.zcode/verification-evidence/desktop-20261118/webview-profile`. Two newly generated, low-amplitude 90-second PCM WAV tones and enhanced LRC/TXT fixtures were used. No original user audio, library, account or settings were imported, modified or deleted. All interaction used observed Windows UI Automation controls/native dialogs, not injected store actions or synthetic DOM events.

Observed behavior:

- Native audio dialog imported both WAVs. Library showed two tracks and decoded **1:30** durations.
- Playback advanced from 0:00 to 0:13 and 0:27. Pause retained 0:27 through subsequent operations; resume advanced again to 1:04.
- Now Playing navigation did not reset playback. Track switching selected the other track with a reset position; the existing previous-track action first restarts a track when sufficiently far into it.
- Enhanced LRC import displayed all five expected lines and **word sync**, without fabricated word times.
- Clicking a timed lyric line sought playback. The fixture's embedded offset was applied by parsing; the per-track user offset remained separate.
- A manual enhanced override was saved through the editor. **Manual import**, the new text and **+0.5s** remained after closing and restarting the fixed executable with the same isolated profile.
- With the WebView network disabled and `navigator.onLine === false`, the saved manual lyrics rendered and local audio continued. Native HTTP transport was launched with a non-listening loopback proxy; no system network adapter was changed.
- Read-only inspection confirmed exactly **one audio element**, `duration === 90`, `readyState === 4`, advancing real `currentTime`, and `error === null`.
- A final online retest of the rebuilt executable on the second synthetic track displayed **No reliable match found**, with native runtime marker and real audio progress verified; the erroneous `lrcmux: HTTP 400` no longer appeared.
- Offline timed-line click with the stored +500 ms offset produced **`audio.currentTime === 10.5`**, `paused === true`, and **Persistent manual line** active in the single translated lyric container. A remote-debugging connection held the network override during this action. Network emulation is connection-scoped; observations after detaching were not treated as offline evidence.

Runtime screenshots and accessibility snapshots were captured under `.zcode/verification-evidence/desktop-20261118/` and `desktop-restart-20261118/`. The first helper-window capture was invalid (16×16 Tao event window); subsequent captures targeted the actual titled Tauri window. The first two native dialog-close captures became invalid when the dialog disappeared; fresh app snapshots established the results. These invalid captures are not counted as visual evidence.

**Visual/audible limitation:** the current model's image input is unsupported; `Read` returned `Media omitted from provider request because the selected model does not support image input`. Therefore screenshots were not visually judged, and no complete GUI/visual acceptance pass is claimed. Audio element/media state was verified, but speaker output, perceptual drift and visual word highlighting require human QA.

## Lyrics coverage and web preservation

Executed deterministic suites cover native providers, malformed payloads, timeouts/HTTP failures/rate-limit cooldowns, matching/ambiguity, integer timestamps and genuine words, embedded/user offsets, versioned atomic disk cache, positive/negative TTLs, corruption/failed-write recovery, request coalescing, offline misses and positive-cache recovery. Frontend adapter/integration tests cover manual-edit precedence, latest offset preservation, cancellation/late-result safety, no negative caching of failures and the existing web fallback. Audio-clock and actual renderer-DOM regressions remain passing.

Positive native discovery and stale-positive disk recovery are covered with **local mock HTTP servers**, not a successful live known-song desktop discovery. The actual runtime exercised native discovery's failure/no-result boundary and saved manual lyrics; it did not establish a live positive-cache recovery path.

The existing web build passed without a Rust build dependency. A production preview served the shell, entry JavaScript and service worker with **HTTP 200** at `http://127.0.0.1:4173/`. This is transport/build evidence only, not proof of rendered browser behavior or PWA offline loading. Runtime-guard and web-fallback tests passed; no frontend production source was changed by this fix.

## Executed quality gates

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS, including post-fix rerun |
| `npm run lint` | PASS, including post-fix rerun |
| Initial full `npm test` concurrent with Rust builds | FAIL: 69/70 files, 916/917 tests; existing SettingsPage artwork-summary `waitFor` at line 133 |
| `npm test -- src/features/settings/SettingsPage.test.tsx` | PASS, unchanged test |
| Full `npm test` rerun without concurrent native build | PASS: 70 files, 917 tests; unchanged assertions and test selection |
| Post-fix focused frontend suite (command below) | PASS: 10 files, 105 tests |
| `npm run build` | PASS; also repeated by Tauri's before-build command |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | PASS after formatting |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | PASS after fix |
| `cargo test --manifest-path src-tauri/Cargo.toml` | PASS: 25 tests, none ignored |
| New lrcmux regression before fix | Expected FAIL: `lrcmux: HTTP 400` |
| New lrcmux regression after fix | PASS |
| `npx tauri build --debug --no-bundle --target x86_64-pc-windows-msvc` | PASS; fixed executable built and exercised |
| `npx tauri build --debug --target x86_64-pc-windows-msvc --bundles msi,nsis` | PASS; both debug installer bundles generated, not installed or signed |
| `git diff --check` | PASS |

Post-fix focused command:

```sh
npm test -- src/services/platform/lyrics.test.ts src/services/lyrics/lyricsService.native.test.ts src/services/lyrics/syncEngine.test.ts src/features/lyrics/LyricsView.test.tsx src/features/lyrics/LyricQuickEditor.test.tsx src/stores/lyricsStore.test.ts src/services/audio/engine.test.ts src/stores/playbackStore.test.ts src/app/router.test.tsx src/services/offline/offlineService.test.ts
```

The debug packaging check generated `src-tauri/target/x86_64-pc-windows-msvc/debug/bundle/msi/Gmusic_1.1.0_x64_en-US.msi` (7.66 MiB) and `bundle/nsis/Gmusic_1.1.0_x64-setup.exe` (4.83 MiB). Tauri downloaded its WiX/NSIS build tools, validated their hashes and generated both bundles. These build-tool downloads were handled by Tauri, not manually executed as fixture code. Neither installer was installed, published or signed.

The first full-suite failure remains recorded, not erased by the passing rerun. The affected file is unchanged relative to `main`; concurrent native compilation is correlated with the failure, not a proven root cause. Follow-up `music-wty` tracks deterministic stabilization. No test was skipped, no assertion weakened and no broad timeout added. Existing Node localStorage/React act diagnostic warnings were not suppressed.

## Remaining acceptance boundaries

- Original ZCode browser attachment retry: blocked by missing callable browser MCP tool; historical guest-readiness timeout documented above.
- Rendered ordinary web/Vercel preview, responsive/theme acceptance and production PWA offline reload: blocked by that browser tool and unavailable image input. HTTP 200 is not a substitute.
- Human listening, visual active-word behavior and perceived sync drift: no image input or listening capability in this session.
- Successful live known-song discovery and actual stale-positive native disk-cache recovery: no suitable known-song fixture exercised; deterministic mock-server coverage passes.
- Installer installation/uninstallation, signing and non-x64 architectures are separate release checks. Only x64 MSVC is installed. No installer was installed over the user's application.
- Worker packages were unchanged and not revalidated; unrelated security/dependency remediation and all Phase 3 work remain out of scope.

## Decision

PR #7 can be handed to **human QA with the limitations above**, once the final pushed head's Vercel check is successful. It is **not fully verified or ready for approval/merge**: visual/audible and web/PWA acceptance plus the live-positive desktop path remain outstanding. Keep `music-82d` open until those acceptance checks are completed. Do not merge or start Phase 3.
