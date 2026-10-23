import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteDataset, listDatasets } from '../../../browser/blobStore';
import type { Dataset } from '../../../browser/blobStore';
import { toCsv } from '../../../core/csv';
import { downloadText, fileNameFor } from '../files';

const PREVIEW_ROWS = 50;

/** Datasets written by Save to Dataset: browse, download, delete. */
export function DataPage() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listDatasets()
      .then((list) => setDatasets(list.sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch(() => setDatasets([]));
  }, []);

  useEffect(() => {
    refresh();
    // Runs keep adding rows while this page is open.
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const current = datasets?.find((dataset) => dataset.name === open) ?? null;
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const row of current?.rows.slice(0, PREVIEW_ROWS) ?? []) {
      if (row && typeof row === 'object' && !Array.isArray(row)) for (const key of Object.keys(row)) if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }, [current]);

  const cell = (value: unknown) => (value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

  return (
    <section className="bf-manage">
      <div className="bf-manage-bar">
        <h2>Data</h2>
        <span className="bf-muted">Datasets saved by “Save to Dataset” blocks, kept in this browser.</span>
        <span className="bf-spacer" />
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      </div>
      {datasets === null && <p className="bf-muted">Loading…</p>}
      {datasets?.length === 0 && <p className="bf-muted">No datasets yet. Add a Save to Dataset block to a workflow and run it.</p>}
      <div className="bf-report">
        <ul className="bf-report-list">
          {datasets?.map((dataset) => (
            <li key={dataset.name}>
              <button type="button" className={dataset.name === open ? 'active' : ''} onClick={() => setOpen(dataset.name)}>
                <strong>{dataset.name}</strong>
                <span className="bf-muted">
                  {dataset.rows.length} rows · updated {new Date(dataset.updatedAt).toLocaleString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {current && (
          <div className="bf-report-detail">
            <div className="bf-manage-bar">
              <h3>{current.name}</h3>
              <span className="bf-spacer" />
              <button type="button" onClick={() => downloadText(fileNameFor(current.name).replace('.blockflow.json', '.csv'), toCsv(current.rows), 'text/csv')}>
                Download CSV
              </button>
              <button type="button" onClick={() => downloadText(fileNameFor(current.name).replace('.blockflow.json', '.json'), JSON.stringify(current.rows, null, 2))}>
                Download JSON
              </button>
              <button
                type="button"
                className="bf-danger"
                onClick={() => {
                  if (!window.confirm(`Delete the dataset “${current.name}” (${current.rows.length} rows)?`)) return;
                  void deleteDataset(current.name).then(() => {
                    setOpen(null);
                    refresh();
                  });
                }}
              >
                Delete
              </button>
            </div>
            <div className="bf-data-preview">
              <table className="bf-table">
                <thead>
                  <tr>
                    <th>#</th>
                    {(columns.length > 0 ? columns : ['value']).map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {current.rows.slice(0, PREVIEW_ROWS).map((row, index) => (
                    // Dataset rows have no ids.
                    // eslint-disable-next-line react/no-array-index-key
                    <tr key={index}>
                      <td className="bf-muted">{index + 1}</td>
                      {columns.length > 0 ? (
                        columns.map((column) => <td key={column}>{cell((row as Record<string, unknown>)?.[column])}</td>)
                      ) : (
                        <td>{cell(row)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {current.rows.length > PREVIEW_ROWS && <p className="bf-muted">Showing the first {PREVIEW_ROWS} of {current.rows.length} rows.</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
