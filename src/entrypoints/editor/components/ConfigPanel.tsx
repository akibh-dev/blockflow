import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { hasTemplate } from '../../../core/template';
import { DEFAULT_TIMEOUT_SECONDS, MAX_RETRIES } from '../../../core/engine';
import type { StepRecord } from '../../../core/runs';
import type { FieldSpec, Row, RowsField, StepSettings, TextField, WorkflowField } from '../../../core/types';
import { Screenshot } from './Screenshot';
import { SnapshotButton } from './SnapshotButton';
import { TemplateInput } from './TemplateInput';
import { PermissionNote, requestPermission } from './PermissionNote';
import { isExtensionMessage } from '../../../shared/messages';
import type { StartPickMessage } from '../../../shared/messages';
import { registry } from '../registry';
import type { BlockFlowNode } from './BlockNode';

interface ConfigPanelProps {
  node: BlockFlowNode | undefined;
  problems: string[];
  onChange(nodeId: string, patch: Record<string, unknown>): void;
  onStepChange(nodeId: string, patch: Partial<StepSettings>): void;
  onDelete(nodeId: string): void;
  /** What this block did in the run being inspected, if it ran. */
  lastStep: StepRecord | undefined;
  /** For "workflow" fields (Run Workflow). */
  workflows: { id: string; name: string }[];
  /** Data names offered after typing {{ in templated settings. */
  suggestions: string[];
  /** URL of the nearest Open Tab before this block: where to pick when the block has no URL of its own. */
  upstreamUrl?: string;
}

interface PickState {
  status: 'idle' | 'waiting' | 'done' | 'error';
  text?: string;
  /** Other locators for the picked element, offered as one-click alternatives. */
  candidates?: string[];
}

/** What the picker is picking for: a field, one cell of a rows field, or a whole form. */
type PickTarget =
  | { kind: 'field'; nodeId: string; field: TextField }
  | { kind: 'cell'; nodeId: string; field: RowsField; row: number; column: string }
  | { kind: 'form'; nodeId: string; field: RowsField };

/**
 * Right column on the canvas view: the settings of the selected block, generated from the block's
 * `fields` (so new blocks need no editor changes), plus "Pick on page" for selector/locator fields
 * and rows cells, the last step's input/output, step settings and the list of outputs.
 *
 * Picking: `startPick` sends `bf:start-pick` and remembers the target in `pending`; the answer comes
 * back as a `bf:pick-result` / `bf:pick-error` runtime message, which this component listens for.
 * Messages that arrive with no pending target (another editor tab started the pick) are ignored.
 */
