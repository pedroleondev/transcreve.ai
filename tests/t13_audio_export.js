// T-13 — Áudio original autenticado + exportação em massa (ZIP).
// RODAR DENTRO DO CONTAINER:
//   docker exec -w /app transcreveai-app node tests/t13_audio_export.js
//
// Custo zero: TRANSCRIBE_PROVIDER=mock, banco isolado (DB_PATH em tmpdir),
// servidor spawnado na porta 3130. Cobre:
//   1. GET  /api/transcriptions/:id/audio → 200/401/404, Range → 206
//   2. POST /api/export/bulk              → ZIP com itens válidos + _erros.txt
// Arquivos enviados no teste são apagados no cleanup (lidos via DB isolado).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');

const PORT = 3130;
const BASE = `http://localhost:${PORT}`;
const FIXTURE = path.join(__dirname, 'fixtures', 'sample.ogg');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`, extra); }
}

async function api(token, method, route, body) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return { status: res.status, data: await res.json(), headers: res.headers };
  return { status: res.status, data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

function upload(token, filePath, fileName) {
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(filePath)]), fileName);
  return fetch(`${BASE}/api/transcribe`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form
  }).then(async res => ({ status: res.status, data: await res.json().catch(() => ({})) }));
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

async function waitCompleted(token, expectedCount, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(token, 'GET', '/api/transcriptions');
    const list = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.transcriptions || []);
    const done = list.filter(t => t.status === 'completed');
    if (done.length >= expectedCount) return done;
    await sleep(800);
  }
  throw new Error('timeout aguardando transcrições completarem');
}

async function main() {
  const dbPath = path.join(os.tmpdir(), `t13-audio-${process.pid}.sqlite`);
  console.log('T-13 — Áudio autenticado + export em massa\n');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_PATH: dbPath,
      TRANSCRIBE_PROVIDER: 'mock',
      MOCK_LATENCY_MS: '2000',
      WORKER_CONCURRENCY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', b => process.stderr.write(b));

  try {
    await waitForServer(server);
    await sleep(500);

    const adminLogin = await api(null, 'POST', '/api/auth/login', { email: 'admin@turboscribe.local', password: 'admin123' });
    assert('login admin', adminLogin.status === 200 && !!adminLogin.data.token);
    const admin = adminLogin.data.token;

    const created = await api(admin, 'POST', '/api/admin/users', {
      name: 'T13 User', email: `t13${Date.now()}@teste.local`, password: 'senha123', role: 'user', daily_limit: 50
    });
    assert('usuário comum criado', created.status === 200 && !!created.data.id);
    const userRow = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
      db.get(`SELECT email FROM users WHERE id = ?`, [created.data.id], (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    const uLogin = await api(null, 'POST', '/api/auth/login', { email: userRow.email, password: 'senha123' });
    assert('login usuário comum', uLogin.status === 200 && !!uLogin.data.token);
    const user = uLogin.data.token;

    // Upload de 2 arquivos → aguarda concluir (mock) para obter ids reais
    const up1 = await upload(user, FIXTURE, 'reuniao-1.ogg');
    const up2 = await upload(user, FIXTURE, 'reuniao-2.ogg');
    assert('2 uploads → 202', up1.status === 202 && up2.status === 202);
    const done = await waitCompleted(user, 2);
    assert('2 transcrições concluídas', done.length >= 2);
    const [t1, t2] = done.slice(0, 2);
    const fixtureSize = fs.statSync(FIXTURE).size;

    // --- 1) Áudio autenticado -------------------------------------------
    let r = await api(user, 'GET', `/api/transcriptions/${t1.id}/audio`);
    assert('áudio: dono baixa → 200', r.status === 200, `status=${r.status}`);
    assert('áudio: bytes batem com o fixture', r.data.length === fixtureSize, `${r.data.length} != ${fixtureSize}`);
    assert('áudio: Accept-Ranges presente', (r.headers.get('accept-ranges') || '') === 'bytes');
    const cd = r.headers.get('content-disposition') || '';
    assert('áudio: Content-Disposition com nome original', /filename\*=UTF-8/.test(cd), cd);

    r = await api(null, 'GET', `/api/transcriptions/${t1.id}/audio`);
    assert('áudio: sem token → 401', r.status === 401, `status=${r.status}`);

    r = await api(admin, 'GET', `/api/transcriptions/${t1.id}/audio`);
    assert('áudio: admin sem ?all=true não acessa alheio → 404', r.status === 404, `status=${r.status}`);

    r = await api(admin, 'GET', `/api/transcriptions/${t1.id}/audio?all=true`);
    assert('áudio: admin com ?all=true acessa → 200', r.status === 200, `status=${r.status}`);

    r = await api(user, 'GET', `/api/transcriptions/nao-existe/audio`);
    assert('áudio: id inexistente → 404', r.status === 404, `status=${r.status}`);

    // Range: primeiros 100 bytes (para seek de players)
    const resRange = await fetch(`${BASE}/api/transcriptions/${t1.id}/audio`, {
      headers: { 'Authorization': `Bearer ${user}`, 'Range': 'bytes=0-99' }
    });
    const rangeBuf = Buffer.from(await resRange.arrayBuffer());
    assert('áudio: Range → 206', resRange.status === 206, `status=${resRange.status}`);
    assert('áudio: Range retorna exatamente 100 bytes', rangeBuf.length === 100, `${rangeBuf.length} != 100`);
    const fixtureHead = fs.readFileSync(FIXTURE).subarray(0, 100);
    assert('áudio: bytes do Range batem com o arquivo', rangeBuf.equals(fixtureHead));
    assert('áudio: Content-Range correto',
      /^bytes 0-99\/\d+$/.test(resRange.headers.get('content-range') || ''),
      resRange.headers.get('content-range'));

    // --- 2) Export em massa ----------------------------------------------
    const ids = [t1.id, t2.id];
    r = await api(user, 'POST', '/api/export/bulk', { ids, format: 'txt' });
    assert('bulk: dono exporta 2 ids → 200', r.status === 200, `status=${r.status}`);
    assert('bulk: é um ZIP (magic bytes PK)', r.data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
    const zipText = r.data.toString('latin1');
    assert('bulk: contém reuniao-1.txt', zipText.includes('reuniao-1.txt'));
    assert('bulk: contém reuniao-2.txt', zipText.includes('reuniao-2.txt'));
    assert('bulk: sem _erros.txt quando tudo ok', !zipText.includes('_erros.txt'));

    r = await api(user, 'POST', '/api/export/bulk', { ids: [...ids, 'nao-existe'], format: 'txt' });
    assert('bulk: lote com id inválido → 200 (não aborta)', r.status === 200, `status=${r.status}`);
    assert('bulk: _erros.txt presente no lote com falha', r.data.toString('latin1').includes('_erros.txt'));

    r = await api(admin, 'POST', '/api/export/bulk', { ids, format: 'txt' });
    assert('bulk: admin sem ?all=true → 200 com zip só de erros', r.status === 200, `status=${r.status}`);
    assert('bulk: sem ?all=true não vaza os arquivos', !r.data.toString('latin1').includes('reuniao-1.txt'));

    r = await api(user, 'POST', '/api/export/bulk', { ids, format: 'exe' });
    assert('bulk: formato inválido → 400', r.status === 400, `status=${r.status}`);

    r = await api(user, 'POST', '/api/export/bulk', { ids: [], format: 'txt' });
    assert('bulk: lista vazia → 400', r.status === 400, `status=${r.status}`);

    r = await api(user, 'POST', '/api/export/bulk', { ids, format: 'srt' });
    assert('bulk: formato srt → 200', r.status === 200, `status=${r.status}`);

    r = await api(user, 'POST', '/api/export/bulk', { ids, format: 'docx' });
    assert('bulk: formato docx → 200', r.status === 200, `status=${r.status}`);

    r = await api(null, 'POST', '/api/export/bulk', { ids, format: 'txt' });
    assert('bulk: sem token → 401', r.status === 401, `status=${r.status}`);
  } finally {
    server.kill();
    await sleep(400);
    await new Promise((resolve) => {
      if (!fs.existsSync(dbPath)) return resolve();
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
      db.all(`SELECT file_path FROM transcriptions`, [], (err, rows) => {
        db.close();
        for (const row of rows || []) {
          const abs = path.join(__dirname, '..', String(row.file_path).replace(/^\//, ''));
          fs.promises.unlink(abs).catch(() => {});
        }
        resolve();
      });
    });
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  }

  console.log(`\n${passed}/${passed + failed} PASS`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERRO inesperado:', e); process.exit(1); });
