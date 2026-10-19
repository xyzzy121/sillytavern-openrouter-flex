export const SETTINGS_KEY = 'openrouter_flex';
export const SETTINGS_VERSION = 4;

// These are ordering preferences only. Routing uses the model's advertised Flex
// endpoints, including newly available endpoints not listed in these defaults.
export const DEFAULT_PROVIDERS = Object.freeze([
    'openai/flex',
    'google-ai-studio/flex',
    'google-vertex/global/flex',
    'google-vertex/flex',
]);

/** Accept exact Flex endpoint slugs only; never a base or priority provider. */
export function parseProviders(value) {
    const items = typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value;
    if (!Array.isArray(items) || items.length === 0 || items.length > 32) {
        throw new Error('Enter between 1 and 32 Flex endpoint slugs.');
    }
    if (items.some(item => typeof item !== 'string'
        || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_][a-z0-9]+)*)*\/flex$/.test(item)
        || item.length > 200)) {
        throw new Error('Use exact provider slugs ending in /flex, for example google-ai-studio/flex.');
    }
    return [...new Set(items)];
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => record(value) && Object.hasOwn(value, key);
const validProviders = value => {
    try { return parseProviders(value); } catch { return null; }
};

/** Website-selected and automatic models cannot have verified model profiles. */
export function concreteModel(model) {
    return typeof model === 'string' && model.trim().length > 0
        && model !== 'OR_Website' && model.replace(/:(floor|nitro)$/, '') !== 'openrouter/auto';
}

/** Only catalog lookup drops these suffixes; settings retain the exact model ID. */
export function catalogModel(model) {
    return concreteModel(model) ? model.replace(/:(floor|nitro)$/, '') : null;
}

/** Repair saved preferences and exact-model opt-outs without retaining the old global switch. */
export function normalizeSettings(value) {
    const modelProviders = {};
    if (record(value?.modelProviders)) {
        for (const [model, providers] of Object.entries(value.modelProviders)) {
            if (!concreteModel(model)) continue;
            // Defining own properties also handles model IDs such as __proto__ safely.
            Object.defineProperty(modelProviders, model, {
                value: validProviders(providers) ?? [...DEFAULT_PROVIDERS],
                writable: true, enumerable: true, configurable: true,
            });
        }
    }
    return {
        schemaVersion: SETTINGS_VERSION,
        providers: validProviders(value?.providers) ?? [...DEFAULT_PROVIDERS],
        modelProviders,
        disabledModels: [...new Set(Array.isArray(value?.disabledModels) ? value.disabledModels.filter(concreteModel) : [])],
        responseReportingEnabled: value?.responseReportingEnabled !== false,
    };
}

/** Recovery notices are computed before migration overwrites the original data. */
export function getSettingsWarnings(value) {
    const warnings = [];
    if (value !== undefined && !record(value)) {
        return ['Saved Flex settings were invalid and have been restored to defaults.'];
    }
    if (has(value, 'providers') && !validProviders(value.providers)) {
        warnings.push('Invalid saved global preferences were restored to the default Flex endpoint order.');
    }
    if (has(value, 'modelProviders') && !record(value.modelProviders)) {
        warnings.push('Invalid saved model profiles were removed; models now inherit the global endpoint order.');
    } else if (record(value?.modelProviders)) {
        for (const [model, providers] of Object.entries(value.modelProviders)) {
            if (!concreteModel(model)) warnings.push('A profile without a concrete model was removed; it now uses the global endpoint order.');
            else if (!validProviders(providers)) warnings.push(`Invalid saved preferences for ${model} were restored to the default Flex endpoint order.`);
        }
    }
    if (has(value, 'disabledModels') && !Array.isArray(value.disabledModels)) {
        warnings.push('The saved disabled model list was invalid and has been removed; compatible models now use Flex automatically.');
    } else if (Array.isArray(value?.disabledModels) && value.disabledModels.some(model => !concreteModel(model))) {
        warnings.push('Invalid entries in the saved disabled model list were removed; only specific model IDs can be disabled.');
    }
    if (has(value, 'responseReportingEnabled') && typeof value.responseReportingEnabled !== 'boolean') {
        warnings.push('The saved response reporting preference was invalid and has been restored to enabled.');
    }
    return warnings;
}

/** Opt-outs match the exact settings ID, including any :floor or :nitro suffix. */
export function isFlexEnabled(settings, model) {
    const disabled = Array.isArray(settings?.disabledModels) ? settings.disabledModels : [];
    return concreteModel(model) && !disabled.includes(model);
}

