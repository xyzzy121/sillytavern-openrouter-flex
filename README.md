# OpenRouter Flex for SillyTavern

Version **1.3.0** automatically uses Flex for models that advertise compatible Flex endpoints, with an option to disable Flex for individual models. It supports SillyTavern's native **Chat Completion → OpenRouter** and **Text Completion → OpenRouter** connections, with model-specific endpoint preferences, a public endpoint catalog, and request diagnostics.

Requires **SillyTavern 1.19.0 or later**. The historical automated compatibility baseline is commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127` (1.19.0). **No testing was performed for version 1.3.0, including syntax checks, automated tests, browser checks, or OpenRouter requests.** Earlier validation results do not validate this update. Runtime installation needs no build, npm installation, server plugin, core patch, or additional API key.

## Install

1. Open **Extensions → Install extension** and enter `https://github.com/xyzzy121/sillytavern-openrouter-flex`.
2. Install the extension, reload SillyTavern, select a native OpenRouter connection, and open **Extensions → OpenRouter Flex**.
3. Select a specific model. Flex applies automatically when OpenRouter advertises Flex endpoints for it; models without advertised Flex endpoints retain normal routing.
4. To exclude this model, uncheck **Use Flex when available for this model** below the model selector or in the Flex panel. This saves immediately. Optionally adjust endpoint preferences in the panel, then **Save preferences**.

For a manual installation, download the repository ZIP, extract it, rename its extension folder to `sillytavern-openrouter-flex`, and copy that folder into `SillyTavern/data/<your-user-handle>/extensions/`. A usual single-user location is `SillyTavern/data/default-user/extensions/sillytavern-openrouter-flex/`. Confirm `manifest.json` is directly inside the folder, alongside the four JavaScript modules and `style.css`.

For all users, install under `SillyTavern/public/scripts/extensions/third-party/sillytavern-openrouter-flex/` instead. Use only one installation location. Docker installations must use a persisted data directory or mounted folder.

## Automatic routing and model profiles

While the extension is loaded, each native OpenRouter request whose exact model ID is enabled is checked against its model's advertised Flex endpoints. Models are enabled by default; enabling a model never forces Flex when it has no advertised Flex endpoints. A disabled model's request is left unchanged, without a new catalog lookup. There is no hardcoded list of supported models. Saved endpoint profiles control preference order:

- **Current model** edits that exact model ID's preferred provider order. It initially inherits global defaults. Uncheck **Use global defaults for this model** to customize its list, or use the discovered endpoints.
- **Global defaults** edits the preferences used by models without an override.
- Saved slugs that overlap the advertised Flex endpoints come first, in saved order. All other advertised Flex endpoints follow. Preferences are not an allowlist: an old profile cannot exclude a newly supported Flex endpoint or force an unsupported endpoint.
- Chat and Text Completion share the same profiles and model opt-outs. Routing uses each outgoing request's model, including auxiliary generations, rather than assuming the visible model selector identifies every request.
- Model IDs with `:floor` or `:nitro` have separate profiles and opt-outs. Disabling one exact ID does not disable its other variants. Discovery uses their base model's shared catalog.
- Website-selected and automatic models retain normal routing because the concrete model is not known locally.

Existing settings migrate automatically to schema version 4. Saved global and model preferences and the reporting preference are retained. The new `disabledModels` array stores unique, concrete, exact model IDs; an absent list defaults to empty, so existing models remain enabled. The obsolete global `enabled` flag is still removed and does not become a global or per-model opt-out. Invalid stored endpoint lists recover to default preferences with a notice. An invalid disabled-model list recovers to an empty list with a notice; invalid entries are removed while valid opt-outs remain.

Default preferences are `openai/flex`, `google-ai-studio/flex`, `google-vertex/global/flex`, and `google-vertex/flex`, in that order. Only exact slugs ending in `/flex` are accepted; regional variants are supported. A saved preference list must contain 1–32 entries, each at most 200 characters. Eligibility still comes from the model catalog.

## Saved settings versus drafts

The panel shows the saved preferences separately from the editor and automatic routing status. Selecting, reordering, typing, and **Restore defaults** modify a draft only. **Save preferences** applies it; **Discard changes** reloads the saved configuration. Invalid input cannot replace the active settings.

**Use Flex when available for this model** is separate from endpoint drafts and always controls the currently selected concrete OpenRouter model, even while editing global endpoint defaults. Changing it saves immediately and synchronizes the connection and panel controls. It neither saves nor discards pending endpoint edits. Disabling Flex preserves that model's saved endpoint order, inheritance, and reporting preference; enabling it again resumes automatic compatibility checks with those preferences.

Unsaved drafts are kept separately for each editing target while the page remains open. Switching models does not save a draft into another model. Reloading, disabling, or cleaning the extension discards drafts. Restoring defaults in a model profile returns its draft to global inheritance; restoring global defaults prepares the built-in endpoint list. Both require Save.

