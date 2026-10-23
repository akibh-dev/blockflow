/**
 * Requests the engine sends to the page agent (src/dom/agent.ts), and its answers.
 * Plain data: they travel through `scripting.executeScript`.
 *
 * Locators use Playwright-like syntax, see src/dom/locator.ts:
 *   css=#login button · text=Sign in · role=button[name="Submit"] · label=Email
 *   placeholder=you@example.com · testid=submit · xpath=//form · A >> B · A >> nth=1
 */

export type ReadKind = 'text' | 'value' | 'attribute' | 'has-class' | 'exists' | 'count' | 'visible' | 'checked' | 'enabled';

export type WaitState = 'visible' | 'hidden' | 'attached' | 'detached' | 'enabled' | 'text' | 'no-text';

export type AgentRequest =
  | {
      op: 'click';
      locator: string;
      action: 'click' | 'double' | 'right' | 'hover';
      /** Skip the "is it visible, enabled, not covered" checks. */
      force?: boolean;
    }
  | { op: 'fill'; locator: string; value: string; mode: 'fill' | 'type' }
  /** Set any form field from text: fills inputs, picks select options, ticks checkboxes ("true"/"false"). */
  | { op: 'set-field'; locator: string; value: string }
  | { op: 'select'; locator: string; values: string[] }
  | { op: 'check'; locator: string; checked: boolean }
  | { op: 'press'; key: string; locator?: string }
  | { op: 'read'; locator: string; kind: ReadKind; name?: string }
  | { op: 'wait'; state: WaitState; locator?: string; text?: string }
  | { op: 'detect-form'; locator: string }
  | { op: 'info' }
  /**
   * Scraping: one object per element matching `locator`, with one key per field. A field's
   * locator is searched inside the item (empty = the item itself); `attribute` reads that attribute
   * instead of the text (href/src come back as absolute URLs).
   */
  | { op: 'extract'; locator: string; fields: ExtractField[]; limit?: number }
  /** An HTML table as objects keyed by its header cells. */
  | { op: 'table'; locator: string }
  /** URL, title, description, canonical, language, meta tags, JSON-LD. */
  | { op: 'page-info' }
  | { op: 'storage'; area: 'local' | 'session' | 'cookies'; key?: string }
  | { op: 'scroll'; to: 'bottom' | 'top' | 'element'; locator?: string };

export interface ExtractField {
  name: string;
  locator?: string;
  attribute?: string;
}

/** Sent with every request: how long the agent may keep retrying inside the page before answering. */
export interface AgentCall {
  request: AgentRequest;
  budgetMs: number;
}

export type AgentResponse =
  | { status: 'done'; result: Record<string, unknown> }
  /** Not possible yet (element missing, hidden, disabled...). The driver asks again until its timeout. */
  | { status: 'pending'; reason: string }
  /** Will never work (bad locator, wrong element type...). */
  | { status: 'error'; message: string };

/** One row of a Fill Form block, also what "Detect fields" produces. */
export interface FormFieldRow {
  locator: string;
  value: string;
  /** What the field is, for the editor: "Email · email", "Country · select: BD, US". */
  hint?: string;
}

export type WaitUntil = 'load' | 'networkidle' | 'none';
