/** Browser file helpers for the editor page (save a text file, pick a text file). */

export function downloadText(filename: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileNameFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'workflow'}.blockflow.json`;
}

export async function readFiles(files: FileList | null): Promise<string[]> {
  return Promise.all(Array.from(files ?? [], (file) => file.text()));
}