export function ConfigPanel({ node, problems, onChange, onStepChange, onDelete, lastStep, workflows, suggestions, upstreamUrl }: ConfigPanelProps) {
  const [pick, setPick] = useState<PickState & { fieldKey?: string }>({ status: 'idle' });
  const pending = useRef<PickTarget | null>(null);
  const configRef = useRef<Record<string, unknown>>({});

  // Results of the element picker arrive as messages from the background worker.
  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isExtensionMessage(message)) return;
      const target = pending.current;
      if (!target) return;
      if (message.type === 'bf:pick-result') {
        pending.current = null;
        const rows = (configRef.current[target.field.key] as Row[] | undefined) ?? [];
        if (target.kind === 'field') {
          const readable = target.field.pickPrefers !== 'stable' && message.candidates?.[0];
          const patch: Record<string, unknown> = { [target.field.key]: readable || message.selector };
          if (target.field.pickerUrlKey) patch[target.field.pickerUrlKey] = message.url;
          onChange(target.nodeId, patch);
        } else if (target.kind === 'cell') {
          const next = [...rows];
          next[target.row] = { ...next[target.row], [target.column]: message.candidates?.[0] ?? message.selector };
          onChange(target.nodeId, { [target.field.key]: next });
        } else {
          // Keep values already typed for fields that are still there.
          const known = new Map(rows.map((row) => [row.locator, row.value ?? '']));
          const detected = (message.fields ?? []).map((found) => ({
            locator: found.locator,
            value: known.get(found.locator) ?? '',
            ...(found.hint ? { hint: found.hint } : {}),
          }));
          onChange(target.nodeId, { [target.field.key]: detected });
          setPick({ status: 'done', fieldKey: target.field.key, text: `Found ${detected.length} field${detected.length === 1 ? '' : 's'}. Fill in the values you need; empty ones are skipped.` });
          return;
        }
        setPick({
          status: 'done',
          fieldKey: target.field.key,
          text: message.sample ? `Picked: “${message.sample}”` : 'Element picked',
          ...(target.kind === 'field' && message.candidates && message.candidates.length > 0
            ? { candidates: [...new Set([...message.candidates, message.selector])] }
            : {}),
        });
      } else if (message.type === 'bf:pick-error') {
        pending.current = null;
        setPick({ status: 'error', fieldKey: target.field.key, text: message.message });
      } else if (message.type === 'bf:pick-cancelled') {
        // Esc in the page: the picker tells every extension page, this one included.
        pending.current = null;
        setPick({ status: 'idle' });
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, [onChange]);

  // A new selection should not inherit the previous block's picker status.
  useEffect(() => {
    setPick({ status: 'idle' });
    pending.current = null;
  }, [node?.id]);

  const startPick = useCallback((target: PickTarget, config: Record<string, unknown>) => {
    pending.current = target;
    setPick({
      status: 'waiting',
      fieldKey: target.field.key,
      text:
        target.kind === 'form'
          ? 'Switch to the page and click any field of the form. Esc cancels.'
          : 'Switch to the page and click the part you want. Esc cancels.',
    });
    // The block's own URL (Watch/Read Element), else the nearest Open Tab before it.
    const urlKey = target.kind === 'field' ? target.field.pickerUrlKey : undefined;
    const urlValue = urlKey ? String(config[urlKey] ?? '') : '';
    const own = urlValue && !hasTemplate(urlValue) ? urlValue : undefined;
    const url = own ?? upstreamUrl;
    const mode: StartPickMessage['mode'] = target.kind === 'form' ? 'form' : target.kind === 'field' && target.field.pickPrefers === 'stable' ? 'watch' : 'action';
    const message: StartPickMessage = { type: 'bf:start-pick', ...(url ? { url, urlFrom: own ? 'block' : 'upstream' } : {}), mode };
    void browser.runtime.sendMessage(message).catch(() => {
      setPick({ status: 'error', fieldKey: target.field.key, text: 'Could not reach the background worker. Try reloading the extension.' });
    });
  }, [upstreamUrl]);

  if (!node) {
    return (
      <aside className="bf-config">
        <p className="bf-muted">Select a block to edit its settings.</p>
      </aside>
    );
  }

  const def = registry.get(node.data.blockType);
  if (!def) {
    return (
      <aside className="bf-config">
        <p className="bf-error">Unknown block type “{node.data.blockType}”.</p>
        <button type="button" onClick={() => onDelete(node.id)}>
          Delete block
        </button>
      </aside>
    );
  }

  const config = { ...def.defaultConfig, ...node.data.config } as Record<string, unknown>;
  configRef.current = config;
  const pickStatus = (key: string) =>
    pick.status !== 'idle' && pick.fieldKey === key ? (
      <>
        <small className={`bf-pick ${pick.status}`}>{pick.text}</small>
        {pick.candidates && (
          <span className="bf-candidates">
            <small className="bf-muted">Other ways to find it:</small>
            {pick.candidates.map((candidate) => (
              <button
                type="button"
                key={candidate}
                className={config[key] === candidate ? 'active' : ''}
                onClick={() => onChange(node.id, { [key]: candidate })}
                title="Use this locator"
              >
                {candidate}
              </button>
            ))}
          </span>
        )}
      </>
    ) : null;

  return (
    <aside className="bf-config">
      <h2>
        {def.icon} {def.label}
      </h2>
      <p className="bf-muted">{def.description}</p>

      {(() => {
        const listed = typeof def.permissions === 'function' ? def.permissions(config) : def.permissions;
        // Firefox has no debugger API: blocks that use it there take another path or explain at run time.
        const needed = import.meta.env.FIREFOX ? listed?.filter((permission) => permission !== 'debugger') : listed;
        return needed && needed.length > 0 ? <PermissionNote permissions={needed} /> : null;
      })()}

      {problems.length > 0 && (
        <ul className="bf-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {def.fields.map((field) =>
        field.kind === 'rows' ? (
          <div key={field.key} className="bf-field">
            <span>{field.label}</span>
            <RowsInput
              field={field}
              rows={(config[field.key] as Row[] | undefined) ?? []}
              onChange={(rows) => onChange(node.id, { [field.key]: rows })}
              suggestions={suggestions}
              onPickCell={(row, column) => startPick({ kind: 'cell', nodeId: node.id, field, row, column }, config)}
              onDetect={() => startPick({ kind: 'form', nodeId: node.id, field }, config)}
            />
            {pickStatus(field.key)}
            {field.help && <small className="bf-muted">{field.help}</small>}
          </div>
        ) : (
          <label key={field.key} className="bf-field">
            <span>{field.label}</span>
            {field.kind === 'workflow' ? (
              <select value={String(config[field.key] ?? '')} onChange={(event) => onChange(node.id, { [field.key]: event.target.value })}>
                <option value="">Choose a workflow…</option>
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            ) : (
              <FieldInput field={field} value={config[field.key]} suggestions={suggestions} onChange={(value) => onChange(node.id, { [field.key]: value })} />
            )}
            {(field.kind === 'selector' || field.kind === 'locator') && (
              <>
                <button type="button" onClick={() => startPick({ kind: 'field', nodeId: node.id, field }, config)}>
                  🎯 Pick on page
                </button>
                {pickStatus(field.key)}
              </>
            )}
            {field.help && <small className="bf-muted">{field.help}</small>}
          </label>
        ),
      )}

      {def.type === 'open-url' && <SnapshotButton url={String(config.url ?? '')} />}

      {lastStep && <StepResult step={lastStep} />}

      <StepSettingsEditor
        step={node.data.step ?? {}}
        onChange={(patch) => onStepChange(node.id, patch)}
        defaultTimeout={def.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}
        realInput={def.realInput === true}
      />

      <details className="bf-outputs">
        <summary>Data this block passes on</summary>
        <ul>
          {def.outputs.map((output) => (
            <li key={output.key}>
              <code>{`{{${output.key}}}`}</code> — {output.description}
            </li>
          ))}
        </ul>
        <p className="bf-muted">Use these in the next block’s settings, e.g. an Open Tab block can open <code>{'{{url}}'}</code>.</p>
      </details>

      <button type="button" className="bf-danger" onClick={() => onDelete(node.id)}>
        Delete block
      </button>
    </aside>
  );
}

