// Dev-only helper: serves the procedural film generator and writes trailers and
// posters into public/films and full films into samples/films. Not part of the app or its build.
// Regenerating changes the masters, so update masterSha256 in lib/catalog.ts afterwards.
//   node scripts/film-generator/server.mjs   then open http://localhost:4100
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Trailers and posters are public; full-length masters stay with the studio.
const publicDir = join(here, '..', '..', 'public', 'films');
const masterDir = join(here, '..', '..', 'samples', 'films');
const outDir = (name) => (name.endsWith('-trailer.webm') || /\.(png|jpg)$/.test(name) ? publicDir : masterDir);
const allowedName = /^[a-z0-9-]+\.(webm|png|jpg)$/;
const maxBytes = 40 * 1024 * 1024;

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(await readFile(join(here, 'index.html')));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/save') {
      const name = url.searchParams.get('name') ?? '';
      if (!allowedName.test(name)) throw new Error(`Rejected file name: ${name}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) throw new Error('File too large');
        chunks.push(chunk);
      }
      await mkdir(outDir(name), { recursive: true });
      await writeFile(join(outDir(name), name), Buffer.concat(chunks));
      console.log(`saved ${name} (${(size / 1024).toFixed(0)} KB)`);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    console.error(error);
    response.writeHead(400).end(String(error));
  }
}).listen(4100, '127.0.0.1', () => console.log('Film generator on http://localhost:4100'));
