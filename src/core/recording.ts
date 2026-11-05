import { uid } from './id';
import type { EdgeDef, NodeDef } from './types';

/**
 * The recorder (src/dom/recorder.ts) sends what the user did; this turns it into blocks.
 * Pure, so the conversion rules are tested without a browser.
 */
export type RecordedStep = (
  | { kind: 'click'; locator: string; text?: string }
  /** `field`: what a password field is called (label, name...), to name its secret. */
  | { kind: 'fill'; locator: string; value: string; secret?: boolean; field?: string }
  | { kind: 'select'; locator: string; value: string }
  | { kind: 'check'; locator: string; checked: boolean }
  | { kind: 'press'; locator: string; key: string }
  | { kind: 'navigated'; url: string }
  /** The page opened a new tab or window (window.open, target=_blank); later steps there have `tab: 'popup'`. */
  | { kind: 'popup'; url?: string }
  | { kind: 'assert-text'; locator: string; text: string }
  | { kind: 'assert-visible'; locator: string }
) & {
  /** The tab the step happened in, when not the recording's own tab: `popup`. Set by the background. */
  tab?: string;
};

/** What the recorder captured: the page it started on and the user's actions. */
export interface Recording {
  startUrl: string;
  steps: RecordedStep[];
}

/** Fills right after each other (≥ this many) become one Fill Form block. */
const FORM_MIN_FIELDS = 2;
/** Horizontal distance between recorded blocks. */
const STEP_X = 240;

/** A recorded navigation as a Wait For URL pattern: just its path. */
function urlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return url;
  }
}

/** Removes noise: repeated fills of one field keep the last value; a navigation repeated keeps the last. */
export function tidySteps(steps: RecordedStep[]): RecordedStep[] {
  const out: RecordedStep[] = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (step.kind === 'fill' && last?.kind === 'fill' && last.locator === step.locator && last.tab === step.tab) {
      out[out.length - 1] = step;
      continue;
    }
    if (step.kind === 'navigated' && last?.kind === 'navigated' && last.tab === step.tab) {
      out[out.length - 1] = step;
      continue;
    }
    out.push(step);
  }
  return out;
}

/** "Admin password" → adminPassword; "user[pass]" → userPass. Empty when nothing usable is left. */
function camelName(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const name = words.map((word, index) => (index === 0 ? word : word[0]?.toUpperCase() + word.slice(1))).join('');
  return /^\d/.test(name) ? `field${name}` : name;
}

/** A field's name from its locator when the recorder did not send one: `label="Admin password"`, `[name="pin"]`, `#pwd`. */
function nameFromLocator(locator: string): string {
  const last = locator.split('>>').at(-1)?.trim() ?? locator;
  const quoted = /(?:label|placeholder|name|aria-label)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(last) ?? /^(?:label|placeholder)=(.+)$/.exec(last);
  if (quoted) return quoted[1] as string;
  return /#([\w-]+)/.exec(last)?.[1] ?? '';
}

/**
 * Names the secrets of password fields: one per field (by locator), from the field's label or name,
 * camel-cased (`{{secret.adminPassword}}`); `password` when nothing better is known; two different
 * fields that would share a name get `password2`, `password3`...
 */
function secretNamer(): { nameFor(step: { locator: string; field?: string }): string; names(): string[] } {
  const byLocator = new Map<string, string>();
  const used = new Set<string>();
  return {
    nameFor(step) {
      const known = byLocator.get(step.locator);
      if (known) return known;
      const base = camelName(step.field ?? '') || camelName(nameFromLocator(step.locator)) || 'password';
      let name = base;
      for (let n = 2; used.has(name); n += 1) name = `${base}${n}`;
      used.add(name);
      byLocator.set(step.locator, name);
      return name;
    },
    names: () => [...used],
  };
}

/** Blocks produced from a recording, wired in one line. */
export interface RecordedBlocks {
  nodes: NodeDef[];
  edges: EdgeDef[];
  /** Secret names the recording expects (password fields are not recorded in clear). */
  secrets: string[];
}

/**
 * Blocks in one line: Open Tab, then one block per action. Consecutive fills followed by a click
 * become Fill Form with that click as its submit. A navigation becomes Wait For URL, a popup Wait for
 * Popup (`name: popup`), and steps in the popup get `tab: "popup"`.
 */