/** Return a copy: request mutation must not modify a persisted model profile. */
export function resolveProviders(settings, model) {
    const normalized = normalizeSettings(settings);
    return concreteModel(model) && Object.hasOwn(normalized.modelProviders, model)
        ? normalized.modelProviders[model] : normalized.providers;
}

/** Use only advertised Flex endpoints, with saved preferences ordered first. */
export function resolveAutomaticProviders(settings, model, endpoints = []) {
    if (!isFlexEnabled(settings, model) || !Array.isArray(endpoints)) return [];
    const advertised = [...new Set(endpoints.map(endpoint => endpoint?.tag)
        .filter(tag => typeof tag === 'string' && validProviders([tag])))];
    if (!advertised.length) return [];
    const preferred = resolveProviders(settings, model).filter(tag => advertised.includes(tag));
    return [...preferred, ...advertised.filter(tag => !preferred.includes(tag))];
}

/**
 * Mutate only this request, never the saved OpenRouter connection/preset.
 * ST 1.19 drops service_tier, but forwards provider and allow_fallbacks.
 * The explicit tier slugs therefore do the actual routing on stock ST.
 */
export function applyFlexRouting(request, settings, endpoints = []) {
    const source = request?.chat_completion_source ?? request?.api_type;
    if (source !== 'openrouter') return false;
    const providers = resolveAutomaticProviders(settings, request.model, endpoints);
    if (!providers.length) return false;
    request.service_tier = 'flex';
    request.provider = providers;
    request.allow_fallbacks = false;
    if (request.chat_completion_source === 'openrouter') request.use_fallback = false;
    return true;
}

/** Extract exact advertised tier tags; do not guess slugs from display names. */
export function discoverFlexProviders(data) {
    const endpoints = data?.data?.endpoints;
    if (!Array.isArray(endpoints)) throw new Error('OpenRouter returned no endpoint list.');
    return [...new Set(endpoints.map(endpoint => endpoint?.tag)
        .filter(tag => typeof tag === 'string' && validProviders([tag])))];
}

function numeric(value, maximum = Infinity) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 && result <= maximum ? result : null;
}

function displayString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function quantizationValue(value) {
    const quantization = displayString(value);
    return quantization?.toLowerCase() === 'unknown' ? null : quantization;
}

function regionFor(endpoint) {
    const explicit = displayString(endpoint.region);
    if (explicit) return explicit;
    const pieces = endpoint.tag.split('/');
    if (pieces.length < 3) return null;
    const region = pieces.slice(1, -1).join('/');
    return /^(?:global|us|eu|uk|ca|au|asia|africa|europe|australia|northamerica|southamerica)(?:[-_][a-z0-9]+)*$/.test(region)
        ? region : null;
}

/** Public API values: USD per million tokens, median latency in seconds, uptime %. */
export function discoverFlexEndpoints(data) {
    const tags = discoverFlexProviders(data);
    return tags.map(tag => {
        const endpoint = data.data.endpoints.find(item => item?.tag === tag);
        const input = numeric(endpoint.pricing?.prompt);
        const output = numeric(endpoint.pricing?.completion);
        return {
            tag,
            provider: displayString(endpoint.provider_name),
            region: regionFor(endpoint),
            inputPrice: input === null ? null : numeric(input * 1e6),
            outputPrice: output === null ? null : numeric(output * 1e6),
            latency: numeric(endpoint.latency_last_30m?.p50),
            uptime: numeric(endpoint.uptime_last_30m ?? endpoint.uptime_last_1d, 100),
            quantization: quantizationValue(endpoint.quantization),
        };
    });
}

/** Explain automatic routing without changing routing or weakening a filter. */
export function configurationWarnings({ providers = [], endpoints = [], quantizations = [], stale = false, checked = false } = {}) {
    if (!checked || stale) return ['Endpoint availability is not verified. Normal routing is used until a current catalog is available for this model.'];
    const advertised = endpoints.filter(endpoint => validProviders([endpoint?.tag]));
    if (!advertised.length) return ['This model has no advertised Flex endpoints. Normal routing is used automatically.'];
    const warnings = [];
    if (!advertised.some(endpoint => providers.includes(endpoint.tag))) {
        warnings.push('No preferred endpoint is advertised for this model. Its available Flex endpoints are used automatically.');
    }
    if (Array.isArray(quantizations) && quantizations.length
        && advertised.every(endpoint => quantizationValue(endpoint.quantization) !== null)
        && advertised.every(endpoint => !quantizations.includes(quantizationValue(endpoint.quantization)))) {
        warnings.push('The selected quantization filter excludes every advertised Flex endpoint. Requests may fail.');
    }
    warnings.push('Catalog availability does not verify account access. Account restrictions and quantization filters still apply.');
    return warnings;
}
