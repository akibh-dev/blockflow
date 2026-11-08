import { browser } from 'wxt/browser';
import { insertText, mouseClick, mouseDrag, pressKey, typeInto, withDebugger } from './cdp';
import { sleep, tabExists } from './tabs';
import { CodedError } from '../core/errors';
import type { AgentCall, AgentErrorInfo, AgentRequest, AgentResponse } from '../core/page';
import type { ErrorCode } from '../core/errors';

/**
 * Sends one request to the page agent (src/dom/agent.ts) in a tab, and keeps asking until it is
 * done or `timeoutMs` runs out.
 *
 * Each call lets the agent retry inside the page for at most SLICE_MS, then answer. Short calls
 * (1) survive navigations, which destroy the page and the agent with it, (2) keep the background
 * worker busy with extension calls so the browser does not stop it mid-wait, and (3) let a
 * timeout report the last reason ("waiting for #save to be enabled").
 */

const AGENT_FILE = '/content-scripts/agent.js';
const SLICE_MS = 2_000;
const ACTIONS = new Set<AgentRequest['op']>(['click', 'fill', 'set-field', 'select', 'check', 'press', 'insert-text', 'drag']);
/** Requests that are done once their page navigated away mid-call (repeating them could act twice). */
const ONCE = new Set<AgentRequest['op']>([...ACTIONS, 'focus', 'blur', 'clear', 'dispatch']);

/** What one call can return: the agent's answer, `missing` (no agent in the page yet) or `vanished` (the page went away mid-call). */
type Outcome = AgentResponse | { status: 'missing' } | { status: 'vanished' };

/** One `executeScript` that asks the already-injected agent (`globalThis.__blockflowAgent`) to run `call`. */
async function callOnce(tabId: number, call: AgentCall, frameId?: number): Promise<Outcome> {
  const [injection] = await browser.scripting.executeScript({
    target: frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] },
    // Runs in the page: must be self-contained.
    func: (agentCall: AgentCall) => {
      const agent = (globalThis as { __blockflowAgent?: { run(c: AgentCall): Promise<unknown> } }).__blockflowAgent;
      return agent ? agent.run(agentCall) : { status: 'missing' };
    },
    args: [call],
  });
  // No result: the script ran but the page went away before it answered (it navigated).
  return (injection?.result as Outcome | undefined) ?? { status: 'vanished' };
}

/** `callOnce`, injecting `content-scripts/agent.js` first if the page has no agent yet. */
async function callAgent(tabId: number, call: AgentCall, frameId?: number): Promise<Outcome> {
  const outcome = await callOnce(tabId, call, frameId);
  if (outcome.status !== 'missing') return outcome;
  await browser.scripting.executeScript({ target: frameId === undefined ? { tabId } : { tabId, frameIds: [frameId] }, files: [AGENT_FILE] });
  return callOnce(tabId, call, frameId);
}

/**
 * The frame of a tab showing `src` (cross-origin iframes are reached through their frame id),
 * preferring children of `parentFrameId`.
 */
