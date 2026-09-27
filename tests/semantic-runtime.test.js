import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { BrowserRuntime } from '../js/background/browser-runtime.js';

const ax = (id, role, name, parentId = '', properties = []) => ({ nodeId: id, backendDOMNodeId: Number(id.replace(/\D/g, '')) || 1,
    role: { value: role }, name: { value: name }, parentId, properties });
function events() {
    const listeners = [];
    return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}
function fixture({ nested = false } = {}) {
    const onEvent = events(), onDetach = events();
    const nodeSets = new Map([['top', [ax('1', 'RootWebArea', 'Products'), ax('2', 'button', 'Save', '1')]]]);
    const loaders = { top: 'l1', local: 'l2', remote: 'l3', deep: 'l4' };
    const urls = { top: 'https://example.test/page', local: 'https://example.test/frame', remote: 'https://other.test/page', deep: 'https://deep.test/page' };
    const owners = { top: '', local: '', remote: 's1', deep: 's2' };
    const branch = id => ({ frame: { id, loaderId: loaders[id], url: urls[id] } });
    const tree = sessionId => {
        if (!nested) return branch('top');
        if (sessionId === 's2') return branch('deep');
        if (sessionId === 's1') return { ...branch('remote'), childFrames: [branch('deep')] };
        return { ...branch('top'), childFrames: [branch('local'), { ...branch('remote'), childFrames: [branch('deep')] }] };
    };
    if (nested) for (const [index, id] of ['local', 'remote', 'deep'].entries()) nodeSets.set(id, [ax(`${index + 2}00`, 'RootWebArea', id), ax(`${index + 2}01`, 'button', `Save ${id}`, `${index + 2}00`)]);
    const attached = new Set();
    const chromeApi = { runtime: { lastError: null }, debugger: {
        onEvent, onDetach,
        attach: vi.fn((_debuggee, _version, done) => done()),
        detach: vi.fn((_debuggee, done) => done()),
        sendCommand: vi.fn((debuggee, method, params, done) => {
            const sessionId = debuggee.sessionId || '';
            if (method === 'Runtime.enable') {
                for (const [index, id] of Object.keys(owners).entries()) if ((nested || id === 'top') && owners[id] === sessionId) {
                    onEvent.emit(debuggee, 'Runtime.executionContextCreated', { context: { id: index + 10, auxData: { isDefault: true, frameId: id } } });
                }
            }
            if (method === 'Target.setAutoAttach' && nested && params.autoAttach) {
                const child = sessionId === '' ? 's1' : sessionId === 's1' ? 's2' : '';
                if (child && !attached.has(child)) { attached.add(child); onEvent.emit(debuggee, 'Target.attachedToTarget', { sessionId: child, targetInfo: { type: 'iframe' } }); }
            }
            if (method === 'Page.getFrameTree') return done({ frameTree: tree(sessionId) });
            if (method === 'Accessibility.getFullAXTree') {
                if (owners[params.frameId] !== sessionId) throw new Error('incorrect frame session');
                return done({ nodes: nodeSets.get(params.frameId) });
            }
            done({ ok: true });
        }),
    } };
    const runtime = new BrowserRuntime({ chromeApi });
    return { runtime, chromeApi, nodeSets, loaders, urls, onEvent, onDetach };
}
const base = { tab_id: 7, owner: 'workspace/task', kind: 'controls' };
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('compact semantic observations', () => {
    it('preserves row relationships and detects changed competing evidence without any event', async () => {
        const { runtime, nodeSets, chromeApi } = fixture();
        const rows = [ax('1', 'RootWebArea', 'Products'), ax('2', 'row', '', '1'), ax('3', 'StaticText', 'Basic $10', '2'), ax('4', 'button', 'Buy', '2'),
            ax('5', 'row', '', '1'), ax('6', 'StaticText', 'Pro $20', '5'), ax('7', 'button', 'Buy', '5')];
        nodeSets.set('top', rows);
        const snapshot = await runtime.observe(base);
        expect(snapshot.schema).toBe(1);
        expect(snapshot.candidates.map(candidate => candidate.context_relations[0])).toEqual([{ role: 'row', name: 'Basic $10' }, { role: 'row', name: 'Pro $20' }]);
        const stable = await runtime.validateObservation({ ...base, generation: snapshot.generation, fingerprint: snapshot.fingerprint });
        expect(stable.fresh).toBe(true);
        rows[2].name.value = 'Basic $30';
        const changed = await runtime.validateObservation({ ...base, generation: snapshot.generation, fingerprint: snapshot.fingerprint });
        expect(changed.fresh).toBe(false);
        expect(changed.snapshot.fingerprint).not.toBe(snapshot.fingerprint);
        expect(chromeApi.debugger.attach).toHaveBeenCalledOnce();
        expect(chromeApi.debugger.detach).not.toHaveBeenCalled();
        expect(chromeApi.debugger.sendCommand.mock.calls.filter(call => call[1] === 'Accessibility.getFullAXTree')).toHaveLength(3);
    });

    it('does not expose field values through related row text', async () => {
        const { runtime, nodeSets } = fixture();
        nodeSets.set('top', [ax('1', 'RootWebArea', 'Form'), ax('2', 'row', '', '1'), ax('3', 'StaticText', 'Public label', '2'),
            { ...ax('4', 'textbox', 'Password', '2'), value: { value: 'private-field-secret' } }, ax('5', 'StaticText', 'private-field-secret', '4'), ax('6', 'button', 'Save', '2')]);
        const snapshot = await runtime.observe(base);
        expect(JSON.stringify(snapshot)).not.toContain('private-field-secret');
        expect(snapshot.candidates.find(item => item.name === 'Save').context_relations).toContainEqual({ role: 'row', name: 'Public label' });
    });

    it('invalidates none results when a new matching candidate is added', async () => {
        const { runtime, nodeSets } = fixture();
        const snapshot = await runtime.observe(base);
        nodeSets.get('top').push(ax('3', 'button', 'New action', '1'));
        expect((await runtime.validateObservation({ ...base, ...snapshot })).fresh).toBe(false);
    });

    it('reports inaccessible frames and preserves origin coverage', async () => {
        const { runtime } = fixture({ nested: true });
        const snapshot = await runtime.observe({ ...base, origin: 'https://example.test' });
        expect(snapshot.coverage.frames_read).toBe(2);
        expect(snapshot.coverage.unavailable_frames).toBe(2);
        expect(snapshot.coverage.frame_issues.every(issue => issue.reason === 'outside_origin')).toBe(true);
    });

    it('supports exact frame URL scopes and rejects missing or ambiguous scopes', async () => {
        const { runtime, urls } = fixture({ nested: true });
        const scoped = await runtime.observe({ ...base, frame_url: urls.remote });
        expect(scoped.coverage.frames_read).toBe(1);
        expect(scoped.candidates[0].name).toBe('Save remote');
        await expect(runtime.observe({ ...base, frame_url: 'https://missing.test/' })).rejects.toMatchObject({ code: 'frame_unavailable' });
        urls.deep = urls.remote;
        await expect(runtime.observe({ ...base, frame_url: urls.remote })).rejects.toMatchObject({ code: 'ambiguous_frame' });
    });

    it('bounds wire projections and marks omitted candidates as incomplete', async () => {
        const { runtime, nodeSets, urls } = fixture();
        urls.top += '/' + 'x'.repeat(10000);
        nodeSets.set('top', [ax('1', 'RootWebArea', 'Large page'), ...Array.from({ length: 100 }, (_, n) => ax(String(n + 2), 'button', 'Action ' + n, '1'))]);
        const snapshot = await runtime.observe(base);
        expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThan(768 * 1024);
        expect(snapshot.coverage.truncated).toBe(true);
        expect(snapshot.coverage.omitted_nodes).toBeGreaterThan(0);
        expect(snapshot.coverage.total_candidates).toBe(snapshot.candidates.length);
        expect(snapshot.coverage.observed_candidates).toBe(100);
        expect([...runtime.semantic.sessions.get(7).index.values()].reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(512 * 1024);
    });
});

describe('session ownership and frame routing', () => {
    it('shares observation leases but gives exactly one caller execution ownership', async () => {
        const { runtime } = fixture();
        const first = await runtime.acquireLease({ ...base, purpose: 'execute' });
        const observer = await runtime.acquireLease({ ...base, owner: 'reader', purpose: 'observe' });
        await expect(runtime.acquireLease({ ...base, owner: 'second', purpose: 'execute' })).rejects.toMatchObject({ code: 'tab_busy' });
        await expect(runtime.sendCDP({ tab_id: 7, method: 'Runtime.evaluate', command_params: { expression: '1' } })).rejects.toMatchObject({ code: 'tab_busy' });
        await expect(runtime.sendCDP({ ...base, ...observer, owner: 'reader', method: 'Runtime.evaluate', command_params: { expression: '1' } })).rejects.toMatchObject({ code: 'execution_lease_required' });
        await expect(runtime.releaseLease({ ...base, ...first, owner: 'imposter' })).rejects.toMatchObject({ code: 'invalid_lease' });
        await runtime.releaseLease({ ...base, ...first });
        await expect(runtime.acquireLease({ ...base, owner: 'second', purpose: 'execute' })).resolves.toHaveProperty('lease_id');
    });

    it('routes same-process frames and recursively attached out-of-process frames', async () => {
        const { runtime, chromeApi } = fixture({ nested: true });
        const lease = await runtime.acquireLease({ ...base, purpose: 'execute' });
        const snapshot = await runtime.observe({ ...base, ...lease });
        expect(snapshot.coverage.frames_read).toBe(4);
        expect(snapshot.candidates.map(item => item.session_id)).toEqual(['', '', 's1', 's2']);
        for (const [frameId, expectedSession, contextId] of [['local', '', 11], ['remote', 's1', 12], ['deep', 's2', 13]]) {
            const candidate = snapshot.candidates.find(item => item.frame_id === frameId);
            await runtime.sendCDP({ ...base, ...lease, ...candidate, method: 'Runtime.evaluate', command_params: { expression: 'location.href' } });
            const last = chromeApi.debugger.sendCommand.mock.calls.at(-1);
            expect(last[0]).toEqual(expectedSession ? { tabId: 7, sessionId: expectedSession } : { tabId: 7 });
            expect(last[2].contextId).toBe(contextId);
        }
    });

    it('rejects stale documents and root URL changes before dispatch', async () => {
        const { runtime, chromeApi, loaders, urls } = fixture({ nested: true });
        const lease = await runtime.acquireLease({ ...base, purpose: 'execute' });
        const snapshot = await runtime.observe({ ...base, ...lease });
        const candidate = snapshot.candidates.find(item => item.frame_id === 'deep');
        const command = { ...base, ...lease, ...candidate, method: 'Runtime.evaluate', command_params: { expression: '1' } };
        loaders.deep = 'replacement';
        await expect(runtime.sendCDP(command)).rejects.toMatchObject({ code: 'stale_document' });
        expect(chromeApi.debugger.sendCommand.mock.calls.some(call => call[1] === 'Runtime.evaluate')).toBe(false);
        urls.top = 'https://example.test/other';
        await expect(runtime.sendCDP({ ...command, document_generation: '', expected_root_url: 'https://example.test/page' })).rejects.toMatchObject({ code: 'page_changed' });
    });

    it('rejects unknown frame contexts and mismatched child sessions', async () => {
        const { runtime } = fixture({ nested: true });
        const lease = await runtime.acquireLease({ ...base, purpose: 'execute' });
        await expect(runtime.sendCDP({ ...base, ...lease, frame_id: 'remote', session_id: 'wrong', method: 'Runtime.evaluate' })).rejects.toMatchObject({ code: 'stale_frame' });
        await expect(runtime.sendCDP({ ...base, ...lease, frame_id: 'missing', method: 'Runtime.evaluate' })).rejects.toMatchObject({ code: 'stale_frame' });
    });

    it('checks the actual target point against a cross-origin ancestor overlay before dispatch', async () => {
        const { runtime, chromeApi } = fixture({ nested: true });
        const lease = await runtime.acquireLease({ ...base, purpose: 'execute' });
        const original = chromeApi.debugger.sendCommand.getMockImplementation();
        chromeApi.debugger.sendCommand.mockImplementation((target, method, params, done) => {
            if (method === 'DOM.getFrameOwner') return done({ backendNodeId: 900 });
            if (method === 'DOM.resolveNode') return done({ object: { objectId: 'owner' } });
            if (method === 'Runtime.callFunctionOn' && params.objectId === 'owner') return done({ result: { value: { code: 'frame_owner_occluded' } } });
            return original(target, method, params, done);
        });
        await expect(runtime.sendCDP({ ...base, ...lease, frame_id: 'deep', frame_point: { x: 10, y: 10 }, method: 'Runtime.evaluate', command_params: { expression: '1' } })).rejects.toMatchObject({ code: 'frame_owner_occluded' });
        const owners = chromeApi.debugger.sendCommand.mock.calls.filter(call => call[1] === 'DOM.getFrameOwner');
        expect(owners[0][0]).toEqual({ tabId: 7, sessionId: 's1' });
        expect(chromeApi.debugger.sendCommand.mock.calls.some(call => call[1] === 'Runtime.evaluate')).toBe(false);
    });

    it('invalidates leases on host reconnect and detach', async () => {
        const { runtime, onDetach } = fixture();
        const lease = await runtime.acquireLease({ ...base, purpose: 'execute' });
        runtime.semantic.reconnect();
        await expect(runtime.sendCDP({ ...base, ...lease, method: 'DOM.describeNode' })).rejects.toMatchObject({ code: 'invalid_lease' });
        const next = await runtime.acquireLease({ ...base, purpose: 'execute' });
        expect(next.generation).not.toBe(lease.generation);
        onDetach.emit({ tabId: 7 });
        await expect(runtime.sendCDP({ ...base, ...next, method: 'DOM.describeNode' })).rejects.toMatchObject({ code: 'stale_session' });
    });

    it('advances document generations when context continuity is lost without navigation', async () => {
        const { runtime, onEvent } = fixture();
        const snapshot = await runtime.observe(base);
        onEvent.emit({ tabId: 7 }, 'Runtime.executionContextsCleared', {});
        const check = await runtime.validateObservation({ ...base, generation: snapshot.generation, fingerprint: snapshot.fingerprint });
        expect(check.fresh).toBe(false);
        expect(check.snapshot.candidates[0].document_generation).not.toBe(snapshot.candidates[0].document_generation);
    });
});