/** Editable table for a `rows` field (Fill Form, Extract List, Manual Start...), with per-cell picking and "Detect fields". */
function RowsInput({
  field,
  rows,
  onChange,
  onPickCell,
  onDetect,
  suggestions,
}: {
  field: RowsField;
  rows: Row[];
  onChange(rows: Row[]): void;
  suggestions: string[];
  onPickCell(row: number, column: string): void;
  onDetect(): void;
}) {
  const update = (index: number, key: string, value: string) => onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  const blank = Object.fromEntries(field.columns.map((column) => [column.key, '']));
  return (
    <div className="bf-rows">
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {field.columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // Rows have no ids; the index is their identity while editing.
              // eslint-disable-next-line react/no-array-index-key
              <tr key={index}>
                {field.columns.map((column) => (
                  <td key={column.key}>
                    <div className="bf-cell">
                      <TemplateInput
                        value={row[column.key] ?? ''}
                        suggestions={column.templated ? suggestions : []}
                        placeholder={column.key === 'value' && row.hint ? row.hint : column.placeholder}
                        title={row.hint ?? ''}
                        ariaLabel={`${column.label} ${index + 1}`}
                        onChange={(value) => update(index, column.key, value)}
                      />
                      {column.locator && (
                        <button type="button" title="Pick on page" onClick={() => onPickCell(index, column.key)}>
                          🎯
                        </button>
                      )}
                    </div>
                  </td>
                ))}
                <td>
                  <button type="button" className="bf-link" title="Remove row" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="bf-rows-actions">
        <button type="button" onClick={() => onChange([...rows, { ...blank }])}>
          + Add row
        </button>
        {field.detectForm && (
          <button type="button" onClick={onDetect} title="Click any field of a form on the page; every field of that form is listed here">
            🎯 Detect fields
          </button>
        )}
      </div>
    </div>
  );
}

/** The input for one scalar field kind: checkbox, number, select, or text (a `TemplateInput` when templated). */
function FieldInput({
  field,
  value,
  onChange,
  suggestions,
}: {
  field: Exclude<FieldSpec, RowsField | WorkflowField>;
  value: unknown;
  onChange(value: unknown): void;
  suggestions: string[];
}) {
  switch (field.kind) {
    case 'boolean':
      return <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
    case 'number':
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))}
        />
      );
    case 'select':
      return (
        <select value={String(value ?? '')} onChange={(event) => onChange(event.target.value)}>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    default:
      if (field.templated) {
        return (
          <TemplateInput
            value={typeof value === 'string' ? value : ''}
            suggestions={suggestions}
            placeholder={field.placeholder}
            multiline={field.multiline}
            onChange={onChange}
          />
        );
      }
      if (field.multiline) {
        return (
          <textarea
            rows={4}
            value={typeof value === 'string' ? value : ''}
            placeholder={field.placeholder}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        );
      }
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      );
  }
}

