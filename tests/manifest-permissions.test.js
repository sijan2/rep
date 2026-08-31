import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8'));

describe('extension permission boundaries', () => {
    it('keeps browser-control APIs required', () => {
        expect(manifest.permissions).toEqual(expect.arrayContaining([
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
        expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining([
            '<all_urls>',
            'http://localhost:11434/*',
            'http://127.0.0.1:11434/*'
        ]));
    });
});
