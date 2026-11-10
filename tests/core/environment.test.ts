import { describe, expect, it, vi } from 'vitest';
import { emulateBlock, emulateProblems } from '../../src/core/blocks/emulate';
import type { EmulateConfig } from '../../src/core/blocks/emulate';
import { clearSiteDataBlock, parseSiteOrigins } from '../../src/core/blocks/clearSiteData';
import type { BlockContext } from '../../src/core/types';

const config = (patch: Partial<EmulateConfig> = {}): EmulateConfig => ({ ...emulateBlock.defaultConfig, ...patch });

describe('Emulate block', () => {
  it('passes precise viewport, zero coordinates, media and network settings through Host', async () => {
    const emulate = vi.fn(async () => {});
    const ctx = { config: config({ device: 'pixel', width: 600, height: 900, deviceScaleFactor: 2, latitude: '0', longitude: '0', locale: 'fr-FR', timezone: 'Europe/Paris', colorScheme: 'dark', reducedMotion: 'reduce', offline: true }), host: { environment: { emulate } }, log: vi.fn() } as unknown as BlockContext<EmulateConfig>;
    const result = await emulateBlock.run!(ctx, { keep: 'data', $session: { tabs: { main: 8 } } });
    expect(emulate).toHaveBeenCalledWith(8, expect.objectContaining({ device: 'pixel', width: 600, height: 900, latitude: 0, longitude: 0, accuracy: 1, locale: 'fr-FR', timezone: 'Europe/Paris', colorScheme: 'dark', reducedMotion: 'reduce', offline: true }));
    expect(result).toMatchObject({ keep: 'data', emulated: { action: 'set', device: 'pixel' } });
  });

  it('rejects incomplete coordinates/viewport, invalid scale, locale and timezone', () => {
    expect(emulateProblems(config({ latitude: '1' }))).toContainEqual(expect.objectContaining({ key: 'latitude' }));
    expect(emulateProblems(config({ longitude: '181', latitude: '91' })).map((p) => p.key)).toEqual(expect.arrayContaining(['latitude', 'longitude']));
    expect(emulateProblems(config({ width: 300 }))).toContainEqual(expect.objectContaining({ key: 'width' }));
    expect(emulateProblems(config({ width: 100.5, height: 200 }))).toContainEqual(expect.objectContaining({ key: 'width' }));
    expect(emulateProblems(config({ deviceScaleFactor: 9, timezone: 'Not/A_Zone', locale: 'no locale' })).map((p) => p.key)).toEqual(expect.arrayContaining(['deviceScaleFactor', 'timezone', 'locale']));
  });

  it('allows template values at design time, but checks rendered coordinates before the Host', async () => {
    expect(emulateProblems(config({ latitude: '{{lat}}', longitude: '{{lon}}', timezone: '{{zone}}', locale: '{{locale}}' }))).toEqual([]);
    const emulate = vi.fn();
    const ctx = { config: config({ latitude: 'NaN', longitude: '2' }), host: { environment: { emulate } } } as unknown as BlockContext<EmulateConfig>;
    await expect(emulateBlock.run!(ctx, { $session: { tabs: { main: 8 } } })).rejects.toMatchObject({ code: 'config.invalid' });
    expect(emulate).not.toHaveBeenCalled();
  });

  it('does not require old settings to be valid when clearing', () => {
    expect(emulateProblems(config({ action: 'clear', latitude: 'invalid', width: 90 }))).toEqual([]);
  });
});

describe('Clear Site Data block', () => {
  it('requires explicit HTTP(S) origins and normalises/deduplicates them', () => {
    expect(parseSiteOrigins('https://shop.example.com/\nhttp://127.0.0.1:8080, https://shop.example.com')).toEqual(['https://shop.example.com', 'http://127.0.0.1:8080']);
    for (const text of ['', '*', 'https://*.example.com', 'https://shop.example.com/path', 'https://me:secret@example.com', 'file:///tmp/a', 'https://example.com?all=true', 'https://example.com/#x']) expect(() => parseSiteOrigins(text)).toThrow();
  });

  it('passes only the explicit origin list to Host, preserving input', async () => {
    const clearSiteData = vi.fn(async () => {});
    const ctx = { config: { origins: 'https://shop.example.com' }, host: { environment: { clearSiteData } }, log: vi.fn() } as unknown as BlockContext<{ origins: string }>;
    expect(await clearSiteDataBlock.run!(ctx, { keep: true })).toEqual({ keep: true, clearedOrigins: ['https://shop.example.com'] });
    expect(clearSiteData).toHaveBeenCalledWith({ origins: ['https://shop.example.com'] });
  });

  it('exposes the irreversible cookie-domain scope in help and refuses malformed runtime values', async () => {
    expect(clearSiteDataBlock.description).toMatch(/registrable domain/);
    expect(clearSiteDataBlock.fields[0]?.help).toMatch(/permanent/);
    const clearSiteData = vi.fn();
    const ctx = { config: { origins: 'https://example.com/path' }, host: { environment: { clearSiteData } } } as unknown as BlockContext<{ origins: string }>;
    await expect(clearSiteDataBlock.run!(ctx, {})).rejects.toMatchObject({ code: 'config.invalid' });
    expect(clearSiteData).not.toHaveBeenCalled();
  });
});
