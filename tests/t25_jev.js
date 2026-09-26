// Teste de aceite T-25 — JEV: Juiz de Execução e Validação do aprimoramento.
// Zero custo de API: provedor mock (TRANSCRIBE_PROVIDER=mock), banco isolado
// (DB_PATH). MOCK_JUDGE_REJECT=1 faz o juiz reprovar para testar o retry.
// Uso: node tests/t25_jev.js

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const { v4: uuidv4 } = require('uuid');

const BASE_PORT = 3125;
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function api(base, method, url, { token, body } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* resposta vazia */ }
  return { status: res.status, data };
}

async function waitReady(base) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/`);
      if (res.status === 200) return;
    } catch (_) { /* ainda subindo */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Servidor ${base} não respondeu a tempo`);
}

async function login(base, email, password) {
  const { status, data } = await api(base, 'POST', '/api/auth/login', { body: { email, password } });
  return { status, token: data?.token, user: data?.user };
}

// Insere uma transcrição direto no banco isolado (sem upload/ffprobe).
function seedTranscription(dbPath, userId, rawText) {
  const db = new sqlite3.Database(dbPath);
  const id = uuidv4();
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO transcriptions (id, user_id, file_name, file_path, raw_text, status, duration_seconds)
       VALUES (?, ?, 'jev-test.ogg', '/uploads/jev-test.ogg', ?, 'completed', 60)`,
      [id, userId, rawText],
      err => { db.close(); err ? reject(err) : resolve(id); }
    );
  });
}

function readAnalysisRow(dbPath, transcriptionId) {
  const db = new sqlite3.Database(dbPath);
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT judge_model, judge_approved, judge_feedback, attempts FROM ai_analyses WHERE transcription_id = ? ORDER BY created_at DESC LIMIT 1`,
      [transcriptionId],
      (err, row) => { db.close(); err ? reject(err) : resolve(row); }
    );
  });
}

const RAW_TEXT = 'reunião de teste do jev. o cliente pediu ajuste no relatorio mensal e a equipe vai enviar ate sexta feira.';

function startServer(port, db, extraEnv = {}) {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DB_PATH: db, TRANSCRIBE_PROVIDER: 'mock', MOCK_LATENCY_MS: '50', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => process.stderr.write(`[server:${port}] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server:${port}] ${d}`));
  return server;
}

