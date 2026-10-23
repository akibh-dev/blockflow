import { describe, expect, it } from 'vitest';
import { recordingToBlocks, tidySteps } from '../../src/core/recording';
import { nextOccurrence, parseDays } from '../../src/core/schedule';

describe('schedule', () => {
  // Thursday 2026-10-22 10:07:30 local time
  const now = new Date(2026, 9, 22, 10, 7, 30);

  it('every N minutes, on the clock', () => {
    expect(nextOccurrence(now, { every: 'minutes', minutes: 10 })).toEqual(new Date(2026, 9, 22, 10, 10));
    expect(nextOccurrence(new Date(2026, 9, 22, 23, 55), { every: 'minutes', minutes: 10 })).toEqual(new Date(2026, 9, 23, 0, 0));
  });

  it('every hour at a minute', () => {
    expect(nextOccurrence(now, { every: 'hour', minute: 15 })).toEqual(new Date(2026, 9, 22, 10, 15));
    expect(nextOccurrence(now, { every: 'hour', minute: 5 })).toEqual(new Date(2026, 9, 22, 11, 5));
  });

  it('days at a time, skipping days not chosen', () => {
    expect(nextOccurrence(now, { every: 'day', at: '09:30', days: [] })).toEqual(new Date(2026, 9, 23, 9, 30));
    expect(nextOccurrence(now, { every: 'day', at: '11:00', days: [] })).toEqual(new Date(2026, 9, 22, 11, 0));
    // Thursday → next weekday-only Monday 08:00? No: Friday.
    expect(nextOccurrence(now, { every: 'day', at: '08:00', days: parseDays('weekdays') })).toEqual(new Date(2026, 9, 23, 8, 0));
    expect(nextOccurrence(now, { every: 'day', at: '08:00', days: parseDays('mon') })).toEqual(new Date(2026, 9, 26, 8, 0));
    expect(() => nextOccurrence(now, { every: 'day', at: '25:00', days: [] })).toThrow('not a time');
  });

  it('reads day lists', () => {
    expect(parseDays('Mon, Wed,fri')).toEqual([1, 3, 5]);
    expect(parseDays('weekends')).toEqual([0, 6]);
    expect(parseDays('')).toHaveLength(7);
  });
});

describe('recording to blocks', () => {
  it('keeps the last value of repeated fills', () => {
    expect(
      tidySteps([
        { kind: 'fill', locator: '#a', value: 'h' },
        { kind: 'fill', locator: '#a', value: 'hi' },
        { kind: 'click', locator: '#b' },
      ]),
    ).toEqual([
      { kind: 'fill', locator: '#a', value: 'hi' },
      { kind: 'click', locator: '#b' },
    ]);
  });

  it('turns a login into Open Tab → Fill Form (with submit) → Wait For → Assert, passwords as a secret', () => {
    const { nodes, edges, secrets } = recordingToBlocks({
      startUrl: 'https://shop.test/login',
      steps: [
        { kind: 'fill', locator: 'label=Email', value: 'me@x.co' },
        { kind: 'fill', locator: 'label=Password', value: '', secret: true },
        { kind: 'check', locator: 'label="Remember me"', checked: true },
        { kind: 'click', locator: 'role=button[name="Sign in"]' },
        { kind: 'navigated', url: 'https://shop.test/account?tab=1' },
        { kind: 'assert-text', locator: 'h1', text: 'Welcome' },
      ],
    });
    expect(nodes.map((node) => node.type)).toEqual(['open-url', 'fill-form', 'wait-for', 'assert']);
    expect(nodes[1]?.config).toMatchObject({
      fields: [
        { locator: 'label=Email', value: 'me@x.co' },
        { locator: 'label=Password', value: '{{secret.password}}' },
        { locator: 'label="Remember me"', value: 'true' },
      ],
      submit: 'role=button[name="Sign in"]',
    });
    expect(nodes[2]?.config).toMatchObject({ mode: 'url', url: '/account' });
    expect(edges).toHaveLength(3);
    expect(secrets).toEqual(['password']);
  });

  it('single actions become single blocks', () => {
    const { nodes } = recordingToBlocks({
      startUrl: 'https://a.test',
      steps: [
        { kind: 'click', locator: 'text=Menu' },
        { kind: 'fill', locator: '#q', value: 'kettle' },
        { kind: 'press', locator: '#q', key: 'Enter' },
        { kind: 'select', locator: '#sort', value: 'Price' },
        { kind: 'assert-visible', locator: '.results' },
      ],
    });
    expect(nodes.map((node) => node.type)).toEqual(['open-url', 'click', 'fill', 'press-key', 'select-option', 'assert']);
  });
});
