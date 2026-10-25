import { useEffect, useState } from 'react';
import { loadScreenshot } from '../../../browser/blobStore';

/** A screenshot taken during a run, loaded from IndexedDB. Click to open it full size. */
export function Screenshot({ id, alt = 'Screenshot' }: { id: string; alt?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void loadScreenshot(id)
      .then((shot) => {
        if (alive) setSrc(shot?.dataUrl ?? null);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  if (src === undefined) return <small className="bf-muted">Loading screenshot…</small>;
  if (src === null) return <small className="bf-muted">Screenshot no longer kept.</small>;
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open full size" className="bf-shot">
      <img src={src} alt={alt} />
    </a>
  );
}
