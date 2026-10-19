import { SETTINGS_KEY, DEFAULT_PROVIDERS, applyFlexRouting, normalizeSettings, parseProviders, resolveProviders, resolveAutomaticProviders, concreteModel, isFlexEnabled, getSettingsWarnings, configurationWarnings } from './flex.js';
import { createCatalog } from './catalog.js';
import { createResponseObserver } from './diagnostics.js';

const PANEL_ID = 'openrouter_flex_settings';
let active = false, context, panel, quick, command, visibilityObserver;
let wasVisible = false;
let editScope = 'model', lastModel, feedback = '', recovery = [], commandWarning = '', lastRequested = '';
let lookupRevision = 0, lookupPending = false;
let activationEpoch = 0;
const drafts = new Map();
const listeners = [];
const catalog = createCatalog();
const observer = createResponseObserver({ getSettings: settings, getExpectedProviders: expectedProviders, onChange: () => renderRequests() });

function current() { return SillyTavern.getContext(); }
function settings() { return normalizeSettings(current().extensionSettings[SETTINGS_KEY]); }
function save(value) {
    const host = current();
    host.extensionSettings[SETTINGS_KEY] = normalizeSettings(value);
    host.saveSettingsDebounced();
}
function connection() {
    const host = current();
    if (host.mainApi === 'openai' && host.chatCompletionSettings?.chat_completion_source === 'openrouter') {
        return { openrouter: true, model: host.getChatCompletionModel(host.chatCompletionSettings) || '', quantizations: host.chatCompletionSettings.openrouter_quantizations || [] };
    }
    if (host.mainApi === 'textgenerationwebui' && host.textCompletionSettings?.type === 'openrouter') {
        return { openrouter: true, model: host.textCompletionSettings.openrouter_model || '', quantizations: host.textCompletionSettings.openrouter_quantizations || [] };
    }
    return { openrouter: false, model: '', quantizations: [] };
}
function expectedProviders(request) {
    const cached = catalog.get(request.model);
    return active && cached && !cached.stale ? resolveAutomaticProviders(settings(), request.model, cached.endpoints) : [];
}
function routingStatus() {
    const { model, openrouter } = connection();
    if (!openrouter) return { label: 'Flex: OpenRouter only', message: 'Automatic Flex applies to native OpenRouter connections.', providers: [] };
    if (!concreteModel(model)) return { label: 'Flex: Model unknown', message: 'Normal routing: select a specific model so Flex support can be determined.', providers: [] };
    if (!isFlexEnabled(settings(), model)) return { label: 'Flex: Disabled for this model', message: 'Flex is disabled for this model. Normal OpenRouter routing is used without endpoint lookups.', providers: [] };
    const cached = catalog.get(model);
    if (!cached || cached.stale) return {
        label: lookupPending ? 'Flex: Checking…' : 'Flex: Unverified',
        message: lookupPending ? 'Checking this model for Flex support automatically.' : 'Flex support is unverified. Each request checks availability; if lookup fails, normal routing is used.',
        providers: [],
    };
    const providers = resolveAutomaticProviders(settings(), model, cached.endpoints);
    return providers.length
        ? { label: 'Flex: Automatic', message: 'Flex is used automatically for this model.', providers }
        : { label: 'Flex: Not supported', message: 'This model has no advertised Flex endpoints. Normal OpenRouter routing is used automatically.', providers };
}
function target() {
    const model = connection().model;
    return editScope === 'model' && concreteModel(model) ? { key: `model:${model}`, model } : { key: 'global', model: null };
}
function savedDraft() {
    const state = settings(), { model } = target();
    return { inherit: Boolean(model && !Object.hasOwn(state.modelProviders, model)), text: (model ? resolveProviders(state, model) : state.providers).join('\n') };
}
function draft() {
    const { key } = target();
    if (!drafts.has(key)) drafts.set(key, savedDraft());
    return drafts.get(key);
}
function normalizedText(text) {
    try { return JSON.stringify(parseProviders(text)); } catch { return `invalid:${text}`; }
}
function dirty() {
    const value = draft(), saved = savedDraft();
    return value.inherit !== saved.inherit || (!value.inherit && normalizedText(value.text) !== normalizedText(saved.text));
}
function draftProviders() {
    if (draft().inherit) return settings().providers;
    try { return parseProviders(draft().text); } catch { return []; }
}
function element(name) { return panel?.querySelector(`[data-flex="${name}"]`); }
function isOpen() { return active && element('drawer-icon')?.classList.contains('up') && panel.getClientRects().length > 0; }
function visibilityChanged() {
    if (!active) return;
    element('drawer-toggle')?.setAttribute('aria-expanded', String(element('drawer-icon')?.classList.contains('up') ?? false));
    const visible = Boolean(isOpen());
    if (visible && !wasVisible) void refreshCatalog();
    wasVisible = visible;
}
function setText(name, text) { const node = element(name); if (node && node.textContent !== text) node.textContent = text; }
// UI revisions must not cancel catalog lookups shared with pending requests.
function invalidateLookup() { lookupRevision++; lookupPending = false; }
function setCurrentModelFlex(enabled, expectedModel = connection().model) {
    const { model, openrouter } = connection();
    if (!active || !openrouter || !concreteModel(model)) return 'Select a specific model on a native OpenRouter connection to change its Flex setting.';
    if (model !== expectedModel) { render(); return 'The selected model changed. Use its updated Flex control.'; }
    const state = settings(), disabledModels = new Set(state.disabledModels);
    const changed = isFlexEnabled(state, model) !== enabled;
    if (enabled) disabledModels.delete(model); else disabledModels.add(model);
    if (changed) {
        save({ ...state, disabledModels: [...disabledModels] });
        invalidateLookup();
    }
    feedback = enabled
        ? `Automatic Flex enabled for ${model} when compatible endpoints are available. This model setting is saved immediately.`
        : `Flex disabled for ${model}. Normal routing is used without endpoint lookups. This model setting is saved immediately.`;
    const message = feedback;
    render();
    if (enabled && changed) void refreshCatalog();
    return message;
}
function onModelFlexChange(event) { setCurrentModelFlex(event.target.checked, event.target.dataset.model); }
function skipDisabledRequest(model) {
    if (isFlexEnabled(settings(), model)) return false;
    lastRequested = `Normal routing for ${model}: Flex is disabled for this model.`;
    render(); return true;
}
async function onRequest(request) {
    const source = request?.chat_completion_source ?? request?.api_type;
    if (!active || source !== 'openrouter') return;
    const model = request.model, epoch = activationEpoch;
    if (!concreteModel(model)) {
        lastRequested = 'Normal routing: the request does not identify a specific model to check for Flex support.';
        renderRequests(); return;
    }
    if (skipDisabledRequest(model)) return;
    let available;
    try {
        available = await catalog.load(model);
    } catch (error) {
        if (!active || epoch !== activationEpoch || request.model !== model
            || (request.chat_completion_source ?? request.api_type) !== source) return;
        if (skipDisabledRequest(model)) return;
        lastRequested = `Normal routing for ${model}: Flex support could not be verified.`;
        if (connection().model === model) feedback = `${error?.message || 'Flex availability could not be verified.'} This request uses normal routing; later lookups respect the catalog cooldown.`;
        render(); return;
    }
    if (!active || epoch !== activationEpoch || request.model !== model
        || (request.chat_completion_source ?? request.api_type) !== source) return;
    if (skipDisabledRequest(model)) return;
    const applied = applyFlexRouting(request, settings(), available?.endpoints || []);
    lastRequested = applied
        ? `Requested automatic Flex: ${model} → ${request.provider.join(', ')}.`
        : `Normal routing for ${model}: no Flex endpoints are advertised.`;
    render();
}
function syncReporting() {
    if (active && settings().responseReportingEnabled) observer.enable(); else observer.disable();
}
function refreshState() {
    if (!active) return;
    const model = connection().model;
    if (model !== lastModel) { invalidateLookup(); lastModel = model; feedback = ''; }
    mount(); render();
    void refreshCatalog();
}
async function refreshCatalog(force = false) {
    const { model, openrouter } = connection();
    if (!active || !openrouter || !concreteModel(model)) return;
    if (!isFlexEnabled(settings(), model)) {
        if (force) { feedback = 'Flex is disabled for this model. Enable it before refreshing endpoints.'; render(); }
        return;
    }
    const cached = catalog.get(model);
    if (!force && cached && !cached.stale) return;
    if (lookupPending && !force) return;
    const revision = ++lookupRevision, epoch = activationEpoch;
    lookupPending = true; feedback = 'Checking OpenRouter’s public model catalog…'; render();
    try {
        const result = await catalog.load(model, { force });
        if (!active || revision !== lookupRevision || connection().model !== model || !isFlexEnabled(settings(), model)) return;
        feedback = result?.endpoints.length
            ? `Found ${result.endpoints.length} Flex endpoint(s). Flex is automatic; saved preferences only set their order.`
            : 'No Flex endpoints are advertised for this model. Normal routing is used automatically.';
    } catch (error) {
        if (!active || revision !== lookupRevision || connection().model !== model || !isFlexEnabled(settings(), model)) return;
        feedback = `${error.name === 'AbortError' ? 'Lookup cancelled or timed out.' : error.message} If availability cannot be verified before a request, normal routing is used.`;
    } finally {
        if (revision === lookupRevision) lookupPending = false;
        if (active && epoch === activationEpoch && connection().model === model) render();
    }
}
function changeDraft(mutator) {
    // No asynchronous discovery result is permitted to edit a draft.
    invalidateLookup(); mutator(draft()); feedback = ''; render();
}
function makeButton(label, action, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'menu_button menu_button_icon'; button.textContent = label; button.disabled = disabled;
    button.addEventListener('click', action); return button;
}
function renderCatalog() {
    const list = element('catalog');
    if (!list) return;
    const cached = catalog.get(connection().model), selected = draftProviders(), endpoints = cached?.endpoints || [];
    const tags = [...new Set([...selected, ...endpoints.map(value => value.tag)])];
    const fragment = document.createDocumentFragment();
    for (const tag of tags) {
        const endpoint = endpoints.find(value => value.tag === tag);
        const card = document.createElement('div'); card.className = 'flex-endpoint marginTopBot5';
        const label = document.createElement('label'); label.className = 'checkbox_label';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = selected.includes(tag); checkbox.disabled = draft().inherit;
        checkbox.setAttribute('aria-label', `Prefer ${tag}`);
        checkbox.addEventListener('change', () => changeDraft(value => {
            const providers = draftProviders().filter(item => item !== tag);
            if (checkbox.checked) providers.push(tag);
            value.text = providers.join('\n');
        }));
        const title = document.createElement('span'), name = document.createElement('strong'), slug = document.createElement('small');
        name.textContent = endpoint?.provider || tag.split('/')[0]; slug.textContent = tag;
        title.append(name, slug); label.append(checkbox, title);
        const info = document.createElement('small');
        const price = number => number == null ? 'unknown' : `$${new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(number)}`;
        info.textContent = endpoint
            ? `Region: ${endpoint.region || 'unspecified'} · Input/output per 1M tokens: ${price(endpoint.inputPrice)} / ${price(endpoint.outputPrice)} · Latency: ${endpoint.latency == null ? 'unknown' : `${endpoint.latency}s`} · Uptime: ${endpoint.uptime == null ? 'unknown' : `${endpoint.uptime}%`}`
            : 'Saved/manual endpoint; no current catalog metadata.';
        const actions = document.createElement('div'); actions.className = 'flex-container alignitemscenter';
        const position = selected.indexOf(tag);
        const move = offset => changeDraft(value => {
            const providers = draftProviders();
            [providers[position], providers[position + offset]] = [providers[position + offset], providers[position]];
            value.text = providers.join('\n');
        });
        if (position >= 0) {
            const order = document.createElement('span'); order.textContent = `Preference ${position + 1}`;
            actions.append(order, makeButton('Move up', () => move(-1), draft().inherit || position === 0), makeButton('Move down', () => move(1), draft().inherit || position === selected.length - 1));
        }
        card.append(label, info, actions); fragment.append(card);
    }
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const focus = focused && { label: focused.getAttribute('aria-label'), text: focused.textContent, tag: focused.closest('.flex-endpoint')?.querySelector('small')?.textContent };
    list.replaceChildren(fragment);
    if (focus) {
        const card = [...list.children].find(node => node.querySelector('small')?.textContent === focus.tag);
        [...(card?.querySelectorAll('button,input') || [])].find(node => focus.label ? node.getAttribute('aria-label') === focus.label : node.textContent === focus.text)?.focus({ preventScroll: true });
    }
}
function renderRequests() {
    if (!panel) return;
    const container = element('requests');
    if (!settings().responseReportingEnabled) {
        container.textContent = `${lastRequested || 'No Flex request recorded this session.'} Outcome and served tier unavailable: response reporting is off.`; return;
    }
    const records = observer.getRecords();
    if (!records.length) { container.textContent = lastRequested || 'No OpenRouter request observed this session.'; return; }
    const openRows = new Map([...container.querySelectorAll('details[data-record]')].map(row => [row.dataset.record, row.open]));
    const focused = container.contains(document.activeElement) && document.activeElement.matches('input') ? document.activeElement : null;
    const focus = focused && { record: focused.closest('[data-record]').dataset.record, start: focused.selectionStart, end: focused.selectionEnd };
    const names = { pending: 'Requested', streaming: 'Streaming', complete: 'Succeeded', error: 'Failed', aborted: 'Cancelled', unknown: 'Outcome unknown' };
    const fragment = document.createDocumentFragment();
    for (const [index, record] of records.entries()) {
        const row = document.createElement('details'); row.dataset.record = String(record.id); row.open = openRows.get(String(record.id)) ?? index === 0;
        const summary = document.createElement('summary');
        summary.textContent = `${names[record.outcome] || 'Unknown'} · ${record.model || 'website-selected model'} · Reported tier: ${record.reportedTier || 'unknown'}`;
        const description = document.createElement('p');
        description.textContent = `Requested routing: ${record.requestedFlex ? 'Flex only' : 'normal/other'}. Endpoints: ${record.providers.join(', ') || 'unspecified'}. ${record.elapsedMs == null ? '' : `Elapsed: ${(record.elapsedMs / 1000).toFixed(1)}s.`} ${record.provider ? `Provider: ${record.provider}.` : ''} ${record.returnedModel ? `Returned model: ${record.returnedModel}.` : ''} ${record.warning || ''} ${record.detail || ''}`;
        row.append(summary, description);
        if (record.generationId) {
            const idLabel = document.createElement('label'); idLabel.textContent = 'Generation ID (select to copy)';
            const id = document.createElement('input'); id.type = 'text'; id.readOnly = true; id.value = record.generationId; id.className = 'text_pole';
            id.addEventListener('focus', () => id.select()); idLabel.append(id); row.append(idLabel);
        }
        fragment.append(row);
    }
    container.replaceChildren(fragment);
    if (focus) {
        const input = [...container.querySelectorAll('[data-record]')].find(row => row.dataset.record === focus.record)?.querySelector('input');
        input?.focus({ preventScroll: true }); input?.setSelectionRange(focus.start, focus.end);
    }
}
function render() {
    if (!active || !panel) return;
    const state = settings(), { model, openrouter, quantizations } = connection(), validModel = concreteModel(model);
    const modelEnabled = isFlexEnabled(state, model);
    const routing = routingStatus();
    element('reporting').checked = state.responseReportingEnabled;
    setText('status', routing.message);
    setText('model', openrouter ? `Current model: ${validModel ? model : 'website-selected or automatic; using normal routing'}` : 'Select a native OpenRouter connection to check model availability.');
    for (const control of [element('model-enabled'), quick?.querySelector('[data-flex="model-enabled"]')]) {
        if (!control) continue;
        control.checked = validModel && modelEnabled;
        control.disabled = !openrouter || !validModel;
        control.dataset.model = model;
        control.title = validModel ? `Applies only to ${model}; saved immediately.` : 'Select a specific OpenRouter model.';
    }
    element('profile').value = validModel ? editScope : 'global';
    element('profile').querySelector('[value="model"]').disabled = !validModel;
    setText('target', target().model ? `Editing model profile: ${target().model}` : 'Editing global defaults for models without an override.');
    element('inherit-label').hidden = !target().model; element('inherit').checked = draft().inherit;
    const input = element('providers'), text = draft().inherit ? state.providers.join('\n') : draft().text;
    if (input.value !== text) input.value = text;
    input.disabled = draft().inherit;
    let invalid = '';
    if (!draft().inherit) { try { parseProviders(draft().text); } catch (error) { invalid = error.message; } }
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    element('save').disabled = !dirty() || Boolean(invalid); element('discard').disabled = !dirty();
    setText('dirty', dirty() ? 'Unsaved endpoint preference changes. The model switch is saved separately; enabled Flex routing uses saved preferences.' : 'All endpoint preferences saved.');
    setText('active', routing.providers.length ? `Automatic Flex endpoints: ${routing.providers.join(', ')}` : 'No Flex override is currently selected.');
    setText('preferences', `Saved endpoint preferences (${validModel && Object.hasOwn(state.modelProviders, model) ? 'model override' : 'global defaults'}): ${resolveProviders(state, model).join(', ')}`);
    const cached = catalog.get(model), stale = Boolean(cached?.stale);
    setText('catalog-status', !validModel || !openrouter ? 'Select a specific OpenRouter model to discover endpoints.' : !modelEnabled ? 'Endpoint lookups are paused because Flex is disabled for this model. Cached endpoint preferences remain available for editing.' : cached ? `Availability checked ${new Date(cached.checkedAt).toLocaleTimeString()}${stale ? ' — stale; rechecked automatically before the next request' : ''}. Public availability does not confirm account access.` : 'Availability is checked automatically, including before the first request.');
    element('discover').disabled = !openrouter || !validModel || !modelEnabled || lookupPending; element('use-discovered').disabled = !cached?.endpoints.length;
    const warnings = openrouter && modelEnabled ? configurationWarnings({ providers: resolveProviders(state, model), endpoints: cached?.endpoints || [], quantizations, stale, checked: Boolean(cached) }) : [];
    setText('warnings', [...recovery, commandWarning, ...warnings].filter(Boolean).join(' '));
    setText('error', invalid ? `${invalid} Saved preferences are unchanged.` : feedback);
    renderCatalog(); renderRequests();
    if (quick) {
        quick.hidden = !openrouter;
        const status = quick.querySelector('[data-flex="quick-status"]'); status.textContent = routing.label; status.title = routing.message;
        quick.querySelector('[data-flex="quick-model"]').textContent = validModel ? `Current model: ${model}` : 'Select a specific model to change its Flex setting.';
    }
}
function mount() {
    if (!panel?.isConnected) {
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host) return;
        document.getElementById(PANEL_ID)?.remove(); panel = document.createElement('div'); panel.id = PANEL_ID;
        // Static markup only. External values are assigned through textContent/value.
        panel.innerHTML = `
          <div class="inline-drawer" data-flex="drawer">
            <div class="inline-drawer-toggle inline-drawer-header interactable" data-flex="drawer-toggle" role="button" tabindex="0" aria-expanded="false" aria-controls="openrouter_flex_content">
              <b>OpenRouter Flex</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down not_focusable" data-flex="drawer-icon" aria-hidden="true"></div>
            </div>
            <div id="openrouter_flex_content" class="inline-drawer-content">
            <b>Automatic model compatibility</b>
            <p data-flex="status" role="status" aria-live="polite"></p><p id="openrouter_flex_model_label" data-flex="model"></p>
            <label class="checkbox_label"><input id="openrouter_flex_model_enabled" type="checkbox" data-flex="model-enabled" aria-describedby="openrouter_flex_model_label openrouter_flex_model_help"><span>Use Flex when available for this model</span></label>
            <small id="openrouter_flex_model_help">Changes are saved immediately for the current model, separately from endpoint preferences.</small>
            <p>Compatible models use Flex automatically unless disabled for that model. Disabled models and models without Flex endpoints keep normal routing. Flex can be slower or temporarily unavailable; Flex requests stay on Flex endpoints.</p>
            <p data-flex="active"></p><p class="text_warning" data-flex="warnings" role="status" aria-live="polite"></p>
            <label for="openrouter_flex_profile">Edit endpoint preferences</label>
            <select id="openrouter_flex_profile" class="text_pole" data-flex="profile"><option value="model">Current model</option><option value="global">Global defaults</option></select>
            <p data-flex="target"></p><label class="checkbox_label" data-flex="inherit-label"><input type="checkbox" data-flex="inherit"><span>Use global defaults for this model</span></label>
            <p data-flex="preferences"></p>
            <p>Saved preferences are tried first when available. Other advertised Flex endpoints remain eligible automatically.</p>
            <div class="flex-container"><button type="button" class="menu_button menu_button_icon" data-flex="discover">Refresh endpoints</button><button type="button" class="menu_button menu_button_icon" data-flex="use-discovered">Prefer discovered endpoints</button></div>
            <small data-flex="catalog-status"></small><div data-flex="catalog"></div>
            <details><summary>Advanced: edit provider preferences</summary><label for="openrouter_flex_providers">Preferred /flex slugs, one per line</label>
              <textarea id="openrouter_flex_providers" class="text_pole textarea_compact" data-flex="providers" rows="4" spellcheck="false" aria-describedby="openrouter_flex_error"></textarea></details>
            <p data-flex="dirty" role="status" aria-live="polite"></p><p id="openrouter_flex_error" class="text_warning" data-flex="error" role="status" aria-live="polite"></p>
            <div class="flex-container"><button type="button" class="menu_button menu_button_icon" data-flex="save">Save preferences</button><button type="button" class="menu_button menu_button_icon" data-flex="discard">Discard changes</button><button type="button" class="menu_button menu_button_icon" data-flex="reset">Restore defaults</button></div>
            <details><summary>Request reporting</summary><label class="checkbox_label"><input type="checkbox" data-flex="reporting"><span>Observe returned tier and request outcome</span></label>
              <p>Reporting inspects existing responses only. Unknown means no tier evidence was received. Reported tier is not a billing confirmation. History lasts only for this page session.</p>
              <div data-flex="requests"></div><a href="https://openrouter.ai/activity" target="_blank" rel="noopener noreferrer">OpenRouter Activity and billing</a></details>
            <p><a href="https://openrouter.ai/docs/guides/features/service-tiers" target="_blank" rel="noopener noreferrer">Flex availability and billing documentation</a></p>
            </div>
          </div>`;
        host.append(panel);
        visibilityObserver?.disconnect();
        visibilityObserver = new MutationObserver(visibilityChanged);
        for (let ancestor = panel.parentElement; ancestor; ancestor = ancestor.parentElement) visibilityObserver.observe(ancestor, { attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
        visibilityObserver.observe(element('drawer-icon'), { attributes: true, attributeFilter: ['class'] });
        element('drawer-toggle').addEventListener('keydown', event => {
            if (event.key === ' ') { event.preventDefault(); event.currentTarget.click(); }
        });
        element('reporting').addEventListener('change', event => { save({ ...settings(), responseReportingEnabled: event.target.checked }); syncReporting(); render(); });
        element('model-enabled').addEventListener('change', onModelFlexChange);
        element('profile').addEventListener('change', event => { editScope = event.target.value; feedback = ''; render(); });
        element('inherit').addEventListener('change', event => changeDraft(value => { value.inherit = event.target.checked; }));
        element('providers').addEventListener('input', event => changeDraft(value => { value.text = event.target.value; }));
        element('discover').addEventListener('click', () => void refreshCatalog(true));
        element('use-discovered').addEventListener('click', () => {
            const endpoints = catalog.get(connection().model)?.endpoints;
            if (endpoints?.length) changeDraft(value => { value.inherit = false; value.text = endpoints.map(endpoint => endpoint.tag).join('\n'); });
        });
        element('save').addEventListener('click', () => {
            try {
                const state = settings(), value = draft(), { key, model } = target(), profiles = { ...state.modelProviders };
                if (model) {
                    if (value.inherit) delete profiles[model]; else Object.defineProperty(profiles, model, { value: parseProviders(value.text), enumerable: true, writable: true, configurable: true });
                    save({ ...state, modelProviders: profiles });
                } else save({ ...state, providers: parseProviders(value.text) });
                invalidateLookup(); drafts.delete(key); feedback = 'Endpoint preferences saved.'; recovery = []; render();
            } catch (error) { feedback = error.message; render(); }
        });
        element('discard').addEventListener('click', () => { invalidateLookup(); drafts.delete(target().key); feedback = 'Unsaved changes discarded.'; render(); });
        element('reset').addEventListener('click', () => changeDraft(value => { value.inherit = Boolean(target().model); value.text = [...DEFAULT_PROVIDERS].join('\n'); }));
    }
    // Place the row after the model's wrapper so desktop Select2 stays above it too.
    const anchor = document.getElementById(current().mainApi === 'textgenerationwebui' ? 'openrouter_model' : 'model_openrouter_select')?.parentElement;
    if (anchor) {
        if (!quick?.isConnected) {
            document.getElementById('openrouter_flex_quick')?.remove(); quick = document.createElement('div'); quick.id = 'openrouter_flex_quick'; quick.className = 'flex-container alignitemscenter';
            const label = document.createElement('label'); label.className = 'checkbox_label';
            const input = document.createElement('input'); input.id = 'openrouter_flex_quick_enabled'; input.type = 'checkbox'; input.dataset.flex = 'model-enabled';
            input.setAttribute('aria-describedby', 'openrouter_flex_quick_model'); input.addEventListener('change', onModelFlexChange);
            const labelText = document.createElement('span'); labelText.textContent = 'Use Flex when available for this model'; label.append(input, labelText);
            const modelLabel = document.createElement('span'); modelLabel.id = 'openrouter_flex_quick_model'; modelLabel.dataset.flex = 'quick-model';
            const status = document.createElement('span'); status.dataset.flex = 'quick-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
            quick.append(label, modelLabel, status, makeButton('Flex settings', () => {
                const hostToggle = document.querySelector('#extensions-settings-button .drawer-toggle');
                if (hostToggle && !panel.getClientRects().length) hostToggle.click();
                if (element('drawer-icon').classList.contains('down')) element('drawer-toggle').click();
                panel.scrollIntoView({ block: 'nearest' }); element('profile').focus({ preventScroll: true });
                visibilityChanged();
                if (isOpen()) void refreshCatalog();
            }));
            quick.querySelectorAll('button').forEach(button => button.classList.add('menu_button_icon'));
        }
        if (anchor.nextElementSibling !== quick) anchor.after(quick);
    }
}
function registerCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) { commandWarning = 'Slash commands unavailable in this host; use Flex settings.'; return; }
    if (SlashCommandParser.commands?.['openrouter-flex']) { commandWarning = '/openrouter-flex is already registered; use Flex settings.'; return; }
    const aliases = SlashCommandParser.commands?.flex ? [] : ['flex'];
    commandWarning = aliases.length ? '' : '/flex belongs to another extension. Use /openrouter-flex instead.';
    command = SlashCommand.fromProps({ name: 'openrouter-flex', aliases,
        callback: async (_args, value) => {
            if (!active) return 'OpenRouter Flex is disabled in Manage Extensions.';
            const action = String(value || 'status').trim().toLowerCase();
            if (['on', 'off', 'toggle'].includes(action)) {
                const { model } = connection();
                return setCurrentModelFlex(action === 'toggle' ? !isFlexEnabled(settings(), model) : action === 'on', model);
            }
            if (action !== 'status' && action !== 'refresh') return 'Use /flex status, /flex refresh, /flex on, /flex off, or /flex toggle. Changes apply only to the current model.';
            await refreshCatalog(action === 'refresh');
            if (!active) return 'OpenRouter Flex is disabled in Manage Extensions.';
            const { model } = connection();
            const routing = routingStatus();
            return `${routing.message} Model: ${model || 'website-selected/automatic'}.${routing.providers.length ? ` Flex endpoints: ${routing.providers.join(', ')}.` : ''}`;
        },
        unnamedArgumentList: SlashCommandArgument?.fromProps ? [SlashCommandArgument.fromProps({ description: 'status, refresh, on, off, or toggle', typeList: [ARGUMENT_TYPE.STRING], defaultValue: 'status', isRequired: false })] : [],
        helpString: 'Automatic OpenRouter Flex with an immediate per-model switch. /flex on, off, or toggle saves the current model setting; enabled means use Flex when compatible. /flex status reports routing; /flex refresh refreshes advertised endpoints only while Flex is enabled for that model. Endpoint preference drafts are never saved by commands.',
    });
    SlashCommandParser.addCommandObject(command);
}
function listen(type, handler) {
    if (type) { context.eventSource.on(type, handler); listeners.push([type, handler]); }
}
function migrate() {
    const raw = current().extensionSettings[SETTINGS_KEY]; recovery = [...new Set([...recovery, ...getSettingsWarnings(raw)])];
    const normalized = normalizeSettings(raw);
    if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(normalized)) save(normalized);
    syncReporting();
}
function onReady() {
    if (!active) return;
    migrate(); refreshState();
    context.eventSource.makeLast?.(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onRequest);
    context.eventSource.makeLast?.(context.eventTypes.TEXT_COMPLETION_SETTINGS_READY, onRequest);
}
function onSettingsLoaded() { drafts.clear(); invalidateLookup(); onReady(); }
function onHostChange(event) {
    if (event.target?.matches?.('#main_api, #chat_completion_source, #model_openrouter_select, #textgen_type, #openrouter_model, #openrouter_quantizations_chat, #openrouter_quantizations_text')) queueMicrotask(refreshState);
}
export function onActivate() {
    if (active) return;
    context = current();
    if (!context.eventTypes.CHAT_COMPLETION_SETTINGS_READY || !context.eventTypes.TEXT_COMPLETION_SETTINGS_READY) throw new Error('OpenRouter Flex requires SillyTavern 1.19 or later.');
    active = true; activationEpoch++;
    listen(context.eventTypes.CHAT_COMPLETION_SETTINGS_READY, onRequest); listen(context.eventTypes.TEXT_COMPLETION_SETTINGS_READY, onRequest);
    listen(context.eventTypes.APP_READY, onReady); listen(context.eventTypes.EXTENSION_SETTINGS_LOADED, onSettingsLoaded);
    for (const name of ['CHATCOMPLETION_SOURCE_CHANGED', 'MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'PRESET_CHANGED', 'OAI_PRESET_CHANGED_AFTER']) listen(context.eventTypes[name], refreshState);
    document.addEventListener('change', onHostChange); registerCommand();
    onReady();
}
export function onDisable() {
    active = false; activationEpoch++; invalidateLookup(); observer.disable(); observer.clear(); visibilityObserver?.disconnect(); visibilityObserver = undefined; wasVisible = false;
    for (const [type, handler] of listeners.splice(0)) context.eventSource.removeListener(type, handler);
    document.removeEventListener('change', onHostChange);
    const registry = context?.SlashCommandParser?.commands;
    if (registry && command) for (const name of [command.name, ...(command.aliases || [])]) if (registry[name] === command) delete registry[name];
    command = undefined; commandWarning = ''; panel?.remove(); quick?.remove(); panel = undefined; quick = undefined;
    drafts.clear(); catalog.clear(); lastRequested = ''; feedback = ''; lastModel = undefined;
}
export function onClean() {
    onDisable(); const host = current(); delete host.extensionSettings[SETTINGS_KEY]; host.saveSettingsDebounced(); recovery = [];
}
