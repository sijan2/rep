import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { loadProfileIdentity } from '../js/background/profile-identity.js';
if (!globalThis.crypto?.randomUUID) globalThis.crypto = webcrypto;
const area = () => { const values = {}; return { values, async get(key) { return { [key]: values[key] }; }, async set(update) { Object.assign(values, update); } }; };
const fake = () => ({ storage: { local: area(), session: area() }, runtime: { getURL: path => 'fixture-extension/' + path } });
const fetchBuild = async () => ({ json: async () => ({ digest: 'a'.repeat(64) }) });
describe('profile identity', () => {
    it('survives host reconnect and worker restart while the epoch changes on profile restart', async () => {
        const chrome = fake();
        const first = await loadProfileIdentity(chrome, fetchBuild);
        expect(await loadProfileIdentity(chrome, fetchBuild)).toEqual(first);
        chrome.storage.session = area();
        const restarted = await loadProfileIdentity(chrome, fetchBuild);
        expect(restarted.profile_id).toBe(first.profile_id);
        expect(restarted.browser_epoch).not.toBe(first.browser_epoch);
        expect(restarted.build_digest).toBe('a'.repeat(64));
    });
    it('distinguishes two profiles and reports absent build metadata honestly', async () => {
        const a = await loadProfileIdentity(fake(), fetchBuild), b = await loadProfileIdentity(fake(), async () => { throw new Error('missing'); });
        expect(a.profile_id).not.toBe(b.profile_id);
        expect(b.build_digest).toBe('');
    });
});