/** "Step settings" disclosure (on error, retries, timeout, screenshot, real input, disabled, note); open when any is set. */
function StepSettingsEditor({
  step,
  onChange,
  defaultTimeout,
  realInput,
}: {
  step: StepSettings;
  onChange(patch: Partial<StepSettings>): void;
  defaultTimeout: number;
  /** The block's page actions honour real input (`BlockDefinition.realInput`). */
  realInput: boolean;
}) {
  const configured = Boolean(step.timeoutSeconds || step.retries || (step.onError && step.onError !== 'stop') || step.disabled || step.note || step.screenshot || step.realInput);
  return (
    <details className="bf-step-settings" open={configured}>
      <summary>Step settings{configured ? ' (changed)' : ''}</summary>
      <label className="bf-field">
        <span>On error</span>
        <select value={step.onError ?? 'stop'} onChange={(event) => onChange({ onError: event.target.value as StepSettings['onError'] })}>
          <option value="stop">Stop this path (run fails)</option>
          <option value="continue">Continue with the same data</option>
          <option value="port">Send to the “error” output</option>
        </select>
      </label>
      <label className="bf-field">
        <span>Retries</span>
        <input
          type="number"
          min={0}
          max={MAX_RETRIES}
          value={step.retries ?? 0}
          onChange={(event) => onChange({ retries: Number(event.target.value) || 0 })}
        />
        <small className="bf-muted">Try again after 1s, 2s, 4s… before giving up.</small>
      </label>
      <label className="bf-field">
        <span>Timeout (seconds)</span>
        <input
          type="number"
          min={1}
          placeholder={String(defaultTimeout)}
          value={step.timeoutSeconds ?? ''}
          onChange={(event) => onChange({ timeoutSeconds: event.target.value === '' ? undefined : Number(event.target.value) })}
        />
      </label>
      <label className="bf-field">
        <span>Screenshot of the tab</span>
        <select value={step.screenshot ?? 'error'} onChange={(event) => onChange({ screenshot: event.target.value as StepSettings['screenshot'] })}>
          <option value="error">when something goes wrong</option>
          <option value="always">after every run of this block</option>
          <option value="never">never</option>
        </select>
        <small className="bf-muted">Only possible while the tab is showing in its window (Open Tab “in a new window” works best).</small>
      </label>
      {/* Only page actions use it; still shown when set elsewhere (an imported file) so it can be cleared. */}
      {(realInput || step.realInput === true) && (
        <label className="bf-field bf-inline" title="For sites that ignore synthetic clicks and typing. Chromium browsers only.">
          <input
            type="checkbox"
            checked={step.realInput === true}
            onChange={(event) => {
              if (!event.target.checked) onChange({ realInput: false });
              else void requestPermission('debugger').then((granted) => onChange({ realInput: granted }));
            }}
          />
          <span>Use real mouse and keyboard (debugger)</span>
        </label>
      )}
      <label className="bf-field bf-inline">
        <input type="checkbox" checked={step.disabled === true} onChange={(event) => onChange({ disabled: event.target.checked })} />
        <span>Disabled (skip it, pass the data through)</span>
      </label>
      <label className="bf-field">
        <span>Note</span>
        <input type="text" value={step.note ?? ''} onChange={(event) => onChange({ note: event.target.value })} />
      </label>
    </details>
  );
}

/** The selected block's step in the inspected run: status, error, screenshot, input and output JSON. */
function StepResult({ step }: { step: StepRecord }) {
  return (
    <details className={`bf-step-result ${step.status}`} open>
      <summary>
        Last run: <strong>{step.status}</strong>
        {step.durationMs !== undefined && ` · ${formatMs(step.durationMs)}`}
        {step.attempts > 1 && ` · ${step.attempts} attempts`}
        {step.port && step.port !== 'out' && ` · → ${step.port}`}
      </summary>
      {step.error && <p className="bf-error">{step.error}</p>}
      <ErrorDetails step={step} />
      {step.screenshot && <Screenshot id={step.screenshot} />}
      <div className="bf-json-label">Input</div>
      <pre className="bf-json">{json(step.input)}</pre>
      <div className="bf-json-label">Output</div>
      <pre className="bf-json">{step.output ? json(step.output) : step.status === 'passed' ? '(nothing: the flow stops here)' : '—'}</pre>
    </details>
  );
}

/** A failed step's error code (src/core/errors.ts) and, for strict-mode errors, what matched. Small: the message says it in words. */
export function ErrorDetails({ step }: { step: StepRecord }) {
  if (!step.code) return null;
  return (
    <div className="bf-error-code">
      <code title="Error code (in reports and the JSON export)">{step.code}</code>
      {step.matches && step.matches.length > 0 && (
        <ul>
          {step.matches.map((match) => (
            <li key={match}>{match}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function json(value: unknown): string {
  return value === undefined ? '—' : JSON.stringify(value, null, 2);
}

/** Human duration: `850 ms`, `2.5 s`, `12 s`. Also used by `LogPanel` and `ReportsPage`. */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
