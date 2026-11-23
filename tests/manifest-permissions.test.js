import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8'));

describe('extension permission boundaries', () => {
    it('keeps browser-control APIs required', () => {
        expect(manifest.permissions).toEqual(expect.arrayContaining([
            'alarms',
            'debugger',
            'nativeMessaging',
            'storage',
            'tabs'
        ]));
    });

    it('keeps passive traffic access optional', () => {
        expect(manifest.permissions).not.toContain('webRequest');
        expect(manifest.optional_permissions).toContain('webRequest');
        expect(manifest).not.toHaveProperty('host_permissions');
        expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    });

    it('no longer requests the local model proxy origins removed with the AI chat', () => {
        const text = JSON.stringify(manifest);
        expect(text).not.toMatch(/11434/);
        expect(text).not.toMatch(/localhost|127\.0\.0\.1/);
        expect(manifest.description).not.toMatch(/AI/);
    });
});
