import { CodedError } from '../errors';
import { PAGE_ACCENT, PAGE_TIMEOUT_SECONDS, inPage, locatorField, tabField } from './pageCommon';
import type { AgentRequest } from '../page';
import type { BlockDefinition, ConfigProblem } from '../types';

/** Element Action settings. `eventType` and `detail` are for `dispatch-event`. */
export interface ElementActionConfig {
  tab: string;
  locator: string;
  action: 'focus' | 'blur' | 'clear' | 'scroll-into-view' | 'dispatch-event';
  eventType: string;
  /** JSON (templated). Known event types: the event init (`{"key": "Enter"}`); other types: `event.detail`. */
  detail: string;
}

/** `detail` as a value: empty → undefined, else JSON. */
export function parseDetail(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CodedError('config.invalid', `Detail is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Element Action: the small things Playwright's locator can do that are not clicks or typing: focus,
 * blur, clear, scroll into view, dispatch an event. One agent request each (`focus`, `blur`, `clear`,
 * `scroll` to the element, `dispatch`).
 */
export const elementActionBlock: BlockDefinition<ElementActionConfig> = {
  type: 'element-action',
  label: 'Element Action',
  description: 'Focus, blur, clear, scroll into view, or dispatch an event (click, input, a custom event) on an element.',
  icon: '🎛️',
  accent: PAGE_ACCENT,
  defaultConfig: { tab: 'main', locator: '', action: 'focus', eventType: '', detail: '' },
  timeoutSeconds: PAGE_TIMEOUT_SECONDS,
  fields: [
    locatorField(),
    {
      key: 'action',
      label: 'Action',
      kind: 'select',
      options: [
        { value: 'focus', label: 'focus' },
        { value: 'blur', label: 'blur (take focus away)' },
        { value: 'clear', label: 'clear (empty a field)' },
        { value: 'scroll-into-view', label: 'scroll into view' },
        { value: 'dispatch-event', label: 'dispatch an event' },
      ],
    },
    { key: 'eventType', label: 'Event type', kind: 'text', placeholder: 'click  ·  input  ·  my-event', help: 'For "dispatch an event". Bubbles, cancelable and composed.' },
    {
      key: 'detail',
      label: 'Detail (JSON)',
      kind: 'text',
      templated: true,
      multiline: true,
      placeholder: '{"key": "Enter"}',
      help: 'For "dispatch an event". Built-in types (click, keydown, input, focus, drag…): the event’s properties. Other types are a CustomEvent and this is its event.detail.',
    },
    tabField,
  ],
  summary: (config) => `${config.action === 'dispatch-event' ? `dispatch ${config.eventType || '…'}` : config.action}: ${config.locator || 'pick an element'}`,
  validate: (config) => {
    const problems: ConfigProblem[] = [];
    if (config.action === 'dispatch-event' && !String(config.eventType ?? '').trim()) {
      problems.push({ key: 'eventType', code: 'config.required', message: 'Event type is required to dispatch an event' });
    }
    const detail = String(config.detail ?? '');
    if (detail.trim() && !detail.includes('{{')) {
      try {
        JSON.parse(detail);
      } catch {
        problems.push({ key: 'detail', code: 'config.value', message: 'Detail must be JSON, e.g. {"key": "Enter"} or "text"' });
      }
    }
    return problems;
  },
  outputs: [
    { key: '(same data)', description: 'The input, passed on.' },
    { key: 'defaultPrevented', description: 'For "dispatch an event": true when the page cancelled the event.' },
  ],

  async run(ctx, input) {
    const { locator, action } = ctx.config;
    let request: AgentRequest;
    switch (action) {
      case 'focus':
      case 'blur':
      case 'clear':
        request = { op: action, locator };
        break;
      case 'scroll-into-view':
        request = { op: 'scroll', to: 'element', locator };
        break;
      case 'dispatch-event': {
        const eventType = ctx.config.eventType.trim();
        if (!eventType) throw new CodedError('config.invalid', 'Event type is required to dispatch an event');
        const detail = parseDetail(ctx.config.detail);
        request = { op: 'dispatch', locator, eventType, ...(detail !== undefined ? { detail } : {}) };
        break;
      }
      default:
        throw new CodedError('config.invalid', `Unknown action "${String(action)}"`);
    }
    const { result } = await inPage(ctx, input, request);
    ctx.log('info', `${action === 'dispatch-event' ? `Dispatched ${ctx.config.eventType.trim()} on` : `${action}:`} ${locator}`);
    return action === 'dispatch-event' ? { ...input, defaultPrevented: result.defaultPrevented === true } : input;
  },
};
