// T-08 fase 2 — Driver swap: o app sobe com DB_DRIVER=postgres e as rotas
// principais funcionam contra o service `db` (banco de teste descartável).
// RODAR DENTRO DO CONTAINER:
//   docker exec -w /app transcreveai-app node tests/t08_driver_postgres.js
//
// Custo zero: TRANSCRIBE_PROVIDER=mock. Cobre os caminhos que tocam cada
// tabela/peça de dialeto: seeds (users/settings), quota 24h (cutoff portátil),
// upsert de settings (ON CONFLICT), fila (ORDER BY id, claim condicional),
// chunks/segmentos (INSERT em lote), export, glossary, métricas e logs
// (is_active boolean, ORDER BY "timestamp").

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Client } = require('pg');

const PORT = 3132;
const BASE = `http://localhost:${PORT}`;
const FIXTURE = path.join(__dirname, 'fixtures', 'sample.ogg');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PG_ADMIN = {
  host: process.env.PGHOST || 'db',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'transcreveai',
  password: process.env.PGPASSWORD || 'transcreveai_local_dev',
  database: 'postgres', // maintenance db p/ criar/destruir o banco de teste
};

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
  const data = ct.includes('application/json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data };
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
      if (buf.toString().includes('verificadas/criadas')) { clearTimeout(timeout); resolve(); }
    });
    proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error('servidor morreu cedo: ' + code)); });
  });
}

async function waitCompleted(token, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await api(token, 'GET', '/api/transcriptions');
    const list = Array.isArray(r.data) ? r.data : [];
    const done = list.filter(t => t.status === 'completed');
    if (done.length >= 1) return done;
    await sleep(800);
  }
  throw new Error('timeout aguardando transcrição completar');
}

