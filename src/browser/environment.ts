import { browser } from 'wxt/browser';
import { CodedError } from '../core/errors';
import { parseSiteOrigins } from '../core/blocks/clearSiteData';
import type { ClearSiteDataOptions, EmulateOptions } from '../core/network';
import type { CdpSend } from './cdpSessions';
import type { M3Runtime } from './m3Runtime';

/** Small, explicit presets, not claims of complete device/browser emulation. */
export const DEVICE_PRESETS = {
  iphone: { width: 390, height: 844, scale: 3, mobile: true, platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  pixel: { width: 412, height: 915, scale: 2.625, mobile: true, platform: 'Linux armv8l', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  ipad: { width: 820, height: 1180, scale: 2, mobile: true, platform: 'iPad', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  desktop: { width: 1440, height: 900, scale: 1, mobile: false, platform: '', userAgent: '' },
} as const;

type Group = 'metrics' | 'touch' | 'ua' | 'locale' | 'timezone' | 'geo' | 'media' | 'network';
interface Overrides { groups: Set<Group> }
const ended = () => new CodedError('step.failed', 'This run has ended; its environment can no longer be changed.');
const disconnected = (error: unknown) => /debugger.*(?:detached|not attached)|tab.*closed|no tab with|no target with|target closed/i.test(String(error));

function checkOptions(options: EmulateOptions): void {
  const invalid = (message: string): never => { throw new CodedError('config.invalid', message); };
  if (!['set', 'clear'].includes(options.action)) invalid('Emulate action must be set or clear.');
  if (options.action === 'clear') return;
  if (options.device && !Object.hasOwn(DEVICE_PRESETS, options.device)) invalid('Unknown device preset.');
  for (const key of ['width', 'height'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 10000)) invalid(`${key} must be an integer from 1 to 10000.`);
  }
  if ((options.width === undefined) !== (options.height === undefined)) invalid('Supply both viewport width and height.');
  if (options.deviceScaleFactor !== undefined && (!Number.isFinite(options.deviceScaleFactor) || options.deviceScaleFactor <= 0 || options.deviceScaleFactor > 8)) invalid('Device scale factor must be greater than 0 and at most 8.');
  if ((options.latitude === undefined) !== (options.longitude === undefined)) invalid('Supply both latitude and longitude.');
  if (options.latitude !== undefined && (!Number.isFinite(options.latitude) || Math.abs(options.latitude) > 90)) invalid('Latitude must be from -90 to 90.');
  if (options.longitude !== undefined && (!Number.isFinite(options.longitude) || Math.abs(options.longitude) > 180)) invalid('Longitude must be from -180 to 180.');
  if (options.accuracy !== undefined && (!Number.isFinite(options.accuracy) || options.accuracy < 0)) invalid('Accuracy must be non-negative.');
  if (options.colorScheme !== undefined && !['', 'light', 'dark'].includes(options.colorScheme)) invalid('Invalid color scheme.');
  if (options.reducedMotion !== undefined && !['', 'reduce', 'no-preference'].includes(options.reducedMotion)) invalid('Invalid reduced-motion preference.');
  if (options.offline !== undefined && typeof options.offline !== 'boolean') invalid('Offline must be a boolean.');
  if (options.userAgent && /[\r\n\0]/.test(options.userAgent)) invalid('User agent cannot contain control characters.');
  if (options.locale) { try { Intl.getCanonicalLocales(options.locale); } catch { invalid('Use a valid locale such as en-US.'); } }
  if (options.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: options.timezone }); } catch { invalid('Use a valid IANA timezone.'); } }
}

