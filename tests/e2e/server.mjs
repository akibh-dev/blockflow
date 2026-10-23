// Tiny server for the fixture site in tests/fixtures/site, used by tests/e2e/run.mjs.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/site');

export function startServer() {
  let orders = 1000;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const ok = form.get('password') === 'secret' && form.get('email');
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
