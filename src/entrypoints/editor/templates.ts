/**
 * "New from template": the example workflows of docs/guide/examples, so the templates and the
 * guide's examples are the same files (and tests check they import cleanly).
 */
const files = import.meta.glob('../../../docs/guide/examples/*.blockflow.json', { eager: true, import: 'default' }) as Record<
  string,
  { workflows: { name: string }[] }
>;

export interface Template {
  id: string;
  name: string;
  /** The export-format JSON, ready for parseImport. */
  text: string;
  workflows: number;
}

export const templates: Template[] = Object.entries(files)
  .map(([path, file]) => ({
    id: path.split('/').pop()?.replace('.blockflow.json', '') ?? path,
    // A file with several workflows (a reusable login + a test) is named after the last one.
    name: file.workflows.at(-1)?.name ?? path,
    text: JSON.stringify(file),
    workflows: file.workflows.length,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