async function frameShowing(tabId: number, src: string, parentFrameId: number): Promise<number | undefined> {
  const all = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
  const children = all.filter((frame) => frame.parentFrameId === parentFrameId);
  for (const frames of [children, all]) {
    const exact = frames.find((frame) => frame.frameId !== 0 && frame.url === src);
    const loose = frames.find((frame) => frame.frameId !== 0 && (frame.url.startsWith(src) || src.startsWith(frame.url)));
    const found = (exact ?? loose)?.frameId;
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Errors that mean the browser will never let us script this page (no point retrying). */
function restricted(message: string): boolean {
  return /cannot access|cannot be scripted|extensions gallery|chrome:\/\/|about:|missing host permission/i.test(message);
}

/** A restricted page because the extension lacks host access (fixable), or one no extension may script. */
function restrictedCode(message: string): ErrorCode {
  return /permission/i.test(message) ? 'permission.missing' : 'page.restricted';
}

/** The locator of a request, for error details. */
function locatorOf(request: AgentRequest): string | undefined {
  return 'locator' in request && typeof request.locator === 'string' && request.locator ? request.locator : undefined;
}

/**
 * Real (debugger) input: the agent still waits for the element and says where it is; the mouse and
 * keyboard events then come from the browser itself. Selects and other non-typing fields use the
 * normal path, since a real dropdown cannot be driven by coordinates.
 */
async function actWithRealInput(tabId: number, request: AgentRequest, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!('locator' in request) || !request.locator) {
    if (request.op === 'press') await withDebugger(tabId, (send) => pressKey(send, request.key));
    if (request.op === 'insert-text') await withDebugger(tabId, (send) => insertText(send, request.text));
    return { real: true };
  }
  const purpose = request.op === 'click' || request.op === 'fill' || request.op === 'set-field' || request.op === 'check' || request.op === 'press' ? request.op : request.op === 'insert-text' ? 'fill' : 'click';
  const position = request.op === 'click' ? request.position : request.op === 'drag' ? request.fromPosition : undefined;
  const where = await actInTab(tabId, { op: 'locate', locator: request.locator, purpose, ...(position ? { position } : {}) }, timeoutMs);
  const x = Number(where.x);
  const y = Number(where.y);
  switch (request.op) {
    case 'click': {
      const clicks = Math.max(request.action === 'double' ? 2 : 1, Math.floor(request.clickCount ?? 1));
      const button = request.action === 'right' ? 'right' : (request.button ?? 'left');
      await withDebugger(tabId, (send) => mouseClick(send, x, y, { button, clicks, hoverOnly: request.action === 'hover', modifiers: request.modifiers }));
      return { clicked: request.locator, real: true };
    }
    case 'drag': {
      const target = await actInTab(tabId, { op: 'locate', locator: request.to, purpose: 'drop', ...(request.toPosition ? { position: request.toPosition } : {}) }, timeoutMs);
      const mode = await mouseDrag(tabId, { x, y }, { x: Number(target.x), y: Number(target.y) }, { modifiers: request.modifiers });
      return { dragged: request.locator, to: request.to, mode, real: true };
    }
    case 'fill':
      await withDebugger(tabId, (send) => typeInto(send, x, y, request.value));
      return { value: request.value, real: true };
    case 'set-field':
      if (where.kind !== 'text') return actInTab(tabId, request, timeoutMs);
      await withDebugger(tabId, (send) => typeInto(send, x, y, request.value));
      return { value: request.value, real: true };
    case 'check': {
      const state = await actInTab(tabId, { op: 'read', locator: request.locator, kind: 'checked' }, timeoutMs);
      if ((state.text === 'true') === request.checked) return { changed: false, checked: request.checked };
      await withDebugger(tabId, (send) => mouseClick(send, x, y));
      return { changed: true, checked: request.checked, real: true };
    }
    case 'press':
      await withDebugger(tabId, async (send) => {
        await mouseClick(send, x, y);
        await pressKey(send, request.key);
      });
      return { key: request.key, real: true };
    case 'insert-text':
      // Clicking puts the caret where it lands (the middle of the field), as a person would.
      await withDebugger(tabId, async (send) => {
        await mouseClick(send, x, y);
        await insertText(send, request.text);
      });
      return { text: request.text, real: true };
    default:
      return actInTab(tabId, request, timeoutMs);
  }
}

/**
 * `Host.page.act`: carries out one page request. Actions with `realInput` go through the debugger
 * (`actWithRealInput`); everything else through the page agent (`actInTab`).
 */
export async function act(tabId: number, request: AgentRequest, timeoutMs: number, options?: { realInput?: boolean }): Promise<Record<string, unknown>> {
  return options?.realInput && ACTIONS.has(request.op) ? actWithRealInput(tabId, request, timeoutMs) : actInTab(tabId, request, timeoutMs);
}

/**
 * Asks the page agent in slices of at most SLICE_MS until it answers done/error or `timeoutMs` runs out.
 * Follows `{status: 'frame'}` answers into cross-origin iframes by frame id. An action whose page vanished
 * returns `{ navigated: true }` instead of being repeated. Throws `Timed out after Ns: <last reason>`.
 */
export async function actInTab(tabId: number, original: AgentRequest, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.max(timeoutMs, 0);
  let reason = 'the page did not answer';
  // What the last `pending` answer said, so a timeout reports why (locator.not-found, element.covered...).
  let last: AgentErrorInfo = { code: 'timeout' };
  const locator = locatorOf(original);
  // Changes when the locator crosses into a cross-origin iframe.
  let request = original;
  let frameId: number | undefined;
  // For `locate` / `measure`: where the frame we moved into starts in the tab's viewport (frames add up).
  const offset = { x: 0, y: 0 };
  for (;;) {
    const budgetMs = Math.max(0, Math.min(SLICE_MS, deadline - Date.now() - 150));
    let outcome: Outcome | undefined;
    try {
      outcome = await callAgent(tabId, { request, budgetMs }, frameId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(await tabExists(tabId))) throw new CodedError('tab.closed', 'The tab was closed', { locator });
      if (restricted(message)) throw new CodedError(restrictedCode(message), `The browser does not let extensions work on this page: ${message}`, { locator });
      reason = `the page was busy loading (${message})`;
      last = { code: 'navigation.failed' };
    }
    if (outcome?.status === 'frame') {
      const inner = await frameShowing(tabId, outcome.src, frameId ?? 0);
      if (inner === undefined) {
        reason = `waiting for the frame ${outcome.src} to load`;
        last = { code: 'frame.unreachable' };
      } else {
        frameId = inner;
        const current = locatorOf(request) ?? '';
        const crossed = current.endsWith(outcome.rest) ? current.slice(0, current.length - outcome.rest.length) : '';
        // A drag's target in the same frame: drop the frame part from it too.
        const to = request.op === 'drag' && crossed && request.to.startsWith(crossed) ? { to: request.to.slice(crossed.length) } : {};
        request = { ...request, locator: outcome.rest, ...to } as AgentRequest;
        offset.x += outcome.offset?.x ?? 0;
        offset.y += outcome.offset?.y ?? 0;
        continue;
      }
    }
    if (outcome?.status === 'done') {
      // The agent in a frame answers in that frame's coordinates; real input needs the tab's.
      if ((request.op === 'locate' || request.op === 'measure') && typeof outcome.result.x === 'number' && typeof outcome.result.y === 'number') {
        return { ...outcome.result, x: outcome.result.x + offset.x, y: outcome.result.y + offset.y };
      }
      return outcome.result;
    }
    if (outcome?.status === 'error') {
      throw new CodedError(outcome.code ?? 'step.failed', outcome.message, { locator: locatorOf(request) ?? locator, url: outcome.url, matches: outcome.matches });
    }
    if (outcome?.status === 'pending') {
      reason = outcome.reason;
      last = { code: outcome.code ?? 'timeout', url: outcome.url };
    }
    if (outcome?.status === 'vanished') {
      // The page navigated while the agent was answering. An action has then almost certainly
      // happened (and caused the navigation); repeating it could submit a form twice.
      if (ONCE.has(request.op)) return { navigated: true };
      reason = 'the page navigated';
      last = { code: 'timeout' };
    }
    if (Date.now() >= deadline) {
      throw new CodedError(last.code ?? 'timeout', `Timed out after ${Math.round(timeoutMs / 1000)}s: ${reason}`, { locator, url: last.url });
    }
    if (outcome?.status !== 'pending') await sleep(250);
  }
}
