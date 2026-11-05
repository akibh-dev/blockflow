/**
 * "New from template": the example workflows of docs/guide/examples, so the templates and the
 * guide's examples are the same files (and tests check they import cleanly).
 */
const files = import.meta.glob('../../../docs/guide/examples/*.blockflow.json', { eager: true, import: 'default' }) as Record<
  string,
  { workflows: { name: string }[] }
>;

/** One entry of the "+ New" menu, built from a file in `docs/guide/examples`. */
export interface Template {
  /** File name without `.blockflow.json`. */
  id: string;
  /** Shown in the menu: the name of the file's last workflow. */
  name: string;
  /** The export-format JSON, ready for parseImport. */
  text: string;
  /** How many workflows the file adds (shown when more than one). */
  workflows: number;
}

/** Every template, sorted by name. Bundled at build time by Vite's eager `import.meta.glob`. */
export const templates: Template[] = Object.entries(files)
  .map(([path, file]) => ({
    id: path.split('/').pop()?.replace('.blockflow.json', '') ?? path,
    // A file with several workflows (a reusable login + a test) is named after the last one.
    name: file.workflows.at(-1)?.name ?? path,
    text: JSON.stringify(file),
    workflows: file.workflows.length,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
