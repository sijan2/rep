const DEFAULT_RELOAD_DELAY_MS = 150;

export function scheduleExtensionReload({
    chromeApi = globalThis.chrome,
    schedule = globalThis.setTimeout,
    delayMs = DEFAULT_RELOAD_DELAY_MS,
} = {}) {
    if (typeof chromeApi?.runtime?.reload !== 'function') {
        const error = new Error('chrome.runtime.reload is unavailable');
        error.code = 'reload_unavailable';
        throw error;
    }
    const boundedDelay = Math.max(50, Math.min(2000, Math.round(Number(delayMs) || DEFAULT_RELOAD_DELAY_MS)));
    schedule(() => chromeApi.runtime.reload(), boundedDelay);
    return { reloading: true, delay_ms: boundedDelay };
}