Discovery refreshes available choices and metadata without changing drafts. Late responses cannot replace newer edits. **Prefer discovered endpoints** explicitly copies discovered candidates into the draft, and still requires Save.

## Endpoint catalog and warnings

Model and connection changes prefetch public endpoint data for enabled models even when the panel is closed. Disabled models skip automatic, request-time, and explicit refresh lookups. Successful results, including models with no Flex endpoints, are cached for 30 minutes. The first request for an enabled, uncached or stale model waits for discovery when a lookup is allowed. UI and generation lookups share the cache and in-flight request, and there is no idle polling. **Refresh endpoints** requests an explicit refresh for an enabled model subject to the same limits. The editor shows provider, exact slug, recognizable region, input/output USD pricing per million tokens, recent median latency, and uptime where supplied. Missing values are shown as unknown. Move up/down buttons set preference order; an Advanced section retains manual slug editing.

Catalog requests are unauthenticated and send only the model ID. They omit credentials and referrer information; no prompts or API keys are sent. Lookups time out after 15 seconds. Closing the panel, editing a draft, or changing models does not cancel a shared lookup; disabling the extension does. Failed refreshes retain prior display data marked stale, but an unavailable or failed request-time lookup leaves that generation's normal routing unchanged.

Disabling one model retains cached metadata and does not cancel an already pending shared lookup, which may also serve an enabled `:floor` or `:nitro` variant. A pending lookup can finish and cache its result, but Flex is not applied if the request's exact model ID is disabled when the lookup completes. No later lookup starts on behalf of that disabled model. Changing the model opt-out does not cancel a generation already sent to the server.

Metadata lookups use these limits to avoid repeated queries:

- Explicit refreshes for one model are spaced at least 60 seconds apart.
- A failed lookup pauses retries for that model for five minutes; repeated failures double the pause up to 30 minutes.
- At most 10 metadata requests start in any one-minute window across models.
- HTTP 429 or 503 pauses metadata requests across models for at least five minutes, honoring a longer `Retry-After` response.

These caches, counters, and cooldowns are local to each loaded page; separate tabs do not share them. Refresh actions do not bypass backoff or the request cap. Cooldowns do not schedule background retries: later model changes, explicit refreshes, or generations can request discovery after the pause. Normal routing continues when current compatibility cannot be established.

The panel reports when a model has no advertised Flex endpoints and flags a quantization filter that demonstrably excludes all advertised Flex endpoints. Incomplete/stale metadata is labeled unverified. Public availability does not prove your account has access. Warnings do not change filters.

## Status and commands

The connection drawer shows automatic Flex status, **Use Flex when available for this model**, and **Flex settings** below the OpenRouter model selector in both Chat Completion and Text Completion. **Flex settings** opens the detailed panel, which has the same model control. The controls reflect one saved opt-out for the current exact model ID and are unavailable without a native OpenRouter connection and a concrete model. Disabled models report that Flex is disabled for that model, rather than reporting unavailable or unverified compatibility.

```text
/flex status
/flex refresh
/flex on
/flex off
/flex toggle
```

`/flex` with no argument shows status. `/flex refresh` refreshes discovery for the current enabled model; a disabled model reports its status without querying the catalog. `on`, `off`, and `toggle` immediately save the current concrete model's opt-out, shared between Chat and Text Completion. `on` restores automatic eligibility; it cannot force an incompatible model onto Flex. These actions require a native OpenRouter connection and a concrete model and never change a global routing switch. The canonical command is `/openrouter-flex`; it remains available if another extension already owns `/flex`. Commands never save or discard unsaved endpoint edits.

## Requested routing and reported tier

Response reporting is **on by default** and can be turned off under **Request reporting** if another extension conflicts with it. It observes only existing native OpenRouter generation responses. It makes no additional generation or billing lookup requests.

Each request records its model, outgoing provider list, requested routing, outcome, elapsed time, returned tier, and available provider/model/generation ID. The latest 20 requests are kept in memory for this page session, newest started first. A returned generation ID can be selected and copied; OpenRouter Activity is linked for verification.

**Requested Flex does not prove served Flex.** Reported tier is Flex, Default, Priority, or Unknown based only on response metadata. HTTP success alone does not confirm a tier or bill. A failed/cancelled request is labeled separately; missing metadata or incomplete observation stays unknown. A non-Flex returned tier or changed outgoing routing produces a warning.

SillyTavern 1.19 does not expose raw response metadata through a response event. The extension therefore uses a narrowly scoped fetch observer, preserving the original response, stream, errors, and cancellation. JSON and SSE responses are supported. No prompts, generated content, complete responses, or raw upstream error messages are retained in history. Inspection stops after 30 minutes, 32 MiB, or an SSE event larger than 256 KiB. These limits stop observation only, never the host generation. Disabling reporting also leaves running generations intact.

