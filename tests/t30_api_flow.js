// T-30 — API pública v1: chave pessoal, escopo por usuário, webhook assinado.
// RODAR DENTRO DO CONTAINER:
//   docker exec -w /app transcreveai-app node tests/t30_api_flow.js
//
// Custo zero: TRANSCRIBE_PROVIDER=mock, banco isolado (DB_PATH em tmpdir),
// servidor spawnado na porta 3131. Cobre:
//   1. Auth v1 (401 sem chave / malformada / revogada; 403 conta suspensa não coberto aqui)
//   2. Uma chave por usuário (409 sem rotate; rotate revoga a anterior)
//   3. POST /api/v1/transcriptions multipart → 202 + headers X-RateLimit
//   4. Escopo: chave de outro usuário não lê o job (404)
//   5. Polling → completed → GET /text
//   6. Webhook recebido com X-Falou-Signature HMAC-SHA256 válido
//   7. DELETE da chave → 401 nas rotas v1

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');

const PORT = 3131;
const BASE = `http://localhost:${PORT}`;
const FIXTURE = path.join(__dirname, 'fixtures', 'sample.ogg');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra); }
}

async function api(bearer, method, route, body, isForm) {
  const headers = {};
  if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

function v1Upload(key, filePath, fileName, fields = {}) {
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(filePath)]), fileName);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(`${BASE}/api/v1/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form
  }).then(async res => ({ status: res.status, data: await res.json().catch(() => ({})), headers: res.headers }));
}

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('servidor de teste não subiu')), 30000);
    proc.stdout.on('data', (buf) => {
      if (buf.toString().includes('Tabelas SQLite verificadas/criadas')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error('servidor morreu cedo: ' + code)); });
  });
}

async function makeUser(admin, tag, limit, dbPath) {
  const created = await api(admin, 'POST', '/api/admin/users', {
    name: `T30 ${tag}`, email: `t30-${tag}-${Date.now()}@teste.local`, password: 'senha123', role: 'user', daily_limit: limit
  });
  if (created.status !== 200 || !created.data.id) throw new Error('falha criando usuário: ' + JSON.stringify(created.data));
  const row = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    db.get(`SELECT email FROM users WHERE id = ?`, [created.data.id], (err, r) => { db.close(); err ? reject(err) : resolve(r); });
  });
  const login = await api(null, 'POST', '/api/auth/login', { email: row.email, password: 'senha123' });
  if (login.status !== 200 || !login.data.token) throw new Error('falha no login do usuário de teste');
  return { jwt: login.data.token, email: row.email };
}

// Receiver de webhook: guarda body cru + headers de cada POST recebido.
function startWebhookReceiver() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({
        raw: Buffer.concat(chunks).toString('utf8'),
        event: req.headers['x-falou-event'],
        signature: req.headers['x-falou-signature']
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/hook` });
  }));
}

