// Tiny server for the fixture site in tests/fixtures/site, used by tests/e2e/run.mjs.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/site');

/** The fixture login accepts this password (e2e passes it as a secret). */
export const PASSWORD = 'Op3n-Sesame!';

export function startServer() {
  let orders = 1000;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const ok = form.get('password') === PASSWORD && form.get('email');
      const next = ok
        ? `/welcome.html?name=${encodeURIComponent(form.get('email').split('@')[0])}&country=${form.get('country')}&remember=${form.get('remember') ?? 'off'}`
        : '/login.html?error=1';
      res.writeHead(303, { location: next });
      return res.end();
    }
    if (url.pathname === '/api/slow') {
      await new Promise((resolve) => setTimeout(resolve, 700));
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ order: (orders += 1) }));
    }
    if (url.pathname === '/api/save' && req.method === 'POST') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end('{"saved":true}');
    }
    // One same-origin frame, and one from another origin (localhost vs 127.0.0.1, same server).
    if (url.pathname === '/frames.html') {
      const port = server.address().port;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><title>Fixture: frames</title><h1>Checkout</h1>
        <iframe id="same" src="/frame-inner.html" width="400" height="160"></iframe>
        <iframe id="other" src="http://localhost:${port}/frame-inner.html" width="400" height="160"></iframe>`);
    }
    // Three pages of products, 3 per page, with a Next link except on the last page.
    if (url.pathname === '/products') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const cards = [1, 2, 3]
        .map((n) => (page - 1) * 3 + n)
        .map((id) => `<li class="card"><h2>Product ${id}</h2><span class="price">$${id * 10}</span><a href="/p/${id}">details</a></li>`)
        .join('');
      const next = page < 3 ? `<a class="next" href="/products?page=${page + 1}">Next</a>` : '<span class="next disabled">Next</span>';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><title>Products ${page}</title><h1>Page ${page}</h1><ul>${cards}</ul><nav>${next}</nav>`);
    }
    // The SPA serves its page for its client-side routes too.
    const file = url.pathname.startsWith('/spa') ? 'spa.html' : url.pathname.slice(1) || 'login.html';
    try {
      const data = await readFile(path.join(root, path.normalize(file)));
      res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
