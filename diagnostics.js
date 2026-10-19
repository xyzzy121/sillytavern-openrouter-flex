export const DIAGNOSTIC_LIMITS = Object.freeze({ records: 20, eventBytes: 256 * 1024, responseBytes: 32 * 1024 * 1024, durationMs: 30 * 60 * 1000 });

const PATHS = new Map([
    ['/api/backends/chat-completions/generate', 'chat'],
    ['/api/backends/text-completions/generate', 'text'],
]);
const TIERS = new Set(['flex', 'default', 'priority']);
const metadataString = value => typeof value === 'string' ? value.slice(0, 300) : '';
const safely = callback => { try { return callback(); } catch { return undefined; } };

/**
 * Observe native OpenRouter responses without replacing or consuming the host's
 * Response. Only metadata is retained. Records are newest first and contain:
 * id, model, mode, providers, requestedFlex, outcome, reportedTier, startedAt,
 * elapsedMs, generationId, provider, returnedModel, warning, and detail.
 * A reported tier describes the response, not a price or billing guarantee.
 */
export function createResponseObserver({ getSettings, getExpectedProviders = () => [], onChange = () => {}, origin, host = globalThis }) {
    const baseOrigin = new URL(origin || host.location?.origin || 'http://localhost').origin;
    const schedule = host.setTimeout?.bind(host) || globalThis.setTimeout.bind(globalThis);
    const unschedule = host.clearTimeout?.bind(host) || globalThis.clearTimeout.bind(globalThis);
    let active = false;
    let installed = false;
    let previousFetch;
    let installedFetch;
    let epoch = 0;
    let sequence = 0;
    let records = [];
    const tasks = new Set();
    const getRecords = () => records.map(record => ({ ...record, providers: [...record.providers] }));
    const notify = () => {
        const result = safely(() => onChange(getRecords()));
        safely(() => result?.catch?.(() => {}));
    };
    const current = task => active && !task.done && task.epoch === epoch && records.includes(task.record);

    function dispose(task) {
        task.done = true;
        tasks.delete(task);
        unschedule(task.timer);
        safely(() => task.signal?.removeEventListener('abort', task.onAbort));
        // Cancelling a clone's branch does not cancel the host's branch. The
        // cancellation promise can wait for that branch, so never await it.
        safely(() => task.reader?.cancel().catch(() => {}));
        task.reader = undefined;
    }

    function finish(task, outcome, detail = '', clearTier = false) {
        if (!current(task)) return;
        Object.assign(task.record, { outcome, detail, elapsedMs: Date.now() - task.record.startedAt });
        if (clearTier) { task.record.reportedTier = null; task.record.warning = task.routingWarning; }
        dispose(task);
        notify();
    }

    function start(input, init) {
        if (!active || typeof init?.body !== 'string') return;
        const url = new URL(typeof input === 'string' ? input : input?.url || input?.href, baseOrigin);
        const mode = PATHS.get(url.pathname);
        if (url.origin !== baseOrigin || !mode || String(init.method || input?.method || 'GET').toUpperCase() !== 'POST') return;
        const request = JSON.parse(init.body);
        if (request?.[mode === 'chat' ? 'chat_completion_source' : 'api_type'] !== 'openrouter') return;
        const settings = getSettings();
        if (settings?.responseReportingEnabled === false) return;
        const providers = Array.isArray(request.provider) ? request.provider.filter(value => typeof value === 'string').slice(0, 32).map(metadataString) : [];
        const model = metadataString(request.model);
        const expected = safely(() => getExpectedProviders(request));
        const conflict = Array.isArray(expected) && expected.length > 0 && (JSON.stringify(expected) !== JSON.stringify(request.provider)
            || request.allow_fallbacks !== false || (mode === 'chat' && request.use_fallback !== false)
            || (request.service_tier != null && request.service_tier !== 'flex'));
        const record = {
            id: ++sequence, model, mode, providers,
            // This flag describes strict routing in the final browser payload.
            // A raw service_tier value alone is discarded by stock ST 1.19.
            requestedFlex: Array.isArray(request.provider) && request.provider.length > 0
                && request.provider.every(provider => typeof provider === 'string' && provider.endsWith('/flex'))
                && request.allow_fallbacks === false && (mode !== 'chat' || request.use_fallback === false),
            outcome: 'pending', reportedTier: null, startedAt: Date.now(), elapsedMs: null,
            generationId: '', provider: '', returnedModel: '',
            warning: conflict ? 'Outgoing routing differs from automatic Flex routing. Another extension may have changed it.' : '', detail: '',
        };
        // Do not store request bodies, response content, or raw error messages.
        const task = { record, routingWarning: record.warning, stream: request.stream === true, signal: init.signal || input?.signal, epoch, done: false };
        records.unshift(record);
        while (records.length > DIAGNOSTIC_LIMITS.records) {
            const removed = records.pop();
            for (const pending of tasks) if (pending.record === removed) dispose(pending);
        }
        tasks.add(task);
        task.timer = schedule(() => finish(task, 'unknown', 'Response reporting stopped after 30 minutes.', true), DIAGNOSTIC_LIMITS.durationMs);
        task.timer?.unref?.();
        task.onAbort = () => finish(task, 'aborted', 'Request was cancelled.');
        safely(() => task.signal?.addEventListener('abort', task.onAbort, { once: true }));
        notify();
        return task;
    }

    function extract(task, data) {
        if (!current(task) || !data || typeof data !== 'object') return;
        const before = JSON.stringify(task.record);
        if (TIERS.has(data.service_tier)) task.record.reportedTier = data.service_tier;
        for (const [field, source] of [['generationId', 'id'], ['provider', 'provider'], ['returnedModel', 'model']]) {
            const value = metadataString(data[source]);
            if (value) task.record[field] = value;
        }
        const tierWarning = task.record.reportedTier && task.record.reportedTier !== 'flex' && task.record.requestedFlex
            ? `Flex was requested, but OpenRouter reported the ${task.record.reportedTier} tier.` : '';
        task.record.warning = [task.routingWarning, tierWarning].filter(Boolean).join(' ');
        if (before !== JSON.stringify(task.record)) notify();
    }

    async function inspect(task, response) {
        if (!current(task)) return;
        try {
            const clone = response.clone();
            if (!clone.body) return finish(task, 'unknown', 'No response body was available.', true);
            task.reader = clone.body.getReader();
            const contentType = clone.headers.get('content-type') || '';
            const sse = contentType.includes('text/event-stream') || (task.stream && !contentType.includes('json'));
            if (sse) {
                task.record.outcome = 'streaming';
                notify();
            }
            const decoder = new TextDecoder('utf-8', { fatal: true });
            const encoder = new TextEncoder();
            let totalBytes = 0;
            let buffer = '';
            let eventBytes = 0;
            let dataLines = [];
            let terminal = false;
            let finishedChoice = false;
            let malformed = false;

            const consumeEvent = () => {
                const value = dataLines.join('\n');
                dataLines = [];
                if (!value) return;
                if (value === '[DONE]') { terminal = true; return; }
                let data;
                try { data = JSON.parse(value); } catch { malformed = true; return; }
                extract(task, data);
                if (data?.error || data?.choices?.some(choice => choice?.finish_reason === 'error')) {
                    finish(task, 'error', 'OpenRouter returned an error during generation.');
                    return;
                }
                if (data?.choices?.some(choice => typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0)) finishedChoice = true;
            };

            const consumeLines = final => {
                while (current(task) && !terminal) {
                    const match = /\r\n|\r|\n/.exec(buffer);
                    if (!match || (!final && match[0] === '\r' && match.index === buffer.length - 1)) break;
                    const line = buffer.slice(0, match.index);
                    buffer = buffer.slice(match.index + match[0].length);
                    eventBytes += encoder.encode(line).byteLength + match[0].length;
                    if (eventBytes > DIAGNOSTIC_LIMITS.eventBytes) {
                        finish(task, 'unknown', 'Response reporting stopped: an event exceeded 256 KiB.', true);
                        return;
                    }
                    if (line === '') { consumeEvent(); eventBytes = 0; }
                    else if (line === 'data') dataLines.push('');
                    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
                }
                if (current(task) && !terminal && eventBytes + encoder.encode(buffer).byteLength > DIAGNOSTIC_LIMITS.eventBytes) {
                    finish(task, 'unknown', 'Response reporting stopped: an event exceeded 256 KiB.', true);
                }
            };

            while (current(task) && !terminal) {
                const { done, value } = await task.reader.read();
                if (!current(task)) return;
                if (done) { buffer += decoder.decode(); if (sse) consumeLines(true); break; }
                totalBytes += value.byteLength;
                if (totalBytes > DIAGNOSTIC_LIMITS.responseBytes) return finish(task, 'unknown', 'Response reporting stopped after 32 MiB.', true);
                buffer += decoder.decode(value, { stream: true });
                if (sse) consumeLines(false);
            }
            if (!current(task)) return;
            if (!sse) {
                let data;
                try { data = JSON.parse(buffer); } catch { return finish(task, response.ok ? 'unknown' : 'error', 'Response metadata could not be read.', true); }
                extract(task, data);
                if (!response.ok || data?.error) return finish(task, 'error', 'OpenRouter returned an error.');
                return finish(task, 'complete', task.record.reportedTier ? '' : 'OpenRouter did not report a service tier.');
            }
            if (!response.ok) return finish(task, 'error', `Request returned HTTP ${response.status}.`);
            if (malformed) return finish(task, 'unknown', 'Some response events could not be read.', true);
            if (!terminal && !finishedChoice) return finish(task, 'unknown', 'The stream ended without a completion marker.', true);
            finish(task, 'complete', task.record.reportedTier ? '' : 'OpenRouter did not report a service tier.');
        } catch (error) {
            finish(task, task.signal?.aborted || error?.name === 'AbortError' ? 'aborted' : 'unknown', 'Response reporting ended before completion.', true);
        }
    }

    function makeFetchWrapper(previous) {
        function observedFetch(...args) {
            // An older wrapper retained by another extension must delegate to
            // its original predecessor, without observing a request twice.
            const task = observedFetch === installedFetch ? safely(() => start(args[0], args[1])) : undefined;
            let promise;
            try { promise = Reflect.apply(previous, this, args); }
            catch (error) {
                safely(() => task && finish(task, error?.name === 'AbortError' ? 'aborted' : 'error', 'Request failed before a response was received.'));
                throw error;
            }
            if (!task) return promise;
            return promise.then(response => {
                // Clone before the caller can lock the body. Inspection yields
                // at the first read and never waits before returning it.
                safely(() => inspect(task, response).catch(() => {}));
                return response;
            }, error => {
                safely(() => finish(task, task.signal?.aborted || error?.name === 'AbortError' ? 'aborted' : 'error', 'Request failed before a response was received.'));
                throw error;
            });
        }
        return observedFetch;
    }

    return {
        enable() {
            if (active) return;
            active = true;
            if (!installed) {
                previousFetch = host.fetch;
                installedFetch = makeFetchWrapper(previousFetch);
                host.fetch = installedFetch;
                installed = true;
            }
        },
        disable() {
            active = false;
            epoch++;
            for (const task of tasks) {
                Object.assign(task.record, { outcome: 'unknown', reportedTier: null, warning: task.routingWarning, detail: 'Response reporting was disabled.', elapsedMs: Date.now() - task.record.startedAt });
                dispose(task);
            }
            // Do not remove a wrapper another extension installed after ours.
            // Our retained wrapper becomes inert and is reused on re-enable.
            if (installed && host.fetch === installedFetch) {
                host.fetch = previousFetch;
                installed = false;
            }
            notify();
        },
        clear() {
            epoch++;
            for (const task of tasks) dispose(task);
            records = [];
            notify();
        },
        getRecords,
    };
}
