> **Current release: 1.3.0.** No tests, syntax checks, browser checks, or OpenRouter requests were performed for the per-model Flex opt-out update. The historical record below applies only to version 1.1.0 and does not validate version 1.3.0.

> **Archive context:** The record below describes the original version 1.1.0 development archive. Its package manifest, dependencies, test fixtures, release scripts, and CI configuration are not included in this runtime repository. References to included tooling and reproduction commands apply to that earlier archive; those commands cannot be run from this checkout. Publishing this repository did not add validation or rerun the historical checks.

# OpenRouter Flex 1.1.0 — validation record

Validated on September 28, 2026, using an isolated local SillyTavern checkout and mocked OpenRouter generation/catalog traffic. No paid generation or authenticated billing lookup was made. The original supplied archive was left unchanged.

## Baseline and results

- SillyTavern: **1.19.0**, exact commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.
- Browser tooling: development-only **Playwright 1.62.1**, pinned Chromium and WebKit binaries.
- Runtime syntax, manifest assets, and version agreement: passed.
- Unit tests: **37 passed**, zero skipped.
- Actual backend serialization tests: **12 passed**, zero skipped.
- Offline browser/editor tests: **60 passed**, zero skipped.
- Real SillyTavern host tests: **12 passed**, zero skipped.
- Required integration prerequisites: missing paths correctly fail rather than skip tests.
- Packaging: strict file whitelist, runtime import checks, version agreement, ZIP CRC/directory validation, and byte-for-byte round trip. Corrupted ZIP content is rejected.

The aggregate `npm run verify:release` repeats required checks, installs the validated ZIP's actual contents into the disposable host, and runs the real-host suite against that installation. CI provisions the same pinned host and browser engines. CI configuration is included; no remote repository or CI run was published as part of this local release.

## Mobile and accessibility evidence

Both the browser fixture and actual SillyTavern host were checked at:

| Browser/target | CSS viewport |
| --- | --- |
| Desktop Chromium | 1280 × 800 |
| Small phone Chromium | 320 × 568 |
| Android-sized Chromium | 412 × 915 |
| iPhone-sized WebKit | 390 × 844 |
| Landscape Chromium | 844 × 390 |
| Landscape WebKit | 844 × 390 |

Assertions cover horizontal overflow, settings-panel buttons at least 44 pixels wide/high, reachable Save/Discard actions, profile and endpoint editing, quick controls, and real-host styles. Browser tests also check 200% enlarged text at a 300-pixel viewport height, keyboard Tab access to Save/Discard, and deterministic 200% desktop reflow using CSS zoom. This reduced-height test simulates the space constraint of an on-screen keyboard; it does not launch an operating-system keyboard.

Screenshots were visually inspected for narrow phone layouts and WebKit enlarged-text controls. An issue caused by the host's `width: min-content` button styling was corrected: action buttons now wrap between words, share rows when space allows, and stack on narrow screens. Native host drawer animation and first-run onboarding are accounted for in smoke tests.

These are headless browser-engine and viewport checks, **not physical Android or iPhone device testing**. Host viewport/zoom policy is not modified.

### Connection-button styling follow-up

The connection drawer's Flex buttons now use the host's `flex-container` and `menu_button menu_button_icon` classes without the settings panel's size overrides or mobile expansion. On September 28, 2026, the six real-host responsive editing and quick-control cases were rerun and passed. Additional browser measurements and visually inspected screenshots at desktop, 320-pixel Chromium, and 390-pixel WebKit widths confirmed the same 28-pixel height, font size, padding, margins, border, radius, and background as the native Connect button in the test theme. Both quick buttons fit within each viewport and remained functional. Runtime syntax and manifest checks also passed. The full baseline suite above was not repeated for this styling-only follow-up.

The buttons were subsequently moved directly below the OpenRouter model selector in both Chat Completion and Text Completion. The same row moves when the connection mode changes, remaining below the visible desktop Select2 control. All six real-host responsive/quick-control checks and 12 browser quick-toggle/source-state checks passed after this move. Additional measurements and screenshots verified Chat-to-Text-to-Chat switching, a single quick row below the visible selector, matching native button sizing, and no row overflow at desktop, 320-pixel Chromium, and 390-pixel WebKit widths. Runtime syntax, manifest, and package validation also passed; unrelated baseline tests were not repeated for the placement change.

## Behavior verified

- Existing settings migrate to a global default without changing the saved switch/provider order; exact model overrides route main and auxiliary requests.
- Drafts never change active routing until saved. Save, Discard, inheritance, model switching, invalid edits, and late discovery are covered.
- Public catalog metadata uses documented price/latency units. Cache failures preserve prior data; stale and unknown metadata cannot establish incompatibility.
- Native Chat and Text Completion requests retain strict provider routing after the real backend serializes them; unrelated sources and disabled routing remain unchanged.
- Response reporting recognizes returned tier evidence and JSON/SSE errors, correlates overlapping requests, preserves host response bytes/errors/abort behavior, and handles observer limits without stopping generation.
- Reporting cleanup, repeat activation, disable/re-enable, command collisions, settings cleanup, and recovery notices are covered.
- Actual host commands, controls, profile saves, source changes, website-selected-model status, and response reporting operate under SillyTavern's styles.

## Practical limits

OpenRouter availability and billing were not tested with a real paid request. Reported tier comes from response metadata; unknown means the response supplied no reliable evidence or observation ended early. A reported tier is not a cost guarantee. Later SillyTavern releases are not claimed as verified without rerunning the same suite against them.

Response observation is on by default and can be disabled separately from routing. Saved settings and diagnostics do not retain prompts or generated content. The automatic test suites use fixtures and do not establish a user's account-specific endpoint access.

## Reproduce the full release gate

Install development dependencies with `npm ci` and browsers with `npx playwright install chromium webkit`. Start the documented pinned SillyTavern checkout as a disposable localhost server, with browser auto-launch disabled. Set `ST_HOST_ROOT` and `ST_HOST_URL`, then run `npm run verify:release`; it derives all three backend source paths from the checkout.

If browsers were installed outside Playwright's default cache, also set `PLAYWRIGHT_BROWSERS_PATH` to that installation directory. The release gate fails if a browser, host, or backend prerequisite is missing. Generated reports, traces, screenshots, browser binaries, dependencies, and ZIPs are excluded from Git.
