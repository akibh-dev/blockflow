/** What the sidebar and the "All workflows" page can do to a workflow, by id. */
export interface WorkflowActions {
  onOpen(id: string): void;
  onCreate(): void;
  /** Adds the workflows of a template (export-format JSON) and opens the last one. */
  onCreateFromTemplate(text: string): void;
  onRename(id: string, name: string): void;
  onToggle(id: string, enabled: boolean): void;
  onDuplicate(id: string): void;
  onExport(ids: string[]): void;
  /** Download the workflow as a Playwright test (.spec.ts). */
  onExportPlaywright(id: string): void;
  onDelete(id: string): void;
  onImport(files: FileList | null): void;
}
