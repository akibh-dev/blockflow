/**
 * In-editor replacements for `window.alert/confirm/prompt`: a toast, a confirm dialog and a small
 * input dialog. The native ones block the page (and with it React and the storage listeners), look
 * different in every browser, and cannot be driven by tests.
 *
 * They are plain functions over a module-level store, so they work from anywhere (callbacks, helpers
 * like `requestPermission`) without a context: `toast('Saved')`, `await confirmDialog({...})`,
 * `await promptDialog({...})`. `<DialogHost />` (rendered once in App.tsx) shows them.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { FormEvent } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

export interface ConfirmOptions {
  title?: string;
  message: string;
  /** Text of the confirm button. Default "OK". */
  confirmLabel?: string;
  /** Red confirm button (deleting things). */
  danger?: boolean;
}

export interface PromptOptions {
  title?: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** A problem with the value (shown under the input, keeps the dialog open), or null when fine. */
  validate?(value: string): string | null;
}

type Dialog =
  | ({ id: number; kind: 'confirm'; resolve(value: boolean): void } & ConfirmOptions)
  | ({ id: number; kind: 'prompt'; resolve(value: string | null): void } & PromptOptions);

interface Snapshot {
  toasts: Toast[];
  dialogs: Dialog[];
}

let snapshot: Snapshot = { toasts: [], dialogs: [] };
let nextId = 1;
const listeners = new Set<() => void>();

function update(change: (current: Snapshot) => Snapshot): void {
  snapshot = change(snapshot);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** How long a toast stays; errors stay longer. Hovering does not matter: each has a close button. */
const TOAST_MS: Record<ToastKind, number> = { info: 5_000, success: 4_000, error: 9_000 };

/** Shows a short message in the bottom right corner. Newlines are kept. */
export function toast(message: string, kind: ToastKind = 'info'): void {
  const id = nextId++;
  update((current) => ({ ...current, toasts: [...current.toasts.slice(-4), { id, message, kind }] }));
  setTimeout(() => dismissToast(id), TOAST_MS[kind]);
}

function dismissToast(id: number): void {
  update((current) => ({ ...current, toasts: current.toasts.filter((item) => item.id !== id) }));
}

/** Asks a yes/no question in a modal. Resolves true on confirm, false on Cancel or Escape. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    update((current) => ({ ...current, dialogs: [...current.dialogs, { ...options, id: nextId++, kind: 'confirm', resolve }] }));
  });
}

/** Asks for one line of text in a modal. Resolves the trimmed text, or null on Cancel or Escape. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    update((current) => ({ ...current, dialogs: [...current.dialogs, { ...options, id: nextId++, kind: 'prompt', resolve }] }));
  });
}

function closeDialog(dialog: Dialog, value: boolean | string | null): void {
  update((current) => ({ ...current, dialogs: current.dialogs.filter((item) => item.id !== dialog.id) }));
  if (dialog.kind === 'confirm') dialog.resolve(value === true);
  else dialog.resolve(typeof value === 'string' ? value : null);
}

/** One open dialog (the oldest first; the rest wait their turn). */
function DialogBox({ dialog }: { dialog: Dialog }) {
  const [value, setValue] = useState(dialog.kind === 'prompt' ? (dialog.defaultValue ?? '') : '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog.kind === 'prompt') {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else confirmRef.current?.focus();
  }, [dialog]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeDialog(dialog, dialog.kind === 'confirm' ? false : null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dialog.kind === 'confirm') {
      closeDialog(dialog, true);
      return;
    }
    const text = value.trim();
    const problem = dialog.validate?.(text) ?? null;
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    closeDialog(dialog, text);
  };

  const titleId = `bf-dialog-title-${dialog.id}`;
  return (
    <div className="bf-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeDialog(dialog, dialog.kind === 'confirm' ? false : null)}>
      <form className="bf-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={submit}>
        <h3 id={titleId}>{dialog.title ?? (dialog.kind === 'confirm' ? 'Are you sure?' : 'BlockFlow')}</h3>
        <p className="bf-modal-message">{dialog.message}</p>
        {dialog.kind === 'prompt' && (
          <>
            <input
              ref={inputRef}
              type="text"
              aria-label={dialog.message}
              value={value}
              placeholder={dialog.placeholder}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
            {error && <p className="bf-error bf-modal-error">{error}</p>}
          </>
        )}
        <div className="bf-modal-actions">
          <button type="button" onClick={() => closeDialog(dialog, dialog.kind === 'confirm' ? false : null)}>
            Cancel
          </button>
          <button ref={confirmRef} type="submit" className={dialog.kind === 'confirm' && dialog.danger ? 'bf-danger-solid' : 'bf-run'}>
            {dialog.confirmLabel ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Renders the toasts and the current dialog. Mount once, near the root. */
export function DialogHost() {
  const { toasts, dialogs } = useSyncExternalStore(subscribe, () => snapshot);
  const dialog = dialogs[0];
  return (
    <>
      {dialog && <DialogBox key={dialog.id} dialog={dialog} />}
      <div className="bf-toasts" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`bf-toast ${item.kind}`}>
            <span>{item.message}</span>
            <button type="button" className="bf-toast-close" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
