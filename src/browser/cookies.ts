import { browser } from 'wxt/browser';
import { CodedError } from '../core/errors';
import type { CookieInfo, CookieSetOptions } from '../core/types';

/**
 * `Host.cookies`: the browser's cookie jar through the `cookies` API (optional permission, asked for on
 * the Cookies & Storage block). Sees HttpOnly cookies, unlike `document.cookie`.
 */

/** A cookie as the API returns it (Chrome and Firefox). */
type ApiCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expirationDate?: number;
  session?: boolean;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  hostOnly?: boolean;
  storeId?: string;
};

type CookiesApi = {
  getAll(details: Record<string, unknown>): Promise<ApiCookie[]>;
  set(details: Record<string, unknown>): Promise<ApiCookie | null>;
  remove(details: Record<string, unknown>): Promise<unknown>;
};

/** The cookies API, or a `permission.missing` error when the optional permission is not granted. */
async function api(): Promise<CookiesApi> {
  const granted = await browser.permissions.contains({ permissions: ['cookies'] }).catch(() => false);
  const cookies = (browser as unknown as { cookies?: CookiesApi }).cookies;
  if (!granted || !cookies) {
    throw new CodedError('permission.missing', 'Cookies need the "cookies" permission: press Grant on the Cookies & Storage block (or allow it in the extension settings).');
  }
  return cookies;
}

const SAME_SITE: Record<string, CookieInfo['sameSite']> = { strict: 'Strict', lax: 'Lax', no_restriction: 'None', none: 'None' };

function toInfo(cookie: ApiCookie): CookieInfo {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session || cookie.expirationDate === undefined ? -1 : Math.round(cookie.expirationDate),
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: SAME_SITE[String(cookie.sameSite ?? '').toLowerCase()] ?? '',
  };
}

/** A URL that addresses exactly this cookie (what `cookies.remove` needs). */
function cookieUrl(cookie: ApiCookie): string {
  return `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`;
}

function checkUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) throw new CodedError('config.invalid', `Cookies belong to a web address (http or https), not "${url}"`);
}

export async function getCookies(url: string, name?: string): Promise<CookieInfo[]> {
  checkUrl(url);
  const cookies = await api();
  return (await cookies.getAll({ url, ...(name ? { name } : {}) })).map(toInfo);
}

export async function setCookie(options: CookieSetOptions): Promise<CookieInfo> {
  checkUrl(options.url);
  const cookies = await api();
  const sameSite = options.sameSite ? { Strict: 'strict', Lax: 'lax', None: 'no_restriction' }[options.sameSite] : undefined;
  const refused = (why = '') =>
    new CodedError('step.failed', `The browser refused the cookie "${options.name}" for ${options.url}${why ? `: ${why}` : ''} (check domain, Secure and SameSite)`);
  const set = await cookies
    .set({
      url: options.url,
      name: options.name,
      value: options.value,
      ...(options.domain ? { domain: options.domain } : {}),
      ...(options.path ? { path: options.path } : {}),
      ...(options.expires !== undefined && options.expires > 0 ? { expirationDate: options.expires } : {}),
      ...(options.httpOnly ? { httpOnly: true } : {}),
      ...(options.secure ? { secure: true } : {}),
      ...(sameSite ? { sameSite } : {}),
    })
    .catch((error: unknown) => {
      throw refused(error instanceof Error ? error.message : String(error));
    });
  // Chrome answers null (Firefox throws) when the browser refuses the cookie: a secure cookie on
  // http, SameSite=None without Secure, a domain that does not fit the URL.
  if (!set) throw refused();
  return toInfo(set);
}

export async function removeCookies(url: string, name?: string): Promise<number> {
  checkUrl(url);
  const cookies = await api();
  const found = await cookies.getAll({ url, ...(name ? { name } : {}) });
  for (const cookie of found) {
    await cookies.remove({ url: cookieUrl(cookie), name: cookie.name, ...(cookie.storeId ? { storeId: cookie.storeId } : {}) });
  }
  return found.length;
}
