// Teste de aceite T-06 — Posição na fila visível (e concorrência via env).
// Zero custo de API: provedor mock (TRANSCRIBE_PROVIDER=mock), banco isolado
// (DB_PATH), WORKER_CONCURRENCY=1 + latência de 3s para manter jobs enfileirados.
//
// RODAR DENTRO DO CONTAINER (o pipeline precisa de ffmpeg, que só existe na
// imagem Linux; NODE_ENV=production do container é neutralizado para o
// servidor de teste spawnado):
//   docker exec -w /app transcreveai-app node tests/t06_queue_position.js
// Uso local (host com ffmpeg no PATH): node tests/t06_queue_position.js

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3');
const { v4: uuidv4 } = require('uuid');

const PORT = 3127;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function api(method, url, { token, body } = {}) {
  const res = await fetch(`${BASE}${url}`, {
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

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return;
    } catch (_) { /* ainda subindo */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}

// Insere jobs direto como 'pending' (sem upload/ffprobe): o worker mock
// vai processá-los um a vez (WORKER_CONCURRENCY=1, latência 3s cada).
// Os arquivos precisam existir em disco (o pré-processamento roda de verdade;
// só a chamada de transcrição é mockada) — copiamos o fixture sample.ogg.
const FIXTURE = path.join(__dirname, 'fixtures', 'sample.ogg');
const seededFiles = [];

function seedPending(dbPath, userId, n) {
  const db = new sqlite3.Database(dbPath);
  const ids = [];
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      for (let i = 0; i < n; i++) {
        const id = uuidv4();
        ids.push(id);
        const fileName = `t06-fila-${Date.now()}-${i + 1}.ogg`;
        const dest = path.join(ROOT, 'uploads', fileName);
        fs.copyFileSync(FIXTURE, dest);
        seededFiles.push(dest);
        db.run(
          `INSERT INTO transcriptions (id, user_id, file_name, file_path, raw_text, status, stage, duration_seconds, progress)
           VALUES (?, ?, ?, ?, ?, 'pending', 'transcribing', 60, 0)`,
          [id, userId, fileName, `/uploads/${fileName}`, 'texto base do job ' + (i + 1)]
        );
      }
    });
    db.run('SELECT 1', err => { db.close(); err ? reject(err) : resolve(ids); });
  });
}

(async () => {
  console.log('T-06 — Posição na fila visível (mock, custo zero)\n');

  const dbPath = path.join(os.tmpdir(), `t06-${Date.now()}.sqlite`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', // permite TRANSCRIBE_PROVIDER=mock mesmo dentro do container (production)
      PORT: String(PORT),
      DB_PATH: dbPath,
      TRANSCRIBE_PROVIDER: 'mock',
      MOCK_LATENCY_MS: '3000',
      WORKER_CONCURRENCY: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => process.stderr.write(`[server] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  try {
    await waitReady();

    const login = await api('POST', '/api/auth/login', { body: { email: 'admin@turboscribe.local', password: 'admin123' } });
    check('login admin OK', login.status === 200 && !!login.data?.token, `got ${login.status}`);
    const token = login.data.token;
    const adminId = login.data.user.id;

    // 3 jobs pendentes; com 1 slot e 3s de latência, no máximo 1 sai da fila.
    // O poll da fila roda a cada 5s (POLL_INTERVAL_MS): aguardamos o 1º tick
    // após o seed (800ms seria antes mesmo do primeiro poll).
    const ids = await seedPending(dbPath, adminId, 3);
    check('seed de 3 jobs pendentes OK', ids.length === 3);

    let claimed = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const probe = await api('GET', `/api/transcriptions/${ids[0]}/status`, { token });
      if (probe.data?.status === 'processing') { claimed = true; break; }
    }
    check('worker reclamou o 1º job após o poll', claimed);

    // /status expõe queue_position: job mais antigo PENDENTE é o 1º da fila
    const s0 = await api('GET', `/api/transcriptions/${ids[0]}/status`, { token });
    const s1 = await api('GET', `/api/transcriptions/${ids[1]}/status`, { token });
    const s2 = await api('GET', `/api/transcriptions/${ids[2]}/status`, { token });

    check('status job[0] → 200', s0.status === 200, `got ${s0.status}`);
    const st0 = s0.data?.status, st1 = s1.data?.status, st2 = s2.data?.status;
    check('exatamente 1 job em processing', [st0, st1, st2].filter(s => s === 'processing').length === 1,
      `status: ${st0},${st1},${st2}`);

    // O job em processing tem queue_position null; os pendentes têm 1º e 2º
    const pend1 = [s0, s1, s2].find(s => s.data?.status === 'pending' && s.data?.queue_position === 1);
    const pend2 = [s0, s1, s2].find(s => s.data?.status === 'pending' && s.data?.queue_position === 2);
    check('job pendente mais antigo = 1º na fila', !!pend1, `positions: ${s0.data?.queue_position},${s1.data?.queue_position},${s2.data?.queue_position}`);
    check('segundo pendente = 2º na fila', !!pend2);
    check('job em processing tem queue_position null', [s0, s1, s2].some(s => s.data?.status === 'processing' && s.data?.queue_position === null));

    // Lista também expõe queue_position (admin vê tudo com ?all=true)
    const list = await api('GET', '/api/transcriptions?all=true', { token });
    check('lista retorna queue_position', list.status === 200 && list.data.every(t => 'queue_position' in t));
    const pendentes = list.data.filter(t => t.status === 'pending');
    check('lista: 2 pendentes com posição 1 e 2',
      pendentes.length === 2 && pendentes.some(t => t.queue_position === 1) && pendentes.some(t => t.queue_position === 2),
      `pendentes: ${pendentes.map(t => t.queue_position).join(',')}`);

    // Isolamento: outro usuário NÃO vê queue_position dos alheios (nem os jobs)
    const user = await api('POST', '/api/auth/login', { body: { email: 'pedro.leon23@gmail.com', password: 'user123' } });
    const userList = await api('GET', '/api/transcriptions', { token: user.data?.token });
    check('usuário comum não enxerga os jobs alheios', userList.status === 200 && userList.data.length === 0,
      `got ${userList.data?.length}`);
    const foreign = await api('GET', `/api/transcriptions/${ids[0]}/status`, { token: user.data?.token });
    check('status de job alheio → 404 (escopo)', foreign.status === 404, `got ${foreign.status}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  exceção: ${e.message}`);
  } finally {
    server.kill();
  }

  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...seededFiles]) {
    try { fs.rmSync(f, { force: true }); } catch (_) { /* lock do Windows; arquivo fica no TEMP */ }
  }

  console.log(`\n=======================================================`);
  console.log(`📊 T-06: ${passed} PASS / ${failed} FAIL`);
  console.log(`=======================================================\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
