import { describe, expect, it, vi } from 'vitest';
import { CDPCaptureController } from '../js/background/cdp-capture.js';

function fixture({ purpose = 'execute', preflight = async () => true, value = null } = {}) {
    const emitted = [];
    const hook = { addListener() {} };
    const chromeApi = {
        runtime: { lastError: null },
        tabs: { get: (id, done) => done({ id, url: 'https://fixture.test/' }) },
        debugger: {
            onEvent: hook, onDetach: hook,
            attach: (_target, _version, done) => done(), detach: (_target, done) => done(),
            sendCommand: (_target, method, _params, done) => done(method === 'Runtime.evaluate' ? { result: { type: 'string', value } } : {}),
        },
    };
    const controller = new CDPCaptureController({ chromeApi, emit: item => emitted.push(item), capturePreflight: preflight });
    controller.semantic.lease = () => ({ lease: { purpose } });
    controller.semantic.activeExecution = () => true;
    return { controller, emitted };
}

const params = { tab_id: 42, owner: 'fixture/task', lease_id: 'fixture-lease', timeout_ms: 1000 };

describe('capture-session lease and deadline guarantees', () => {
    it('rejects a read lease before reserving the capture queue', () => {
        const { controller } = fixture({ purpose: 'observe' });
        expect(() => controller.beginAgentCapture(params)).toThrowError(/execution lease/);
        expect(controller.captureActivity()).toEqual({ active_captures: 0, queued_captures: 0 });
    });
    it('releases the queue after preflight failure without dispatching input', async () => {
        const { controller, emitted } = fixture({ preflight: async () => { throw Error('synthetic preflight failure'); } });
        await expect(controller.beginAgentCapture(params)).rejects.toThrow('synthetic preflight failure');
        expect(controller.captureActivity()).toEqual({ active_captures: 0, queued_captures: 0 });
        expect(emitted).toEqual([]);
    });
    it('bounds abandoned recordings and retains an idempotent end result', async () => {
        vi.useFakeTimers();
        try {
            const { controller, emitted } = fixture();
            const begun = await controller.beginAgentCapture({ ...params, max_body_bytes: 4096, capture_limits: { max_total_body_bytes: 8192 } });
            expect(controller.sessions.get(42).maxBodyBytes).toBe(4096);
            expect(controller.sessions.get(42).limits.max_total_body_bytes).toBe(8192);
            await expect(controller.endAgentCapture({ ...begun, owner: params.owner, capture_token: 'wrong' })).rejects.toMatchObject({ code: 'capture_not_owned' });
            await vi.advanceTimersByTimeAsync(1200);
            const result = await controller.endAgentCapture({ ...begun, owner: params.owner });
            expect(result.timed_out).toBe(true);
            expect(controller.sessions.size).toBe(0);
            expect(controller.captureActivity().active_captures).toBe(0);
            expect(emitted.filter(item => item.action === 'session_end')).toHaveLength(1);
        } finally { vi.useRealTimers(); }
    });
    it('marks an observed bodyless request as not applicable', async () => {
        const { controller } = fixture();
        const begun = await controller.beginAgentCapture(params);
        const session = controller.sessions.get(42);
        controller.onRequestWillBeSent(session, { requestId: 'get', request: { method: 'GET', url: 'https://fixture.test/data', headers: {} }, type: 'Fetch', timestamp: 1 });
        expect(session.requestList()[0].request_body_capture).toMatchObject({ state: 'not_applicable', reason: 'no_request_body', captured_bytes: 0 });
        session.blocking.clear();
        await controller.endAgentCapture({ ...begun, owner: params.owner });
    });
    it('retains an action value larger than the removed 256 KiB ceiling', async () => {
        const value = 'x'.repeat(300 * 1024);
        const { controller } = fixture({ value });
        controller.semantic.activeExecution = () => false;
        const result = await controller.action({ ...params, expression: 'fixture', max_result_bytes: 1024 * 1024, settle_ms: 0, idle_ms: 50 });
        expect(result.evaluation_truncated).toBe(false);
        expect(result.evaluation.result.value).toBe(value);
    });
});
