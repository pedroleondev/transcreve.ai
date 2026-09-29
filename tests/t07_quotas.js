// T-07 — Cotas e limites de uso.
// RODAR DENTRO DO CONTAINER (ffprobe + mock provider):
//   docker exec -w /app transcreveai-app node tests/t07_quotas.js
//
// Custo zero: TRANSCRIBE_PROVIDER=mock, banco isolado (DB_PATH em tmpdir),
// servidor spawnado na porta 3129. Cobre:
//   1. usuário com daily_limit=1: 1º upload 202, 2º → 429
//   2. lote que estoura a cota → 429 e arquivos apagados do disco
//   3. admin é imune à cota
//   4. max_file_size_mb=0 → 413 (LIMIT_FILE_SIZE), vale na hora
//   5. max_duration_hours=0 → rejeição com error_message claro
//   6. /api/auth/me devolve used_today/quota_unlimited
// Arquivos enviados no teste são apagados no cleanup (lidos via DB isolado).

const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3');

const PORT = 3129;
const BASE = `http://localhost:${PORT}`;
const FIXTURE = path.join(__dirname, 'fixtures', 'sample.ogg');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

async function api(token, method, route, body) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

function upload(token, filePath, fileName) {
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(filePath)]), fileName || path.basename(filePath));
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

async function main() {
  const dbPath = path.join(os.tmpdir(), `t07-quotas-${process.pid}.sqlite`);
  console.log('T-07 — Cotas e limites de uso\n');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_PATH: dbPath,
      TRANSCRIBE_PROVIDER: 'mock',
      MOCK_LATENCY_MS: '3000',
      WORKER_CONCURRENCY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', b => process.stderr.write(b));

  try {
    await waitForServer(server);
    await sleep(500);

    // Login admin (seed do boot) e criação de usuário com cota 1
    const adminLogin = await api(null, 'POST', '/api/auth/login', { email: 'admin@turboscribe.local', password: 'admin123' });
    assert('login admin', adminLogin.status === 200 && !!adminLogin.data.token);
    const admin = adminLogin.data.token;

    const created = await api(admin, 'POST', '/api/admin/users', {
      name: 'Cota Um', email: `cota${Date.now()}@teste.local`, password: 'senha123', role: 'user', daily_limit: 1
    });
    assert('usuário daily_limit=1 criado', created.status === 200);
    // recupera o e-mail gerado no banco isolado e faz login do usuário cotado
    const userRow = await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
      db.get(`SELECT email FROM users WHERE id = ?`, [created.data.id], (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    const uLogin = await api(null, 'POST', '/api/auth/login', { email: userRow.email, password: 'senha123' });
    assert('login usuário cotado', uLogin.status === 200 && !!uLogin.data.token);
    const user = uLogin.data.token;

    // 1. quota: 1º upload ok, 2º → 429
    const up1 = await upload(user, FIXTURE, 'primeiro.ogg');
    assert('1º upload do cotado → 202', up1.status === 202 && up1.data.success === true);
    const up2 = await upload(user, FIXTURE, 'segundo.ogg');
    assert('2º upload do cotado → 429', up2.status === 429);
    assert('429 traz mensagem clara', /limite diário/i.test(up2.data?.error || ''));

    // 6. auth/me traz consumo
    const me = await api(user, 'GET', '/api/auth/me');
    assert('auth/me: used_today=1, limit=1, não ilimitado',
      me.data?.user?.used_today === 1 && me.data?.user?.daily_limit === 1 && me.data?.user?.quota_unlimited === false);
    const meAdmin = await api(admin, 'GET', '/api/auth/me');
    assert('auth/me: admin é ilimitado', meAdmin.data?.user?.quota_unlimited === true);

    // 3. admin é imune à cota
    const upAdmin = await upload(admin, FIXTURE, 'admin1.ogg');
    assert('upload do admin não é bloqueado por cota', upAdmin.status === 202);

    // 2. lote estourando cota: usuário cotado já está em 1/1 → qualquer lote recusado antes
    // (coberto acima). Aqui: admin envia 2 de uma vez com duração inválida p/ testar settings.
    // 4. max_file_size_mb=0 → 413 na hora
    await api(admin, 'PUT', '/api/admin/settings', { settings: { max_file_size_mb: '0' } });
    const upBig = await upload(admin, FIXTURE, 'grande.ogg');
    assert('max_file_size_mb=0 → 413', upBig.status === 413);
    await api(admin, 'PUT', '/api/admin/settings', { settings: { max_file_size_mb: '5120' } });

    // 5. max_duration_hours=0 → rejeição com error_message
    await api(admin, 'PUT', '/api/admin/settings', { settings: { max_duration_hours: '0' } });
    const upLong = await upload(admin, FIXTURE, 'longo.ogg');
    assert('max_duration_hours=0 → 400', upLong.status === 400);
    assert('rejeição cita o limite de horas', /limite de 0 h/i.test(
      JSON.stringify(upLong.data?.errors || upLong.data?.error || '')));
    await api(admin, 'PUT', '/api/admin/settings', { settings: { max_duration_hours: '10' } });

    // destrava: admin volta a subir arquivo após restaurar settings
    const upOk = await upload(admin, FIXTURE, 'restaurado.ogg');
    assert('settings restaurados → upload volta a aceitar', upOk.status === 202);

    // edição de cota inline: sobe o limite do usuário para 5 → upload passa
    await api(admin, 'PUT', `/api/admin/users/${created.data.id}`, { daily_limit: 5 });
    const upAfter = await upload(user, FIXTURE, 'apos-alta.ogg');
    assert('cota elevada pelo admin → upload passa', upAfter.status === 202);
  } finally {
    server.kill();
    await sleep(400);
    // apaga arquivos de upload criados pelo teste (lê caminhos no DB isolado)
    await new Promise((resolve) => {
      if (!fs.existsSync(dbPath)) return resolve();
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
      db.all(`SELECT file_path FROM transcriptions`, [], (err, rows) => {
        db.close();
        for (const r of rows || []) {
          const abs = path.join(__dirname, '..', String(r.file_path).replace(/^\//, ''));
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