async function main() {
  const dbPath = path.join(os.tmpdir(), `t30-api-${process.pid}.sqlite`);
  console.log('T-30 — API v1: chave pessoal + escopo + webhook\n');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_DRIVER: 'sqlite', // o container roda postgres; testes exigem banco isolado
      DB_PATH: dbPath,
      TRANSCRIBE_PROVIDER: 'mock',
      MOCK_LATENCY_MS: '1500',
      WORKER_CONCURRENCY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', b => process.stderr.write(b));

  const hook = await startWebhookReceiver();

  try {
    await waitForServer(server);
    await sleep(500);

    const adminLogin = await api(null, 'POST', '/api/auth/login', { email: 'admin@turboscribe.local', password: 'admin123' });
    assert('login admin', adminLogin.status === 200 && !!adminLogin.data.token);
    const admin = adminLogin.data.token;

    const u1 = await makeUser(admin, 'pedro', 50, dbPath);
    const u2 = await makeUser(admin, 'larissa', 50, dbPath);

    // --- 1) Auth v1 ------------------------------------------------------
    let r = await api(null, 'GET', '/api/v1/account');
    assert('v1: sem chave → 401', r.status === 401, `status=${r.status}`);
    r = await api('Bearer fk_live_naoexistente000000000000000000000000000000', 'GET', '/api/v1/account');
    assert('v1: chave inexistente → 401', r.status === 401, `status=${r.status}`);
    r = await api('Bearer abcdef123456', 'GET', '/api/v1/account');
    assert('v1: chave malformada → 401', r.status === 401, `status=${r.status}`);

    // --- 2) Criação de chave: uma por usuário, rotate revoga -------------
    const k1 = await api(u1.jwt, 'POST', '/api/account/apikey', { name: 'n8n' });
    assert('chave criada → 200 + fk_live_', k1.status === 200 && /^fk_live_[a-f0-9]{48}$/.test(k1.data.api_key || ''), JSON.stringify(k1.data).slice(0, 120));
    assert('webhook_secret devolvido 1x', /^[a-f0-9]{32}$/.test(k1.data.webhook_secret || ''));
    const KEY1 = k1.data.api_key;
    const SECRET1 = k1.data.webhook_secret;

    const dup = await api(u1.jwt, 'POST', '/api/account/apikey', { name: 'outra' });
    assert('segunda chave sem rotate → 409', dup.status === 409 && dup.data.rotate_hint === true, `status=${dup.status}`);

    const rot = await api(u1.jwt, 'POST', '/api/account/apikey?rotate=1', { name: 'n8n' });
    assert('rotate → 200 nova chave', rot.status === 200 && /^fk_live_/.test(rot.data.api_key || ''));
    r = await api(KEY1, 'GET', '/api/v1/account');
    assert('chave antiga após rotate → 401', r.status === 401, `status=${r.status}`);
    const KEY = rot.data.api_key;
    const SECRET = rot.data.webhook_secret;

    const list = await api(u1.jwt, 'GET', '/api/account/apikey');
    assert('GET /api/account/apikey lista histórico', list.status === 200 && Array.isArray(list.data.history) && list.data.history.length === 2);

    // --- 3) Saldo da conta via chave ------------------------------------
    r = await api(KEY, 'GET', '/api/v1/account');
    assert('v1/account → 200 com quota', r.status === 200 && r.data.quota && r.data.quota.limit === 50, JSON.stringify(r.data).slice(0, 120));
    assert('v1/account: headers X-RateLimit', r.headers.get('x-ratelimit-limit') === '50');

    // --- 4) Criação de job via API v1 ------------------------------------
    const up = await v1Upload(KEY, FIXTURE, 'reuniao-t30.ogg', { mode: 'max', language: 'pt', callback_url: hook.url });
    assert('v1 upload → 202', up.status === 202, `status=${up.status} ${JSON.stringify(up.data).slice(0, 160)}`);
    assert('v1 upload: X-RateLimit-Limit header', up.headers.get('x-ratelimit-limit') === '50');
    const job = up.data.data && up.data.data[0];
    assert('v1 upload: retorna id do job', !!job && !!job.id && job.status === 'pending');

    // texto ainda não disponível → 409
    r = await api(KEY, 'GET', `/api/v1/transcriptions/${job.id}/text`);
    assert('text antes de concluir → 409', r.status === 409 && r.data.status === 'pending', `status=${r.status}`);

    // --- 5) Escopo: chave do u2 não lê job do u1 -------------------------
    const k2 = await api(u2.jwt, 'POST', '/api/account/apikey', { name: 'n8n' });
    assert('chave do segundo usuário criada', k2.status === 200 && !!k2.data.api_key);
    r = await api(k2.data.api_key, 'GET', `/api/v1/transcriptions/${job.id}`);
    assert('escopo: chave alheia → 404', r.status === 404, `status=${r.status}`);

    // chave v1 não toca rotas admin / apikey alheia
    r = await api(KEY, 'GET', '/api/admin/users');
    assert('chave v1 em rota admin → bloqueada (403)', r.status === 401 || r.status === 403, `status=${r.status}`);
    r = await api(KEY, 'POST', '/api/account/apikey', {});
    assert('chave v1 em rota de JWT → bloqueada (403)', r.status === 401 || r.status === 403, `status=${r.status}`);

    // --- 6) Polling até completar ----------------------------------------
    let final = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      r = await api(KEY, 'GET', `/api/v1/transcriptions/${job.id}`);
      if (r.status === 200 && (r.data.status === 'completed' || r.data.status === 'failed')) { final = r.data; break; }
      await sleep(800);
    }
    assert('job completou (mock)', final && final.status === 'completed', `status=${final && final.status}`);

    r = await api(KEY, 'GET', `/api/v1/transcriptions/${job.id}/text`);
    assert('text após completed → 200 com texto', r.status === 200 && typeof r.data.text === 'string' && r.data.text.length > 0, `status=${r.status}`);

    // --- 7) Webhook recebido e assinatura válida -------------------------
    await sleep(2500); // backoff [0,1s,3s,7s,15s] — 1ª tentativa é imediata
    const wh = hook.received.find(w => w.event && w.event.startsWith('transcription.'));
    assert('webhook recebido', !!wh);
    if (wh) {
      const expected = crypto.createHmac('sha256', SECRET).update(wh.raw).digest('hex');
      assert('assinatura HMAC-SHA256 válida', wh.signature === expected);
      const payload = JSON.parse(wh.raw);
      assert('payload: event completed + id do job', payload.event === 'transcription.completed' && payload.id === job.id, wh.raw.slice(0, 120));
    }

    // --- 8) Revogação -----------------------------------------------------
    const cur = await api(u1.jwt, 'GET', '/api/account/apikey');
    const del = await api(u1.jwt, 'DELETE', `/api/account/apikey/${cur.data.active.id}`);
    assert('DELETE revoga → 200', del.status === 200, `status=${del.status}`);
    r = await api(KEY, 'GET', '/api/v1/account');
    assert('chave revogada → 401', r.status === 401, `status=${r.status}`);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('ERRO no teste:', e);
    process.exitCode = 1;
  } finally {
    hook.server.close();
    server.kill();
    fs.rmSync(dbPath, { force: true });
  }
}

main();
