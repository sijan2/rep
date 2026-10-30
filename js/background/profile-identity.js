// local survives browser restarts; session survives MV3 worker suspension but is
// cleared on profile shutdown. Native-host reconnects must not change either.
export async function loadProfileIdentity(chromeApi, fetchResource = globalThis.fetch) {
    const local = await chromeApi.storage.local.get('rep_profile_id');
    let profile = local.rep_profile_id;
    if (!/^profile_[a-f0-9]{32}$/.test(profile || '')) {
        profile = 'profile_' + crypto.randomUUID().replaceAll('-', '');
        await chromeApi.storage.local.set({ rep_profile_id: profile });
    }
    const session = await chromeApi.storage.session.get('rep_browser_epoch');
    let epoch = session.rep_browser_epoch;
    if (!/^epoch_[a-f0-9]{32}$/.test(epoch || '')) {
        epoch = 'epoch_' + crypto.randomUUID().replaceAll('-', '');
        await chromeApi.storage.session.set({ rep_browser_epoch: epoch });
    }
    let digest = '';
    try {
        const response = await fetchResource(chromeApi.runtime.getURL('build-info.json'));
        const info = await response.json();
        if (/^[a-f0-9]{64}$/.test(info.digest || '')) digest = info.digest;
    } catch (_) { /* A source checkout without build metadata is detectable. */ }
    return { profile_id: profile, browser_epoch: epoch, build_digest: digest };
}
