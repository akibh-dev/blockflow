import { describe, expect, it } from 'vitest';
import { lastBlockOfMainPath, recordingIntoWorkflow, recordingToBlocks, tidySteps } from '../../src/core/recording';
import type { Recording } from '../../src/core/recording';
import type { EdgeDef, NodeDef } from '../../src/core/types';
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

describe('recorded secrets', () => {
  it('names one secret per password field, from its label or name, deduplicated', () => {
    const { nodes, secrets } = recordingToBlocks({
      startUrl: 'https://a.test/admin',
      steps: [
        { kind: 'fill', locator: 'label="Password"', value: '', secret: true, field: 'Password' },
        { kind: 'click', locator: 'text=Next' },
        { kind: 'fill', locator: 'input[name="adminPassword"]', value: '', secret: true },
        { kind: 'click', locator: 'text=Next' },
        { kind: 'fill', locator: '#other', value: '', secret: true, field: 'password' },
        { kind: 'click', locator: 'text=Next' },
        // The same field again keeps its name.
        { kind: 'fill', locator: 'label="Password"', value: '', secret: true, field: 'Password' },
      ],
    });
    const values = nodes.filter((node) => node.type === 'fill').map((node) => node.config.value);
    expect(values).toEqual(['{{secret.password}}', '{{secret.adminPassword}}', '{{secret.password2}}', '{{secret.password}}']);
    expect(secrets).toEqual(['password', 'adminPassword', 'password2']);
  });
});

describe('recorded popups', () => {
  it('a popup becomes Wait for Popup, and steps in it use tab "popup"', () => {
    const { nodes } = recordingToBlocks({
      startUrl: 'https://a.test/',
      steps: [
        { kind: 'click', locator: 'role=button[name="Open help"]' },
        { kind: 'popup', url: 'https://a.test/help' },
        { kind: 'click', locator: 'text=Contact', tab: 'popup' },
        { kind: 'navigated', url: 'https://a.test/contact', tab: 'popup' },
        { kind: 'assert-visible', locator: 'h1' },
      ],
    });
    expect(nodes.map((node) => [node.type, node.config.tab])).toEqual([
      ['open-url', 'main'],
      ['click', 'main'],
      ['wait-for-popup', 'main'],
      ['click', 'popup'],
      ['wait-for', 'popup'],
      ['assert', 'main'],
    ]);
    expect(nodes[2]?.config).toMatchObject({ name: 'popup' });
  });

  it('fills in different tabs do not merge into one form', () => {
    const { nodes } = recordingToBlocks({
      startUrl: 'https://a.test/',
      steps: [
        { kind: 'fill', locator: '#a', value: '1' },
        { kind: 'fill', locator: '#b', value: '2', tab: 'popup' },
      ],
    });
    expect(nodes.map((node) => node.type)).toEqual(['open-url', 'fill', 'fill']);
  });
});

describe('recording into an existing workflow', () => {
  const node = (id: string, type: string, x: number, y = 0, config: Record<string, unknown> = {}): NodeDef => ({ id, type, position: { x, y }, config });
  const edge = (source: string, target: string): EdgeDef => ({ id: `${source}-${target}`, source, target });
  const workflow = {
    nodes: [node('open', 'open-url', 0, 0, { url: 'https://shop.test/login', tab: 'shop' }), node('fill', 'fill', 240), node('log', 'log', 480)],
    edges: [edge('open', 'fill'), edge('fill', 'log')],
  };
  const recording: Recording = {
    startUrl: 'https://shop.test/login',
    steps: [
      { kind: 'click', locator: 'text=Buy' },
      { kind: 'assert-visible', locator: '#done' },
    ],
  };

  it('finds the last block of the main path', () => {
    expect(lastBlockOfMainPath(workflow.nodes, workflow.edges)?.id).toBe('log');
  });

  it('drops the recorded Open Tab when the site is already open, and continues after the last block on its tab', () => {
    const { nodes, edges } = recordingIntoWorkflow(workflow, recording);
    expect(nodes.map((n) => n.type)).toEqual(['click', 'assert']);
    expect(nodes.map((n) => n.config.tab)).toEqual(['shop', 'shop']);
    expect(edges[0]).toMatchObject({ source: 'log', target: nodes[0]?.id });
    expect(edges).toHaveLength(2);
    expect(nodes[0]?.position).toEqual({ x: 720, y: 0 });
  });

  it('continues after the selected block, to its right, below anything in the way', () => {
    const { nodes, edges } = recordingIntoWorkflow(workflow, recording, 'fill');
    expect(edges[0]).toMatchObject({ source: 'fill', target: nodes[0]?.id });
    // "log" is to the right of "fill": the new row goes below it.
    expect(nodes[0]?.position).toEqual({ x: 480, y: 160 });
  });

  it('keeps the Open Tab for another site, and connects it', () => {
    const { nodes, edges } = recordingIntoWorkflow(workflow, { startUrl: 'https://other.test/', steps: [{ kind: 'click', locator: 'text=Go' }] });
    expect(nodes.map((n) => n.type)).toEqual(['open-url', 'click']);
    expect(edges.map((e) => [e.source, e.target])).toEqual([
      ['log', nodes[0]?.id],
      [nodes[0]?.id, nodes[1]?.id],
    ]);
  });

  it('an empty workflow gets the plain chain', () => {
    const { nodes, edges } = recordingIntoWorkflow({ nodes: [], edges: [] }, { startUrl: 'https://a.test/', steps: [{ kind: 'click', locator: 'text=Go' }] });
    expect(nodes.map((n) => n.type)).toEqual(['open-url', 'click']);
    expect(edges).toHaveLength(1);
  });
});
