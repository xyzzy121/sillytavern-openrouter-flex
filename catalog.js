import { catalogModel, discoverFlexEndpoints } from './flex.js';

const MIN_REFRESH_INTERVAL = 60 * 1000;
const INITIAL_FAILURE_BACKOFF = 5 * 60 * 1000;
const MAX_FAILURE_BACKOFF = 30 * 60 * 1000;
const REQUEST_WINDOW = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;

/** Public, unauthenticated discovery. Catalog data never edits a settings draft. */
export function createCatalog({ fetchImpl = globalThis.fetch, now = Date.now, ttl = 30 * 60 * 1000, timeoutMs = 15000 } = {}) {
    const cache = new Map();
    const pending = new Map();
    const attempts = new Map();
    const requestStarts = [];
    let globalRetryAt = 0;
    const snapshot = entry => entry ? {
        model: entry.model,
        endpoints: entry.endpoints.map(endpoint => ({ ...endpoint })),
        checkedAt: entry.checkedAt,
        stale: entry.failed === true || now() - entry.checkedAt >= ttl,
    } : null;

    function get(model) {
        const key = catalogModel(model);
        return key === null ? null : snapshot(cache.get(key));
    }

    function deferred(reason, retryAt) {
        const error = new Error(`Endpoint lookup deferred: ${reason} Try again after ${new Date(retryAt).toLocaleString()}.`);
        error.name = 'CatalogDeferredError';
        error.retryAt = retryAt;
        return Promise.reject(error);
    }

    function serverRetryAt(response) {
        const value = response.headers?.get?.('Retry-After')?.trim();
        const timestamp = now();
        const seconds = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
        const advertised = Number.isFinite(seconds) ? timestamp + seconds * 1000 : Date.parse(value || '');
        return Math.max(timestamp + INITIAL_FAILURE_BACKOFF,
            Number.isFinite(advertised) && advertised <= 8640000000000000 ? advertised : 0);
    }

    function load(model, { force = false } = {}) {
        const key = catalogModel(model);
        if (key === null) return Promise.resolve(null);
        const current = get(model);
        if (!force && current && !current.stale) return Promise.resolve(current);
        if (pending.has(key)) return pending.get(key).promise;

        const timestamp = now();
        const previous = attempts.get(key);
        if (previous?.retryAt > timestamp) {
            return deferred('This model is cooling down after a failed lookup.', previous.retryAt);
        }
        if (force && previous && timestamp - previous.startedAt < MIN_REFRESH_INTERVAL) {
            if (current && !current.stale) return Promise.resolve(current);
            return deferred('Refresh is limited to once per minute for each model.', previous.startedAt + MIN_REFRESH_INTERVAL);
        }
        if (globalRetryAt > timestamp) {
            return deferred('OpenRouter requested a pause in endpoint lookups.', globalRetryAt);
        }
        while (requestStarts.length && requestStarts[0] <= timestamp - REQUEST_WINDOW) requestStarts.shift();
        if (requestStarts.length >= MAX_REQUESTS_PER_WINDOW) {
            return deferred('Endpoint lookups are limited to 10 per minute.', requestStarts[0] + REQUEST_WINDOW);
        }

        const attempt = { startedAt: timestamp, failures: previous?.failures || 0, retryAt: 0 };
        attempts.set(key, attempt);
        requestStarts.push(timestamp);
        const controller = new AbortController();
        const operation = { controller, promise: null };
        // Reject even if a mocked or third-party fetch does not honor AbortSignal.
        const aborted = new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
        const timer = setTimeout(() => controller.abort(new DOMException('Endpoint lookup timed out. Try Refresh again.', 'TimeoutError')), timeoutMs);
        const lookup = async () => {
            const path = key.split('/').map(encodeURIComponent).join('/');
            const response = await fetchImpl(`https://openrouter.ai/api/v1/models/${path}/endpoints`, {
                method: 'GET', signal: controller.signal,
                credentials: 'omit', referrerPolicy: 'no-referrer',
                headers: { Accept: 'application/json' },
            });
            if (controller.signal.aborted) throw controller.signal.reason;
            if (!response.ok) {
                const error = new Error(`Endpoint lookup failed (HTTP ${response.status}). Normal routing will be used while lookups cool down.`);
                if (response.status === 429 || response.status === 503) error.retryAt = serverRetryAt(response);
                throw error;
            }
            const data = await response.json();
            const endpoints = discoverFlexEndpoints(data);
            if (controller.signal.aborted) throw controller.signal.reason;
            const entry = { model: key, endpoints, checkedAt: now() };
            cache.set(key, entry);
            attempt.failures = 0;
            attempt.retryAt = 0;
            return snapshot(entry);
        };
        operation.promise = Promise.race([lookup(), aborted]).catch(error => {
            if (error?.name !== 'AbortError' && pending.get(key) === operation) {
                if (cache.has(key)) cache.get(key).failed = true;
                attempt.failures++;
                attempt.retryAt = now() + Math.min(INITIAL_FAILURE_BACKOFF * 2 ** (attempt.failures - 1), MAX_FAILURE_BACKOFF);
                if (Number.isFinite(error?.retryAt)) {
                    globalRetryAt = Math.max(globalRetryAt, error.retryAt);
                    attempt.retryAt = Math.max(attempt.retryAt, globalRetryAt);
                }
            }
            throw error;
        }).finally(() => {
            clearTimeout(timer);
            if (pending.get(key) === operation) pending.delete(key);
        });
        pending.set(key, operation);
        return operation.promise;
    }

    function cancel() {
        for (const operation of pending.values()) {
            operation.controller.abort(new DOMException('Endpoint lookup cancelled.', 'AbortError'));
        }
        pending.clear();
    }

    function clear() {
        cancel();
        cache.clear();
        // Keep request accounting and cooldowns so clearing cannot bypass them.
    }

    return { get, load, cancel, clear };
}
