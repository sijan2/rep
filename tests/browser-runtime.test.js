import { describe, expect, it, vi } from 'vitest';
import { BrowserRuntime } from '../js/background/browser-runtime.js';
import { CDPCaptureController } from '../js/background/cdp-capture.js';

function fixture() {
    const listeners = [];
    const onDetach = { addListener(fn) { listeners.push(fn); }, emit(source) { for (const fn of listeners) fn(source); } };
    const chromeApi = {
        runtime: { lastError: null },
        debugger: {
            onDetach, onEvent: { addListener() {} },
            attach: vi.fn((_target, _version, done) => done()),
            detach: vi.fn((_target, done) => done()),
            sendCommand: vi.fn((_target, _method, _params, done) => done({ fixture: true })),
        },
    };
    return { chromeApi, onDetach };
}

describe('standalone browser runtime', () => {
    it('runs CDP without a capture controller or capture state', async () => {
        const { chromeApi } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        const result = await runtime.sendCDP({ tab_id: 7, method: 'DOM.getDocument' });
        expect(result.result).toEqual({ fixture: true });
        expect(chromeApi.debugger.attach).toHaveBeenCalledOnce();
        expect(chromeApi.debugger.detach).toHaveBeenCalledOnce();
        expect(runtime.sessions).toBeUndefined();
    });

    it('reuses an explicit attachment and forgets it after external detach', async () => {
        const { chromeApi, onDetach } = fixture();
        const runtime = new BrowserRuntime({ chromeApi });
        await runtime.attachControl({ tab_id: 7 });
        await runtime.sendCDP({ tab_id: 7, method: 'DOM.getDocument' });
        expect(chromeApi.debugger.attach).toHaveBeenCalledOnce();
        expect(chromeApi.debugger.detach).not.toHaveBeenCalled();
        onDetach.emit({ tabId: 7 });
        expect(runtime.reloadBlockers().attached_targets).toBe(0);
    });

    it('keeps capture ownership checks across the runtime boundary', async () => {
        const { chromeApi } = fixture();
        const runtime = new CDPCaptureController({ chromeApi });
        runtime.sessions.set(7, { attached: true });
        await expect(runtime.attachControl({ tab_id: 7 })).rejects.toMatchObject({ code: 'tab_busy' });
        expect(chromeApi.debugger.attach).not.toHaveBeenCalled();
        expect(() => runtime.beginReload()).toThrow('browser operations are active');
    });
});

describe('child session commands', () => {
    function hanging() {
        const events = [];
        const chromeApi = {
            runtime: { lastError: null },
            debugger: {
                onDetach: { addListener() {} },
                onEvent: { addListener(fn) { events.push(fn); } },
                attach: vi.fn((_t, _v, done) => done()), detach: vi.fn((_t, done) => done()),
                // Chromium does not answer a command to a detaching child promptly.
                sendCommand: vi.fn((target, _method, _params, done) => { if (!target.sessionId) done({ root: true }); }),
            },
        };
        return { chromeApi, emit: (...args) => events.forEach(fn => fn(...args)) };
    }

    it('fails in-flight commands as soon as their child target detaches', async () => {
        const { chromeApi, emit } = hanging();
        const runtime = new BrowserRuntime({ chromeApi });
        const child = runtime.sendDebugCommand({ tabId: 7, sessionId: 'frame' }, 'Runtime.runIfWaitingForDebugger', {});
        const other = runtime.sendDebugCommand({ tabId: 7, sessionId: 'other' }, 'Network.enable', {});
        emit({ tabId: 7 }, 'Target.detachedFromTarget', { sessionId: 'frame' });
        await expect(child).rejects.toMatchObject({ code: 'target_detached' });
        await expect(runtime.sendDebugCommand({ tabId: 7 }, 'Page.enable', {})).resolves.toEqual({ root: true });
        expect(runtime.childCommands.has('7:other')).toBe(true);
        runtime.handleDebuggerDetach({ tabId: 7 });
        await expect(other).rejects.toMatchObject({ code: 'target_detached' });
        expect(runtime.childCommands.size).toBe(0);
    });
});

describe('capture deadline accounting', () => {
    it('allows real remaining time below one second without extending the deadline', async () => {
        const { chromeApi } = fixture();
        const runtime = new CDPCaptureController({ chromeApi });
        const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1001);
        try {
            const task = vi.fn(async params => params.timeout_ms);
            await expect(runtime.runExplicitCapture({ timeout_ms: 1000 }, 'fixture', task)).resolves.toBe(999);
            expect(task).toHaveBeenCalledOnce();
        } finally { clock.mockRestore(); }
    });

    it('does not run a queued operation after its actual deadline expires', async () => {
        const { chromeApi } = fixture();
        const runtime = new CDPCaptureController({ chromeApi });
        const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);
        try {
            const task = vi.fn();
            await expect(runtime.runExplicitCapture({ timeout_ms: 1000 }, 'fixture', task)).rejects.toMatchObject({ code: 'capture_queue_timeout' });
            expect(task).not.toHaveBeenCalled();
            expect(runtime.captureOperationActive).toBe(false);
            expect(runtime.queuedCaptures).toBe(0);
        } finally { clock.mockRestore(); }
    });
});
