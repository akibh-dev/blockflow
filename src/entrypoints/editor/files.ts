/** Browser file helpers for the editor page (save a text file, pick a text file). */

/**
 * Saves `text` as a file through a temporary object URL and a synthetic `<a download>` click.
 * The URL is revoked a second later (revoking at once can cancel the download in some browsers).
 */
export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Export file name for a workflow name: lower-case slug plus `.blockflow.json`
 * (`"My Login!"` → `my-login.blockflow.json`, empty slug → `workflow.blockflow.json`).
 * Callers swap the suffix for other formats (`.spec.ts`, `.csv`, `.json`).
 */
export function fileNameFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'workflow'}.blockflow.json`;
}

/** Reads every file of an `<input type="file">` selection as text, in order. `null` gives `[]`. */
export async function readFiles(files: FileList | null): Promise<string[]> {
  return Promise.all(Array.from(files ?? [], (file) => file.text()));
}
