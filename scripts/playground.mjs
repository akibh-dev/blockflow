#!/usr/bin/env node
/**
 * Serves docs/manual-test (the playground and the clock page) at http://localhost:7357, for the
 * editor's "Try it" card and README's "Try it end to end". No dependencies.
 *
 *   npm run playground            then open http://localhost:7357/playground.html
 *   PORT=8080 npm run playground  another port (the "Try it" template expects 7357)
 *
 * Why not ship the playground inside the extension (public/playground.html)? Chromium never lets an
 * extension script a chrome-extension:// page, its own included ("Cannot access contents of url
 * chrome-extension://…", checked in Chromium 131), so blocks could not click or fill there. data: and
 * file: URLs are not scriptable either (file: only with "Allow access to file URLs"), and Open Tab
 * takes http(s) addresses. A page on localhost works like any website.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PLAYGROUND_PORT = 7357;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/manual-test');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

/** Starts the server; resolves once it listens. */
export function startPlayground(port = PLAYGROUND_PORT) {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const name = pathname === '/' ? 'playground.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      // The editor checks whether the playground is up with fetch(): let it read the answer.
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || PLAYGROUND_PORT;
  startPlayground(port).then(
    () => console.log(`BlockFlow playground: http://localhost:${port}/playground.html (clock page: /clock.html). Ctrl+C stops it.`),
    (error) => {
      console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use (already running?)` : error);
      process.exit(1);
    },
  );
}
