import { browser } from 'wxt/browser';
import { sleep, tabExists } from './tabs';
import type { AgentCall, AgentRequest, AgentResponse } from '../core/page';

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
const ACTIONS = new Set<AgentRequest['op']>(['click', 'fill', 'set-field', 'select', 'check', 'press']);

type Outcome = AgentResponse | { status: 'missing' } | { status: 'vanished' };

async function callOnce(tabId: number, call: AgentCall): Promise<Outcome> {
  const [injection] = await browser.scripting.executeScript({
    target: { tabId },
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

async function callAgent(tabId: number, call: AgentCall): Promise<Outcome> {
  const outcome = await callOnce(tabId, call);
  if (outcome.status !== 'missing') return outcome;
  await browser.scripting.executeScript({ target: { tabId }, files: [AGENT_FILE] });
  return callOnce(tabId, call);
}

function restricted(message: string): boolean {
  return /cannot access|cannot be scripted|extensions gallery|chrome:\/\/|about:|missing host permission/i.test(message);
}

export async function actInTab(tabId: number, request: AgentRequest, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + Math.max(timeoutMs, 0);
  let reason = 'the page did not answer';
  for (;;) {
    const budgetMs = Math.max(0, Math.min(SLICE_MS, deadline - Date.now() - 150));
    let outcome: Outcome | undefined;
    try {
      outcome = await callAgent(tabId, { request, budgetMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(await tabExists(tabId))) throw new Error('The tab was closed');
      if (restricted(message)) throw new Error(`The browser does not let extensions work on this page: ${message}`);
      reason = `the page was busy loading (${message})`;
    }
    if (outcome?.status === 'done') return outcome.result;
    if (outcome?.status === 'error') throw new Error(outcome.message);
    if (outcome?.status === 'pending') reason = outcome.reason;
    if (outcome?.status === 'vanished') {
      // The page navigated while the agent was answering. An action has then almost certainly
      // happened (and caused the navigation); repeating it could submit a form twice.
      if (ACTIONS.has(request.op)) return { navigated: true };
      reason = 'the page navigated';
    }
    if (Date.now() >= deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s: ${reason}`);
    if (outcome?.status !== 'pending') await sleep(250);
  }
}