async function main() {
  const testDb = `t08f2_${process.pid}`;
  console.log('T-08 fase 2 — Driver PostgreSQL (app inteiro contra o service `db`)\n');

  const admin = new Client(PG_ADMIN);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${testDb}`);
  console.log(`Banco de teste criado: ${testDb}`);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_DRIVER: 'postgres',
      PGDATABASE: testDb,
      TRANSCRIBE_PROVIDER: 'mock',
      MOCK_LATENCY_MS: '2000',
      WORKER_CONCURRENCY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', b => process.stderr.write(b));

  let pgUser; // conexão no banco de teste — visível no finally p/ limpeza

  try {
    await waitForServer(server);
    await sleep(500);

    // 1. Seeds e auth
    const login = await api(null, 'POST', '/api/auth/login', { email: 'admin@turboscribe.local', password: 'admin123' });
    assert('seed admin no Postgres + login', login.status === 200 && !!login.data.token, `status=${login.status}`);
    const adminToken = login.data.token;

    const me = await api(adminToken, 'GET', '/api/auth/me');
    assert('auth/me: admin ilimitado no Postgres', me.data?.user?.quota_unlimited === true);

    // 2. CRUD de usuário + quota (cutoff portátil + COUNT 24h)
    const created = await api(adminToken, 'POST', '/api/admin/users', {
      name: 'PG User', email: `pg${Date.now()}@teste.local`, password: 'senha123', role: 'user', daily_limit: 1
    });
    assert('admin cria usuário cotado', created.status === 200 && !!created.data.id);

    pgUser = new Client({ ...PG_ADMIN, database: testDb });
    await pgUser.connect();
    const uRow = (await pgUser.query(`SELECT email FROM users WHERE id = $1`, [created.data.id])).rows[0];
    const uLogin = await api(null, 'POST', '/api/auth/login', { email: uRow.email, password: 'senha123' });
    assert('login do usuário cotado', uLogin.status === 200 && !!uLogin.data.token);
    const user = uLogin.data.token;

    const up1 = await upload(user, FIXTURE, 'pg-quota.ogg');
    assert('1º upload cotado → 202', up1.status === 202, `status=${up1.status}`);
    const up2 = await upload(user, FIXTURE, 'pg-quota-2.ogg');
    assert('2º upload cotado → 429 (cutoff 24h portátil)', up2.status === 429, `status=${up2.status}`);

    // 3. Upsert de settings (ON CONFLICT) — vale na hora: fileSize 0 → 413
    await api(adminToken, 'PUT', '/api/admin/settings', { settings: { max_file_size_mb: '0' } });
    const upBlocked = await upload(adminToken, FIXTURE, 'pg-413.ogg');
    assert('max_file_size_mb=0 → 413 no Postgres', upBlocked.status === 413, `status=${upBlocked.status}`);
    await api(adminToken, 'PUT', '/api/admin/settings', { settings: { max_file_size_mb: '5120' } });
    const settingsNow = await api(adminToken, 'GET', '/api/admin/settings');
    assert('settings restauradas via ON CONFLICT upsert', settingsNow.data?.max_file_size_mb === '5120',
      `got ${settingsNow.data?.max_file_size_mb}`);

    // 4. Fila + chunks + segmentos (mock completa o job)
    const upAdmin = await upload(adminToken, FIXTURE, 'pg-fluxo.ogg');
    assert('upload admin → 202', upAdmin.status === 202);
    const done = await waitCompleted(adminToken);
    const t = done[0];
    assert('transcrição concluída (fila/chunks/segmentos no PG)', !!t && t.status === 'completed');
    assert('raw_text persistido', typeof t.raw_text === 'string' && t.raw_text.length > 0);

    // segmentos reais gravados?
    const segs = await pgUser.query(`SELECT COUNT(*)::int AS n FROM segments WHERE transcription_id = $1`, [t.id]);
    assert('segmentos gravados no Postgres', segs.rows[0].n > 0, `n=${segs.rows[0].n}`);

    // 5. Export + áudio + progresso (getJobProgress: CASE/EXTRACT portáteis)
    const exp = await api(adminToken, 'GET', `/api/export/${t.id}/txt`);
    assert('export txt → 200 com conteúdo', exp.status === 200 && Buffer.from(exp.data).length > 0);
    const aud = await api(adminToken, 'GET', `/api/transcriptions/${t.id}/audio`);
    assert('áudio autenticado → 200', aud.status === 200, `status=${aud.status}`);
    const prog = await api(adminToken, 'GET', `/api/transcriptions/${t.id}/status`);
    assert('status/progresso → 200', prog.status === 200, `status=${prog.status}`);

    // 6. T-04: salvar edição de segmentos (transação dedicada; contrato exige
    //    a lista completa com os IDs existentes)
    const detail = await api(adminToken, 'GET', `/api/transcriptions/${t.id}`);
    const segsAtuais = detail.data?.segments || [];
    assert('detalhe traz segmentos para edição', segsAtuais.length > 0);
    const editados = segsAtuais.map((s, i) => ({ id: s.id, text: i === 0 ? 'Texto editado no Postgres.' : s.text }));
    const save = await api(adminToken, 'PUT', `/api/transcriptions/${t.id}`, { segments: editados });
    assert('salvar edição (segments PUT) → 200', save.status === 200, `status=${save.status} ${JSON.stringify(save.data).slice(0,120)}`);
    const posSave = await api(adminToken, 'GET', `/api/transcriptions/${t.id}`);
    assert('edição persistida (raw_text atualizado)', posSave.data?.raw_text?.includes('Texto editado no Postgres.'));

    // 7. Glossário (403 user / 200 admin / persistido)
    const gUser = await api(user, 'POST', '/api/admin/glossary', { wrong: 'tsto', correct: 'teste' });
    assert('glossário: usuário comum → 403', gUser.status === 403, `status=${gUser.status}`);
    const gAdmin = await api(adminToken, 'POST', '/api/admin/glossary', { wrong: 'tsto', correct: 'teste' });
    assert('glossário: admin adiciona → 200', gAdmin.status === 200, `status=${gAdmin.status}`);
    const gList = await api(user, 'GET', '/api/glossary');
    assert('glossário listado com termo', Array.isArray(gList.data) && gList.data.some(g => g.wrong === 'tsto'));

    // 8. api_keys booleanos: seed direto (enc:v1: fake — não dispara recifragem) e leituras
    await pgUser.query(
      `INSERT INTO api_keys (id, provider, name, key_value, is_active, last_check_ok)
       VALUES ('pgkey-1', 'openrouter', 'Chave Teste PG', 'enc:v1:AAAA:BBBB:CCCC', TRUE, TRUE)`
    );
    const kStatus = await api(adminToken, 'GET', '/api/admin/apikeys/status');
    assert('apikeys/status: boolean is_active lido no PG', kStatus.status === 200 && kStatus.data.configured === true,
      `status=${kStatus.status} ${JSON.stringify(kStatus.data).slice(0,120)}`);
    const kList = await api(adminToken, 'GET', '/api/admin/apikeys');
    assert('apikeys lista sem vazar key_value', kList.status === 200
      && Array.isArray(kList.data)
      && kList.data.every(k => k.key_value === undefined));

    // 9. Métricas (is_active = TRUE + agregações) e logs (ORDER BY "timestamp")
    const metrics = await api(adminToken, 'GET', '/api/admin/metrics');
    assert('métricas → 200', metrics.status === 200, `status=${metrics.status}`);
    const logs = await api(adminToken, 'GET', '/api/admin/logs');
    assert('logs → 200 (ORDER BY timestamp no PG)', logs.status === 200 && Array.isArray(logs.data),
      `status=${logs.status} ${JSON.stringify(logs.data).slice(0,150)}`);

    // 10. Projetos (FK user_id) — criação e listagem
    const proj = await api(user, 'POST', '/api/projects', { name: 'Projeto PG' });
    assert('criar projeto → 200', proj.status === 200 || proj.status === 201, `status=${proj.status}`);
  } finally {
    server.kill();
    await sleep(500);
    // Limpa os arquivos de upload físicos ANTES de dropar o banco (file_path
    // só existe lá). Blocos de áudio o pipeline já apaga ao concluir.
    try {
      const files = await pgUser.query(`SELECT file_path FROM transcriptions`).catch(() => ({ rows: [] }));
      for (const row of files.rows) {
        const abs = path.join(__dirname, '..', String(row.file_path).replace(/^\//, ''));
        fs.promises.unlink(abs).catch(() => {});
      }
    } catch (_) {}
    if (pgUser) await pgUser.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`).catch(() => {});
    await admin.end();
    console.log(`Banco de teste destruído: ${testDb}`);
  }

  console.log(`\n${passed}/${passed + failed} PASS`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERRO inesperado:', e); process.exit(1); });
