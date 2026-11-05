/**
 * What the sidebar and the "All workflows" page can do to a workflow, by id. Implemented once in
 * `Editor.tsx` and spread into both components as props.
 */
export interface WorkflowActions {
  /** Put the workflow on the canvas and switch to the Canvas view. */
  onOpen(id: string): void;
  /** Add an empty workflow with a unique "Workflow N" name and open it. */
  onCreate(): void;
  /** Adds the workflows of a template (export-format JSON) and opens the last one. */
  onCreateFromTemplate(text: string): void;
  onRename(id: string, name: string): void;
  /** Turn on or off. Turning on is refused (with an alert) while the workflow has errors or no blocks. */
  onToggle(id: string, enabled: boolean): void;
  /** Copy the workflow (new ids, unique name, off) and open the copy. */
  onDuplicate(id: string): void;
  /** Download these workflows as one `.blockflow.json` file. */
  onExport(ids: string[]): void;
  /** Download the workflow as a Playwright test (.spec.ts). */
  onExportPlaywright(id: string): void;
  /** Delete after a confirm dialog. Deleting the last workflow leaves a fresh empty one. */
  onDelete(id: string): void;
  /** Import `.blockflow.json` files; imported workflows are added switched off. */
  onImport(files: FileList | null): void;
}
