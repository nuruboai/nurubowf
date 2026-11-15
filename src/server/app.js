// 試作サーバー: node server/app.js → http://localhost:8787
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialState, WorkflowError } from './engine.js';
import { loadOrg } from './org.js';
import { handleApi, errorResponse } from './api.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'data', 'runtime', 'state.json');
const PORT = Number(process.env.PORT || 8787);
const SEED = process.env.SEED || path.join(ROOT, 'data', 'sample-org.json');

async function fresh() { return initialState(await loadOrg(SEED)); }
let state = existsSync(RUNTIME) ? JSON.parse(await readFile(RUNTIME, 'utf8')) : await fresh();
const ctx = {
  getState: () => state,
  setState: s => { state = s; },
  save: async () => { await mkdir(path.dirname(RUNTIME), { recursive: true }); await writeFile(RUNTIME, JSON.stringify(state)); },
  fresh,
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, ng) => {
  let b = '';
  req.on('data', d => { b += d; if (b.length > 2e6) ng(new WorkflowError('送られたデータが大きすぎます')); });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { ng(new WorkflowError('JSONの形が正しくありません')); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : undefined;
      const r = await handleApi(ctx, req.method, url.pathname, url.searchParams, body);
      return send(res, r.status, r.json);
    }
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(ROOT, 'web', path.normalize(rel));
    if (!file.startsWith(path.join(ROOT, 'web'))) return send(res, 403, { error: '見られません' });
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') return send(res, 404, { error: 'ファイルがありません' });
    if (!(err instanceof WorkflowError)) console.error(err);
    const r = errorResponse(err);
    send(res, r.status, r.json);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`承認ワークフロー試作: http://localhost:${PORT}`));
