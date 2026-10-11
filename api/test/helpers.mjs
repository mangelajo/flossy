// Arranca la API de verdad (node server.js) en un puerto libre con un DATA_DIR temporal, y da
// clientes HTTP con su propia cookie. Cada fichero de tests usa su propio servidor.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const API_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ORIGIN = 'http://flossy.test';

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

export async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flossy-test-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: API_DIR,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ORIGIN, RP_ID: 'flossy.test', TRUST_PROXY: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* aún arrancando */ }
    if (i > 100 || proc.exitCode !== null) throw new Error('la API no arranca:\n' + log);
    await new Promise(r => setTimeout(r, 50));
  }
  after(() => { proc.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  let ip = 0;
  /** Un cliente = un navegador: guarda su cookie y viene de su propia IP (límites por IP). */
  const client = () => {
    let cookie = '';
    const addr = `10.0.0.${++ip}`;
    const call = async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Forwarded-For': addr, ...(cookie && { Cookie: cookie }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
    };
    return {
      call, get cookie() { return cookie; }, set cookie(v) { cookie = v; },
      get: p => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), put: (p, b) => call('PUT', p, b),
      patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p)
    };
  };

  /** Crea un perfil con contraseña y devuelve su cliente ya con sesión. */
  const signup = async (name, extra = {}) => {
    const c = client();
    const r = await c.post('/api/register/password', { name, password: `${name}-contraseña-larga`, ...extra });
    if (r.status !== 200) throw new Error(`alta de ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    c.user = r.body.user;
    return c;
  };

  return { base, dataDir, client, signup, readJSON: f => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')),
           writeJSON: (f, v) => fs.writeFileSync(path.join(dataDir, f), JSON.stringify(v)) };
}
