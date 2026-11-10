/**
 * Stable error codes for failed steps, so a program (or a model) can tell what went wrong without
 * parsing the message: `locator.strict` means "make the locator more specific", `assert.failed` means
 * "the page is not what the test expected". Recorded on `StepRecord.code` and in the JSON report.
 *
 * Blocks, the browser host and the page driver throw {@link CodedError}; anything else a block throws
 * is recorded as `step.failed`. Pure: no browser APIs.
 */

/** What each code means and what to do about it (the usage guide and the report schema list these). */
export const ERROR_CODES = {
  'locator.not-found': { meaning: 'No element matches the locator (within the step timeout).', fix: 'Check the locator against a page snapshot; wait for the page or the element first.' },
  'locator.strict': { meaning: 'The locator matches more than one element where exactly one is needed.', fix: 'Make it more specific (see `matches`), or add `>> nth=0`.' },
  'locator.invalid': { meaning: 'The locator cannot be parsed (bad CSS, unknown engine, bad regex).', fix: 'Fix the locator syntax.' },
  'element.not-visible': { meaning: 'The element exists but stayed hidden (display:none, hidden, zero size).', fix: 'Open whatever reveals it first (menu, tab, accordion), or wait for it.' },
  'element.disabled': { meaning: 'The element stayed disabled.', fix: 'Fill in what enables it first, or check the right element is targeted.' },
  'element.not-editable': { meaning: 'The field is read-only.', fix: 'Target an editable field.' },
  'element.covered': { meaning: 'Another element (an overlay, a cookie banner) sits on top of it.', fix: 'Close the overlay first, or use `force` on Click.' },
  'element.unstable': { meaning: 'The element kept moving (an animation).', fix: 'Wait for the animation to end.' },
  'element.wrong-type': { meaning: 'The element cannot do this: typing into a button, selecting on a non-select, checking a non-checkbox.', fix: 'Use the block that fits the element, or target the real field.' },
  'option.not-found': { meaning: 'The select has no such option (or it is disabled).', fix: 'Use one of the options the message lists.' },
  timeout: { meaning: 'The step ran out of time waiting for something other than an element (text, URL, a response, a popup).', fix: 'Raise the step timeout, or wait for the right thing.' },
  'assert.failed': { meaning: 'An Assert did not hold.', fix: 'The page differs from what the test expects: fix the expectation or the steps before it.' },
  'visual.mismatch': { meaning: 'A Screenshot with "compare" differs from its baseline by more than the allowed share of pixels (or has another size).', fix: 'Open the step in Reports: if the new look is right, press "Accept new baseline"; mask regions that change on their own.' },
  'http.status': { meaning: 'HTTP Request got a non-2xx answer with "fail on error" on.', fix: 'Check the URL, method, headers and body.' },
  'http.network': { meaning: 'HTTP Request could not reach the server.', fix: 'Check the URL and the host permission.' },
  'navigation.failed': { meaning: 'A page did not load (or the tab never finished loading).', fix: 'Check the URL; raise the timeout for slow pages.' },
  'tab.missing': { meaning: 'No tab of that name in this run.', fix: 'Put an Open Tab block (with that tab name) before the step.' },
  'tab.closed': { meaning: 'The tab was closed while the step used it.', fix: 'Do not close the tab mid-run, or open it again.' },
  'frame.unreachable': { meaning: 'The element is inside a frame the extension cannot reach.', fix: 'Check the `frame=` part of the locator; the frame may not have loaded.' },
  'page.restricted': { meaning: 'The browser does not let extensions script this page (chrome://, the web store, about:).', fix: 'Use a normal web page.' },
  'permission.missing': { meaning: 'An optional permission (host access, debugger, userScripts, downloads) is not granted.', fix: 'Grant it on the block or in the extension settings.' },
  'download.failed': { meaning: 'A download was interrupted or cancelled, or its content cannot be read (Wait for Download).', fix: 'Check the link works in a normal tab; to read the file, its address must still be reachable.' },
  'script.error': { meaning: 'Run Script code threw.', fix: 'Fix the script; the message has its error.' },
  'config.invalid': { meaning: 'A setting is missing or invalid (a required field, a bad URL, a template that does not render).', fix: 'Fix the block setting the message names.' },
  'workflow.failed': { meaning: 'A workflow called by Run Workflow failed.', fix: 'Open the called run (`childRunId`) and fix its failing step.' },
  'step.failed': { meaning: 'Any other failure.', fix: 'Read the message.' },
} as const satisfies Record<string, { meaning: string; fix: string }>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Every code, in the order above. */
export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[];

/** The machine-readable part of an error: what the engine copies onto a step record. */
export interface ErrorDetails {
  code: ErrorCode;
  /** The locator the step was using. */
  locator?: string;
  /** URL of the page when it failed. */
  url?: string;
  /** For `locator.strict`: up to 5 short descriptions of the matching elements. */
  matches?: string[];
}

/** An error with a {@link ErrorCode}. Throw it from blocks and the host; the engine records the code. */
export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly locator?: string;
  readonly url?: string;
  readonly matches?: string[];

  constructor(code: ErrorCode, message: string, extra: Omit<ErrorDetails, 'code'> = {}) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    if (extra.locator) this.locator = extra.locator;
    if (extra.url) this.url = extra.url;
    if (extra.matches && extra.matches.length > 0) this.matches = extra.matches.slice(0, 5);
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

/**
 * The details of any thrown value. Duck-typed (a `code` property that is one of ours), so errors that
 * crossed a bundle boundary still count; everything else is `step.failed`.
 */
export function errorDetails(error: unknown): ErrorDetails {
  if (typeof error !== 'object' || error === null) return { code: 'step.failed' };
  const value = error as Partial<Record<keyof ErrorDetails, unknown>>;
  const details: ErrorDetails = { code: isErrorCode(value.code) ? value.code : 'step.failed' };
  if (typeof value.locator === 'string' && value.locator) details.locator = value.locator;
  if (typeof value.url === 'string' && value.url) details.url = value.url;
  if (Array.isArray(value.matches) && value.matches.length > 0) details.matches = value.matches.slice(0, 5).map(String);
  return details;
}