## Routing behavior

- When an enabled model advertises Flex endpoints, the outgoing provider order contains those endpoints, with saved overlapping preferences first. Provider fallback is disabled, and Chat Completion model fallback is disabled for that request.
- When the exact model ID is disabled, there are no advertised Flex endpoints, the model is not concrete, or discovery fails, the extension leaves the request unchanged. This preserves provider, tier, and fallback fields supplied by the host or another extension. Unsupported models therefore use the host's normal routing automatically.
- Saved host provider order, model choice, API keys, fallback settings, and presets are not edited. The extension stores its endpoint preferences separately. Disabling the extension restores the host settings' normal effect on every subsequent request.
- Unrelated APIs, Custom connections pointed at OpenRouter, and direct API calls made outside the native generation routes are unaffected.
- Streaming, non-streaming, swipes, continuations, and auxiliary requests using the completion hooks receive the same routing. Separate image and embedding APIs are outside scope.
- Existing quantization filters remain in effect. Once a request has been routed to advertised Flex endpoints, failure to serve that request does not trigger a retry on ordinary endpoints.

SillyTavern 1.19 drops a raw `service_tier` field during backend serialization. For eligible requests, the extension also supplies a nonempty provider list, forwarded as `provider.order` with `provider.allow_fallbacks: false`; those tier-specific slugs perform the routing. It adds `service_tier: "flex"` for backends that forward it. It does not depend on the `:floor` variant, which can also select standard endpoints.

OpenRouter bills the tier actually served; a provider may internally serve a request at another tier. No discount percentage or final charge is guaranteed, and this extension does not rewrite SillyTavern's price estimates. Inspect OpenRouter Activity to verify actual cost.

## Mobile and accessibility

The panel uses SillyTavern's native extension drawer, chevrons, menu buttons, checkbox labels, and theme styling. Endpoint cards stack on small screens, buttons wrap, and identifiers break across lines. Endpoint ordering uses buttons rather than drag-only gestures. Controls support keyboard focus and labeled inputs, and status updates do not announce every generated token.

Earlier automated layout validation covered Chromium and WebKit at several phone and desktop sizes. Any included validation report describes that earlier release, not this local update or physical Android/iPhone testing.

## Disable, cleanup, and troubleshooting

Disabling the extension in Manage Extensions removes listeners, the quick controls, commands, and response observation. It cancels discovery and clears transient drafts, catalog data, and history but retains saved settings. Re-enabling resumes automatic routing with the saved preferences and model opt-outs. This differs from disabling Flex for one model, which preserves drafts, cached metadata, diagnostics, and the extension's other controls.

**Manage Extensions → Clean extension data** uses SillyTavern's confirmation and deletes only this extension's saved settings and transient data. A later activation uses automatic routing with default preferences. Deleting without choosing cleanup retains settings.

If requests fail, check the automatic routing status, model, catalog freshness, account restrictions, and quantization filter. If the visible tier is unknown, consult OpenRouter Activity; do not infer Flex from request settings. For extension conflicts, disable response reporting first, then examine other request-routing extensions. A listener running later can change request routing, which the observer can report but cannot prevent.

For eligible Flex requests, native browser generation payloads should contain a nonempty `provider` array of `/flex` slugs and `allow_fallbacks: false`; Chat Completion also has `use_fallback: false`. The server-to-OpenRouter payload must contain the equivalent nested provider object. Browser payloads alone do not prove backend forwarding.

## Development and validation

This repository contains the runtime extension, documentation, and license. It does not include a package manifest, development dependencies, test fixtures, release scripts, or a CI workflow. The earlier development archive's npm commands cannot be run from this checkout.

**No tests, syntax checks, browser checks, or OpenRouter requests were performed for version 1.3.0.** Historical coverage does not establish that the new per-model controls work correctly.

`VALIDATION.md` preserves the version 1.1.0 archive's historical validation record. That archive used Node.js and pinned Playwright tooling, a pinned disposable SillyTavern host, and mocked generation/catalog traffic. Its reported coverage included migration, profiles, routing, catalog metadata/cache/cancellation, response inspection, editor lifecycle and drafts, commands, responsive layouts, and backend serialization. The tooling and CI configuration described in that record are not included in this repository.

Manual installation needs only the runtime files, documentation, and license in one correctly named extension folder. No dependencies, host checkouts, browser downloads, generated reports, credentials, or temporary profiles are included.

## References

- [OpenRouter service tiers](https://openrouter.ai/docs/guides/features/service-tiers)
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Model endpoint metadata](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model)
- [SillyTavern extension development](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [Verified host source](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127)

MIT licensed; see `LICENSE`.