/** Reset only groups changed by this run. No Browser.grantPermissions or profile-wide mutations. */
async function reset(send: CdpSend, state: Overrides): Promise<void> {
  const commands: [Group, string, Record<string, unknown>][] = [
    ['network', 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    ['metrics', 'Emulation.clearDeviceMetricsOverride', {}],
    ['touch', 'Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['ua', 'Emulation.setUserAgentOverride', { userAgent: '' }],
    ['locale', 'Emulation.setLocaleOverride', { locale: '' }],
    ['timezone', 'Emulation.setTimezoneOverride', { timezoneId: '' }],
    ['geo', 'Emulation.clearGeolocationOverride', {}],
    ['media', 'Emulation.setEmulatedMedia', { media: '', features: [] }],
  ];
  const errors: unknown[] = [];
  for (const [group, method, params] of commands) {
    if (!state.groups.has(group)) continue;
    try { await send(method, params); state.groups.delete(group); }
    catch (error) {
      if (disconnected(error)) { state.groups.clear(); return; }
      errors.push(error);
    }
  }
  if (errors.length) throw new Error(`Could not reset environment overrides: ${errors.map(String).join('; ')}`);
}

/** Per-run environment controller, sharing the run's CDP session and cleanup rules. */
export function createEnvironment(runtime: M3Runtime) {
  const states = new Map<number, Overrides>();
  const tails = new Map<number, Promise<void>>();
  let closed = false;
  const assertOpen = () => { if (closed || runtime.isClosed()) throw ended(); };
  const serial = (tabId: number, task: () => Promise<void>) => {
    const pending = (tails.get(tabId) ?? Promise.resolve()).catch(() => {}).then(task);
    tails.set(tabId, pending);
    void pending.finally(() => { if (tails.get(tabId) === pending) tails.delete(tabId); }).catch(() => {});
    return pending;
  };

  return {
    async emulate(tabId: number, options: EmulateOptions): Promise<void> {
      assertOpen(); checkOptions(options); runtime.claim(tabId, 'emulation');
      return serial(tabId, async () => {
        assertOpen();
        await runtime.withTab(tabId, async (send) => {
          const state = states.get(tabId) ?? { groups: new Set<Group>() };
          states.set(tabId, state);
          await reset(send, state);
          if (options.action === 'clear') { states.delete(tabId); return; }
          const change = async (group: Group, method: string, params: Record<string, unknown>) => {
            assertOpen(); state.groups.add(group); await send(method, params);
          };
          try {
            const preset = options.device ? DEVICE_PRESETS[options.device] : undefined;
            if (preset || options.width !== undefined || options.deviceScaleFactor !== undefined) {
              let width = options.width ?? preset?.width;
              let height = options.height ?? preset?.height;
              if (width === undefined || height === undefined) {
                const metrics = await send('Page.getLayoutMetrics') as { cssLayoutViewport?: { clientWidth: number; clientHeight: number }; layoutViewport?: { clientWidth: number; clientHeight: number } };
                width ??= metrics.cssLayoutViewport?.clientWidth ?? metrics.layoutViewport?.clientWidth;
                height ??= metrics.cssLayoutViewport?.clientHeight ?? metrics.layoutViewport?.clientHeight;
              }
              if (!(width && height)) throw new CodedError('step.failed', 'The tab returned no viewport size for emulation.');
              await change('metrics', 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: options.deviceScaleFactor ?? preset?.scale ?? 1, mobile: preset?.mobile ?? false, screenWidth: width, screenHeight: height });
              if (preset) await change('touch', 'Emulation.setTouchEmulationEnabled', { enabled: preset.mobile, ...(preset.mobile ? { maxTouchPoints: 5 } : {}) });
            }
            const userAgent = options.userAgent ?? preset?.userAgent;
            if (userAgent !== undefined || options.locale) {
              await change('ua', 'Emulation.setUserAgentOverride', { userAgent: userAgent ?? '', ...(preset?.platform ? { platform: preset.platform } : {}), ...(options.locale ? { acceptLanguage: options.locale } : {}) });
            }
            if (options.locale) await change('locale', 'Emulation.setLocaleOverride', { locale: Intl.getCanonicalLocales(options.locale)[0]!.replace(/-/g, '_') });
            if (options.timezone) await change('timezone', 'Emulation.setTimezoneOverride', { timezoneId: options.timezone });
            if (options.latitude !== undefined && options.longitude !== undefined) await change('geo', 'Emulation.setGeolocationOverride', { latitude: options.latitude, longitude: options.longitude, accuracy: options.accuracy ?? 1 });
            if (options.colorScheme || options.reducedMotion) {
              const features = [
                ...(options.colorScheme ? [{ name: 'prefers-color-scheme', value: options.colorScheme }] : []),
                ...(options.reducedMotion ? [{ name: 'prefers-reduced-motion', value: options.reducedMotion }] : []),
              ];
              await change('media', 'Emulation.setEmulatedMedia', { media: '', features });
            }
            if (options.offline !== undefined) await change('network', 'Network.emulateNetworkConditions', { offline: options.offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
          } catch (error) {
            // Roll back partial application; retain failed groups for the mandatory run cleanup retry.
            await reset(send, state).catch(() => {});
            if (state.groups.size === 0) states.delete(tabId);
            throw error;
          }
        });
      });
    },

    async clearSiteData(options: ClearSiteDataOptions): Promise<void> {
      assertOpen();
      let origins: ReturnType<typeof parseSiteOrigins>;
      try { origins = parseSiteOrigins(options.origins.join('\n')); }
      catch (error) { throw new CodedError('config.invalid', error instanceof Error ? error.message : String(error)); }
      // Firefox has hostname filtering instead of Chromium's origin filter for several data types.
      // Never fall back to an unfiltered remove: that would delete unrelated sites' data.
      const firefox = typeof (browser.runtime as unknown as { getBrowserInfo?: unknown }).getBrowserInfo === 'function';
      if (firefox || !browser.browsingData || !(await browser.permissions.contains({ permissions: ['browsingData'] }).catch(() => false))) {
        throw new CodedError('permission.missing', 'Clear Site Data needs Chromium and the optional browsingData permission. Exact-origin deletion for all selected data types is not supported here; no data was cleared.');
      }
      assertOpen();
      await browser.browsingData.remove({ origins, since: 0 }, { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true });
    },

    async finish(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.allSettled(tails.values());
      const results = await Promise.allSettled([...states].map(async ([tabId, state]) => {
        try { await runtime.cleanupTab(tabId, (send) => reset(send, state)); }
        catch (error) { if (!disconnected(error)) throw error; }
        states.delete(tabId);
      }));
      const errors = results.flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : []);
      if (errors.length) throw new Error(errors.join('; '));
    },
  };
}
