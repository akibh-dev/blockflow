import { CodedError } from '../errors';
import { hasTemplate } from '../template';
import { requireSessionTab } from '../session';
import type { EmulateOptions } from '../network';
import type { BlockDefinition, ConfigProblem } from '../types';
import { PAGE_ACCENT, tabField } from './pageCommon';

export interface EmulateConfig {
  action: 'set' | 'clear';
  device: EmulateOptions['device'];
  width: number;
  height: number;
  deviceScaleFactor: number;
  userAgent: string;
  locale: string;
  timezone: string;
  latitude: string;
  longitude: string;
  accuracy: number;
  colorScheme: '' | 'light' | 'dark';
  reducedMotion: '' | 'reduce' | 'no-preference';
  offline: boolean;
  tab: string;
}

/** Config validation is shared by strict import and the final rendered run settings. */
export function emulateProblems(config: EmulateConfig): ConfigProblem[] {
  if (config.action === 'clear') return [];
  const problems: ConfigProblem[] = [];
  const problem = (key: string, message: string) => problems.push({ key, code: 'config.value', message });
  if ((config.width > 0) !== (config.height > 0)) problem('width', 'Supply both viewport width and height, or leave both at 0.');
  for (const key of ['width', 'height'] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 0 || config[key] > 10000) problem(key, `${key} must be an integer from 0 to 10000.`);
  }
  if (!Number.isFinite(config.deviceScaleFactor) || config.deviceScaleFactor < 0 || config.deviceScaleFactor > 8) problem('deviceScaleFactor', 'Device scale factor must be from 0 to 8 (0 keeps the preset/default).');
  if (!Number.isFinite(config.accuracy) || config.accuracy < 0) problem('accuracy', 'Geolocation accuracy must be a non-negative number.');
  const latitude = String(config.latitude ?? '').trim();
  const longitude = String(config.longitude ?? '').trim();
  if (!!latitude !== !!longitude) problem('latitude', 'Supply both latitude and longitude, or leave both empty.');
  for (const [key, text, limit] of [['latitude', latitude, 90], ['longitude', longitude, 180]] as const) {
    if (text && !hasTemplate(text) && (!Number.isFinite(Number(text)) || Math.abs(Number(text)) > limit)) problem(key, `${key} must be a number from -${limit} to ${limit}.`);
  }
  if (config.locale && !hasTemplate(config.locale)) {
    try { Intl.getCanonicalLocales(config.locale); } catch { problem('locale', 'Use a valid locale such as en-US or fr-FR.'); }
  }
  if (config.timezone && !hasTemplate(config.timezone)) {
    try { new Intl.DateTimeFormat('en', { timeZone: config.timezone }); } catch { problem('timezone', 'Use an IANA timezone such as Europe/Paris or Asia/Dhaka.'); }
  }
  if (/[\r\n\0]/.test(config.userAgent)) problem('userAgent', 'User agent cannot contain newlines or NUL.');
  return problems;
}

export const emulateBlock: BlockDefinition<EmulateConfig> = {
  type: 'emulate',
  label: 'Emulate',
  description: 'Chromium only: change viewport/device, locale, timezone, location, media preferences or offline state until this run ends. Location still needs the site’s permission.',
  icon: '📱',
  accent: PAGE_ACCENT,
  permissions: ['debugger'],
  defaultConfig: { action: 'set', device: '', width: 0, height: 0, deviceScaleFactor: 0, userAgent: '', locale: '', timezone: '', latitude: '', longitude: '', accuracy: 1, colorScheme: '', reducedMotion: '', offline: false, tab: 'main' },
  fields: [
    { key: 'action', label: 'Do', kind: 'select', options: [{ value: 'set', label: 'set environment' }, { value: 'clear', label: 'clear this run’s overrides' }] },
    { key: 'device', label: 'Device preset', kind: 'select', options: [{ value: '', label: 'custom / no device preset' }, { value: 'iphone', label: 'iPhone (390 × 844)' }, { value: 'pixel', label: 'Pixel (412 × 915)' }, { value: 'ipad', label: 'iPad (820 × 1180)' }, { value: 'desktop', label: 'Desktop (1440 × 900)' }] },
    { key: 'width', label: 'Viewport width', kind: 'number', min: 0, max: 10000, help: '0 uses the preset/default. Supply width and height together.' },
    { key: 'height', label: 'Viewport height', kind: 'number', min: 0, max: 10000 },
    { key: 'deviceScaleFactor', label: 'Device scale factor', kind: 'number', min: 0, max: 8, help: '0 uses the preset/default.' },
    { key: 'userAgent', label: 'User agent', kind: 'text', templated: true, help: 'Optional override of the preset user agent. Changes may need a later Navigate/reload.' },
    { key: 'locale', label: 'Locale', kind: 'text', templated: true, placeholder: 'fr-FR', help: 'Intl locale and language override; reload for page code that reads language at startup.' },
    { key: 'timezone', label: 'Timezone', kind: 'text', templated: true, placeholder: 'Asia/Dhaka' },
    { key: 'latitude', label: 'Latitude', kind: 'text', templated: true, placeholder: '23.8103' },
    { key: 'longitude', label: 'Longitude', kind: 'text', templated: true, placeholder: '90.4125', help: 'Both coordinates required. This does not grant the site geolocation permission.' },
    { key: 'accuracy', label: 'Location accuracy (metres)', kind: 'number', min: 0 },
    { key: 'colorScheme', label: 'Color scheme', kind: 'select', options: [{ value: '', label: 'system default' }, { value: 'light', label: 'light' }, { value: 'dark', label: 'dark' }] },
    { key: 'reducedMotion', label: 'Reduced motion', kind: 'select', options: [{ value: '', label: 'system default' }, { value: 'reduce', label: 'reduce' }, { value: 'no-preference', label: 'no preference' }] },
    { key: 'offline', label: 'Offline', kind: 'boolean', help: 'Blocks network requests from this tab. Cleared automatically at run end.' },
    tabField,
  ],
  validate: emulateProblems,
  summary: (config) => config.action === 'clear' ? 'clear environment' : [config.device || (config.width ? `${config.width} × ${config.height}` : ''), config.timezone, config.offline ? 'offline' : ''].filter(Boolean).join(' · ') || 'custom environment',
  outputs: [{ key: 'emulated', description: 'Environment options applied to the tab.' }],
  async run(ctx, input) {
    const problems = emulateProblems(ctx.config);
    if (problems.length) throw new CodedError('config.invalid', problems[0]!.message);
    const c = ctx.config;
    const options: EmulateOptions = {
      action: c.action, device: c.device,
      ...(c.width ? { width: c.width, height: c.height } : {}),
      ...(c.deviceScaleFactor ? { deviceScaleFactor: c.deviceScaleFactor } : {}),
      ...(c.userAgent.trim() ? { userAgent: c.userAgent.trim() } : {}),
      ...(c.locale.trim() ? { locale: c.locale.trim() } : {}),
      ...(c.timezone.trim() ? { timezone: c.timezone.trim() } : {}),
      ...(c.latitude.trim() && c.longitude.trim() ? { latitude: Number(c.latitude), longitude: Number(c.longitude), accuracy: c.accuracy } : {}),
      colorScheme: c.colorScheme, reducedMotion: c.reducedMotion, offline: c.offline,
    };
    await ctx.host.environment.emulate(requireSessionTab(input, c.tab), options);
    ctx.log('info', c.action === 'clear' ? 'Environment overrides cleared' : 'Environment emulation applied (Chromium)');
    return { ...input, emulated: options };
  },
};
