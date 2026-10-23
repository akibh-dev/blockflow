import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { hasTemplate } from '../../../core/template';
import { DEFAULT_TIMEOUT_SECONDS, MAX_RETRIES } from '../../../core/engine';
import type { StepRecord } from '../../../core/runs';
import type { FieldSpec, StepSettings, TextField } from '../../../core/types';
import { isExtensionMessage } from '../../../shared/messages';
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
}

interface PickState {
  status: 'idle' | 'waiting' | 'done' | 'error';
  text?: string;
}

export function ConfigPanel({ node, problems, onChange, onStepChange, onDelete, lastStep }: ConfigPanelProps) {
  const [pick, setPick] = useState<PickState>({ status: 'idle' });
  const pending = useRef<{ nodeId: string; field: TextField } | null>(null);

  // Results of the element picker arrive as messages from the background worker.
  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isExtensionMessage(message)) return;
      const target = pending.current;
      if (!target) return;
      if (message.type === 'bf:pick-result') {
        const patch: Record<string, unknown> = { [target.field.key]: message.selector };
        if (target.field.pickerUrlKey) patch[target.field.pickerUrlKey] = message.url;
        onChange(target.nodeId, patch);
        pending.current = null;
        setPick({ status: 'done', text: message.sample ? `Picked: “${message.sample}”` : 'Element picked' });
      } else if (message.type === 'bf:pick-error') {
        pending.current = null;
        setPick({ status: 'error', text: message.message });
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

  const startPick = useCallback(
    (nodeId: string, field: TextField, config: Record<string, unknown>) => {
      pending.current = { nodeId, field };
      setPick({ status: 'waiting', text: 'Switch to the page and click the part you want. Esc cancels.' });
      const urlValue = field.pickerUrlKey ? String(config[field.pickerUrlKey] ?? '') : '';
      const url = urlValue && !hasTemplate(urlValue) ? urlValue : undefined;
      void browser.runtime.sendMessage({ type: 'bf:start-pick', ...(url ? { url } : {}) }).catch(() => {
        setPick({ status: 'error', text: 'Could not reach the background worker. Try reloading the extension.' });
      });
    },
    [],
  );

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

  return (
    <aside className="bf-config">
      <h2>
        {def.icon} {def.label}
      </h2>
      <p className="bf-muted">{def.description}</p>

      {problems.length > 0 && (
        <ul className="bf-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {def.fields.map((field) => (
        <label key={field.key} className="bf-field">
          <span>{field.label}</span>
          <FieldInput
            field={field}
            value={config[field.key]}
            onChange={(value) => onChange(node.id, { [field.key]: value })}
          />
          {(field.kind === 'selector') && (
            <>
              <button type="button" onClick={() => startPick(node.id, field, config)}>
                🎯 Pick on page
              </button>
              {pick.status !== 'idle' && <small className={`bf-pick ${pick.status}`}>{pick.text}</small>}
            </>
          )}
          {field.help && <small className="bf-muted">{field.help}</small>}
        </label>
      ))}

      {lastStep && <StepResult step={lastStep} />}

      <StepSettingsEditor step={node.data.step ?? {}} onChange={(patch) => onStepChange(node.id, patch)} />

      <details className="bf-outputs">
        <summary>Data this block passes on</summary>
        <ul>
          {def.outputs.map((output) => (
            <li key={output.key}>
              <code>{`{{${output.key}}}`}</code> — {output.description}
            </li>
          ))}
        </ul>
        <p className="bf-muted">Use these in the next block’s settings, e.g. an Open URL block can open <code>{'{{url}}'}</code>.</p>
      </details>

      <button type="button" className="bf-danger" onClick={() => onDelete(node.id)}>
        Delete block
      </button>
    </aside>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  onChange(value: unknown): void;
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

function StepSettingsEditor({ step, onChange }: { step: StepSettings; onChange(patch: Partial<StepSettings>): void }) {
  const configured = Boolean(step.timeoutSeconds || step.retries || (step.onError && step.onError !== 'stop') || step.disabled || step.note);
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
          placeholder={String(DEFAULT_TIMEOUT_SECONDS)}
          value={step.timeoutSeconds ?? ''}
          onChange={(event) => onChange({ timeoutSeconds: event.target.value === '' ? undefined : Number(event.target.value) })}
        />
      </label>
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
      <div className="bf-json-label">Input</div>
      <pre className="bf-json">{json(step.input)}</pre>
      <div className="bf-json-label">Output</div>
      <pre className="bf-json">{step.output ? json(step.output) : step.status === 'passed' ? '(nothing: the flow stops here)' : '—'}</pre>
    </details>
  );
}

function json(value: unknown): string {
  return value === undefined ? '—' : JSON.stringify(value, null, 2);
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
