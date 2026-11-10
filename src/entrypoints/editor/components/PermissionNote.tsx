import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { toast } from './Dialogs';
import type { OptionalPermission } from '../../../core/types';

type Permission = OptionalPermission;

const WHY: Record<Permission, string> = {
  debugger: 'real mouse and keyboard input (the browser shows a "debugging" bar while it is used)',
  userScripts: 'running your own scripts. In chrome://extensions, also switch on "Allow User Scripts" for BlockFlow',
  cookies: "reading and changing the browser's cookies (HttpOnly ones too)",
  declarativeNetRequest: 'blocking and redirecting requests in this workflow’s tab',
  browsingData: 'clearing the explicitly listed sites’ browser data (cookies may affect their whole registrable domain)',
};

/** Asks for an optional permission when a block needs it. Must be a click: browsers only ask then. */
export async function requestPermission(permission: Permission): Promise<boolean> {
  try {
    return await browser.permissions.request({ permissions: [permission] });
  } catch {
    toast(`This browser does not offer the "${permission}" permission.${permission === 'cookies' || permission === 'declarativeNetRequest' ? '' : ' It works in Chrome, Edge and Brave.'}`, 'error');
    return false;
  }
}

/**
 * Shown in the config panel for blocks that declare `permissions`: lists the optional permissions
 * not yet granted, each with a Grant button. Checks with `permissions.contains` on mount.
 */
export function PermissionNote({ permissions }: { permissions: Permission[] }) {
  const [missing, setMissing] = useState<Permission[]>([]);

  useEffect(() => {
    let alive = true;
    void Promise.all(permissions.map(async (permission) => ((await browser.permissions.contains({ permissions: [permission] }).catch(() => false)) ? null : permission))).then(
      (list) => {
        if (alive) setMissing(list.filter((item): item is Permission => item !== null));
      },
    );
    return () => {
      alive = false;
    };
    // By value: a block's permission list may be a new array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissions.join(',')]);

  if (missing.length === 0) return null;
  return (
    <div className="bf-problems bf-permission">
      {missing.map((permission) => (
        <p key={permission}>
          Needs the <strong>{permission}</strong> permission for {WHY[permission]}.{' '}
          <button
            type="button"
            onClick={() =>
              void requestPermission(permission).then((granted) => {
                if (granted) setMissing((current) => current.filter((item) => item !== permission));
              })
            }
          >
            Grant
          </button>
        </p>
      ))}
    </div>
  );
}