export function recordingToBlocks(recording: Recording, origin: { x: number; y: number } = { x: 60, y: 120 }): RecordedBlocks {
  const steps = tidySteps(recording.steps);
  const nodes: NodeDef[] = [];
  const secrets = secretNamer();
  const secretValue = (step: { locator: string; field?: string }) => `{{secret.${secrets.nameFor(step)}}}`;
  const add = (type: string, config: Record<string, unknown>) => {
    nodes.push({ id: uid(), type, position: { x: origin.x + nodes.length * STEP_X, y: origin.y }, config });
  };

  add('open-url', { url: recording.startUrl, where: 'new', tab: 'main', active: true, waitUntil: 'load' });
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] as RecordedStep;
    const tab = step.tab ?? 'main';
    if (step.kind === 'fill') {
      const run: Extract<RecordedStep, { kind: 'fill' | 'select' | 'check' }>[] = [];
      let j = i;
      for (; j < steps.length; j += 1) {
        const next = steps[j] as RecordedStep;
        if ((next.kind !== 'fill' && next.kind !== 'select' && next.kind !== 'check') || (next.tab ?? 'main') !== tab) break;
        run.push(next);
      }
      if (run.filter((item) => item.kind === 'fill').length >= FORM_MIN_FIELDS) {
        const after = steps[j];
        const submit = after?.kind === 'click' && (after.tab ?? 'main') === tab ? after.locator : '';
        add('fill-form', {
          tab,
          fields: run.map((item) => ({
            locator: item.locator,
            value: item.kind === 'check' ? String(item.checked) : item.kind === 'fill' && item.secret ? secretValue(item) : item.value,
          })),
          submit,
        });
        i = submit ? j : j - 1;
        continue;
      }
    }
    switch (step.kind) {
      case 'click':
        add('click', { tab, locator: step.locator, action: 'click', force: false });
        break;
      case 'fill':
        add('fill', { tab, locator: step.locator, value: step.secret ? secretValue(step) : step.value, mode: 'fill' });
        break;
      case 'select':
        add('select-option', { tab, locator: step.locator, value: step.value });
        break;
      case 'check':
        add('check', { tab, locator: step.locator, state: step.checked ? 'check' : 'uncheck' });
        break;
      case 'press':
        add('press-key', { tab, key: step.key, locator: step.locator });
        break;
      case 'navigated':
        add('wait-for', { tab, mode: 'url', url: urlPattern(step.url), locator: '', text: '' });
        break;
      case 'popup':
        // `tab` is the opener here.
        add('wait-for-popup', { tab, name: 'popup', waitUntil: 'load' });
        break;
      case 'assert-text':
        add('assert', { subject: 'text', locator: step.locator, operator: 'equals', expected: step.text, tab });
        break;
      case 'assert-visible':
        add('assert', { subject: 'visible', locator: step.locator, tab });
        break;
    }
  }
  const edges: EdgeDef[] = nodes.slice(1).map((node, index) => ({ id: uid(), source: (nodes[index] as NodeDef).id, target: node.id }));
  return { nodes, edges, secrets: secrets.names() };
}

function originOf(url: unknown): string | null {
  try {
    return typeof url === 'string' ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/**
 * The last block of the workflow's main path: from the leftmost block nothing leads to, follow the
 * first connection (leftmost target) until a block with none.
 */
export function lastBlockOfMainPath(nodes: NodeDef[], edges: EdgeDef[]): NodeDef | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const hasInput = new Set(edges.map((edge) => edge.target));
  const leftmost = (list: NodeDef[]) => [...list].sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y)[0];
  let current = leftmost(nodes.filter((node) => !hasInput.has(node.id))) ?? leftmost(nodes);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const id: string = current.id;
    const next = leftmost(edges.filter((edge) => edge.source === id).flatMap((edge) => byId.get(edge.target) ?? []));
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * A recording added to an existing workflow: the blocks continue after `selectedId` (or the last
 * block of the main path), placed to its right. When the workflow already opens a page on the
 * recording's site (an Open Tab with the same origin), the recorded Open Tab is left out and the
 * recorded steps use that block's tab. An empty workflow gets the plain chain.
 */
export function recordingIntoWorkflow(workflow: { nodes: NodeDef[]; edges: EdgeDef[] }, recording: Recording, selectedId?: string): RecordedBlocks {
  if (workflow.nodes.length === 0) return recordingToBlocks(recording);
  const anchor = workflow.nodes.find((node) => node.id === selectedId) ?? lastBlockOfMainPath(workflow.nodes, workflow.edges);
  if (!anchor) return recordingToBlocks(recording);

  const site = originOf(recording.startUrl);
  const opener = workflow.nodes.find((node) => node.type === 'open-url' && site !== null && originOf(node.config.url) === site);
  const blocks = recordingToBlocks(recording, { x: anchor.position.x + STEP_X - (opener ? STEP_X : 0), y: anchor.position.y });
  let nodes = blocks.nodes;
  let edges = blocks.edges;
  if (opener) {
    const [dropped, ...rest] = nodes;
    nodes = rest;
    edges = edges.filter((edge) => edge.source !== dropped?.id);
    const tab = typeof opener.config.tab === 'string' && opener.config.tab ? opener.config.tab : 'main';
    if (tab !== 'main') {
      nodes = nodes.map((node) => (node.config.tab === 'main' ? { ...node, config: { ...node.config, tab } } : node));
    }
  }
  const first = nodes[0];
  if (!first) return { nodes: [], edges: [], secrets: blocks.secrets };

  // Move down, one row at a time, until no existing block is in the way.
  const right = first.position.x + (nodes.length - 1) * STEP_X;
  const blocked = (y: number) =>
    workflow.nodes.some((node) => node.position.x > first.position.x - STEP_X / 2 && node.position.x < right + STEP_X / 2 && Math.abs(node.position.y - y) < 120);
  let y = first.position.y;
  while (blocked(y)) y += 160;
  if (y !== first.position.y) nodes = nodes.map((node) => ({ ...node, position: { x: node.position.x, y } }));

  return { nodes, edges: [{ id: uid(), source: anchor.id, target: first.id }, ...edges], secrets: blocks.secrets };
}