(async () => {
  console.log('T-25 — JEV: juiz de validação do aprimoramento (mock, custo zero)\n');

  const dbA = path.join(os.tmpdir(), `t25-a-${Date.now()}.sqlite`);
  const baseA = `http://localhost:${BASE_PORT}`;
  const serverA = startServer(BASE_PORT, dbA);

  try {
    await waitReady(baseA);
    const admin = await login(baseA, 'admin@turboscribe.local', 'admin123');
    check('login admin OK', admin.status === 200 && !!admin.token);
    const tid = await seedTranscription(dbA, admin.user.id, RAW_TEXT);

    // 1. Juiz ativado por padrão → aprovação registrada
    let r = await api(baseA, 'POST', `/api/transcriptions/${tid}/enhance`, { token: admin.token });
    check('enhance com juiz → 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.data)}`);
    check('judge.approved === true (mock aprova)', r.data?.analysis?.judge?.approved === true, `got ${JSON.stringify(r.data?.analysis?.judge)}`);
    check('attempts === 1 sem reprovação', r.data?.analysis?.attempts === 1, `got ${r.data?.analysis?.attempts}`);
    let row = await readAnalysisRow(dbA, tid);
    check('persiste judge_approved=1', row?.judge_approved === 1, `got ${row?.judge_approved}`);
    check('persiste judge_model', !!row?.judge_model, `got ${row?.judge_model}`);

    // 2. Histórico expõe colunas do juiz
    r = await api(baseA, 'GET', `/api/transcriptions/${tid}/analyses`, { token: admin.token });
    check('analyses retorna judge_approved', r.data?.[0]?.judge_approved === 1, `got ${r.data?.[0]?.judge_approved}`);
    check('analyses retorna attempts', r.data?.[0]?.attempts === 1, `got ${r.data?.[0]?.attempts}`);

    // 3. Juiz desligado → fluxo T-18 puro (judge null)
    r = await api(baseA, 'PUT', '/api/admin/settings', { token: admin.token, body: { settings: { judge_enabled: '0' } } });
    check('desligar juiz (settings) → 200', r.status === 200, `got ${r.status}`);
    r = await api(baseA, 'POST', `/api/transcriptions/${tid}/enhance`, { token: admin.token });
    check('enhance sem juiz → 200', r.status === 200, `got ${r.status}`);
    check('judge === null quando desligado', r.data?.analysis?.judge === null, `got ${JSON.stringify(r.data?.analysis?.judge)}`);
    row = await readAnalysisRow(dbA, tid);
    check('persiste judge_approved=null', row?.judge_approved === null, `got ${row?.judge_approved}`);

    // 4. Roundtrip de config do juiz
    r = await api(baseA, 'PUT', '/api/admin/settings', { token: admin.token, body: { settings: { judge_enabled: '1', judge_model: 'deepseek/deepseek-chat' } } });
    check('salvar judge_model → 200', r.status === 200, `got ${r.status}`);
    r = await api(baseA, 'GET', '/api/admin/settings', { token: admin.token });
    check('judge_model persistido', r.data?.judge_model === 'deepseek/deepseek-chat', `got ${r.data?.judge_model}`);
    check('judge_enabled persistido', r.data?.judge_enabled === '1', `got ${r.data?.judge_enabled}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  exceção na fase A: ${e.message}`);
  } finally {
    serverA.kill();
  }

  // Fase B: juiz reprova (MOCK_JUDGE_REJECT=1) → retry com feedback + entrega avisada
  console.log('\n  --- fase B: juiz reprova (retry com feedback) ---');
  const dbB = path.join(os.tmpdir(), `t25-b-${Date.now()}.sqlite`);
  const baseB = `http://localhost:${BASE_PORT + 1}`;
  const serverB = startServer(BASE_PORT + 1, dbB, { MOCK_JUDGE_REJECT: '1' });

  try {
    await waitReady(baseB);
    const admin = await login(baseB, 'admin@turboscribe.local', 'admin123');
    const tid = await seedTranscription(dbB, admin.user.id, RAW_TEXT);

    const r = await api(baseB, 'POST', `/api/transcriptions/${tid}/enhance`, { token: admin.token });
    check('enhance com juiz reprovador → 200 (entrega com aviso)', r.status === 200, `got ${r.status}`);
    check('judge.approved === false', r.data?.analysis?.judge?.approved === false, `got ${JSON.stringify(r.data?.analysis?.judge)}`);
    check('issues não vazias', (r.data?.analysis?.judge?.issues || []).length > 0);
    check('attempts === 2 (1 retry)', r.data?.analysis?.attempts === 2, `got ${r.data?.analysis?.attempts}`);
    const row = await readAnalysisRow(dbB, tid);
    check('persiste judge_approved=0', row?.judge_approved === 0, `got ${row?.judge_approved}`);
    check('persiste attempts=2', row?.attempts === 2, `got ${row?.attempts}`);
    check('persiste judge_feedback', !!row?.judge_feedback, `got ${row?.judge_feedback}`);

    const hist = await api(baseB, 'GET', `/api/transcriptions/${tid}/analyses`, { token: admin.token });
    check('histórico expõe judge_feedback', !!hist.data?.[0]?.judge_feedback);
  } catch (e) {
    failed++;
    console.log(`  FAIL  exceção na fase B: ${e.message}`);
  } finally {
    serverB.kill();
  }

  // Limpeza tolerante: o Windows segura o lock do arquivo por alguns
  // segundos após o kill do servidor — falhar aqui não invalida o teste.
  for (const f of [dbA, `${dbA}-wal`, `${dbA}-shm`, dbB, `${dbB}-wal`, `${dbB}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch (_) { /* lock do Windows; arquivo fica no TEMP */ }
  }

  console.log(`\n=======================================================`);
  console.log(`📊 T-25: ${passed} PASS / ${failed} FAIL`);
  console.log(`=======================================================\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
