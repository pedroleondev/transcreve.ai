/**
 * tests/load_multiuser.js
 * -----------------------------------------------------------------------------
 * Teste de prontidao multiusuario do TranscreveAI.
 *
 * Executa tres fases:
 *   A. SEGURANCA  - o bypass de autenticacao esta fechado?
 *   B. ISOLAMENTO - o usuario A consegue ver/apagar dados do usuario B?
 *   C. CAPACIDADE - N uploads simultaneos: quanto a fila aguenta? (custo real!)
 *
 * Uso:
 *   node tests/load_multiuser.js                  # todas as fases (GASTA CREDITO)
 *   node tests/load_multiuser.js --no-transcribe  # so A e B (custo zero)
 *   node tests/load_multiuser.js --users=5
 *   node tests/load_multiuser.js --cleanup        # remove os dados de teste e sai
 *
 * As fases A e B DEVEM falhar no estado atual do sistema (31/08/2026).
 * Isso e o resultado esperado ate T-01 e T-02 serem implementadas.
 * Ver docs/MULTIUSER.md.
 * -----------------------------------------------------------------------------
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = 'admin@turboscribe.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const args = process.argv.slice(2);
const NO_TRANSCRIBE = args.includes('--no-transcribe');
const CLEANUP_ONLY = args.includes('--cleanup');
const USER_COUNT = Number((args.find(a => a.startsWith('--users=')) || '--users=10').split('=')[1]);

const TEST_DOMAIN = 'loadtest.transcreveai.local';
const TEST_PASSWORD = 'LoadTest#2026!aA';
// Amostra de audio para a fase C: usa AUDIO_SAMPLE se definido, senao o
// arquivo base versionado em tests/fixtures/sample.ogg (voz sintetica, sem
// dado real de cliente), com fallback para o menor .ogg em uploads/ (que so
// existe em instalacoes que ja processaram audio real e nao e versionado).
function resolveSampleAudio() {
  if (process.env.AUDIO_SAMPLE) return process.env.AUDIO_SAMPLE;
  const fixture = path.join(__dirname, 'fixtures', 'sample.ogg');
  if (fs.existsSync(fixture)) return fixture;
  const dir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(dir)) return '';
  const candidates = fs.readdirSync(dir)
    .filter(f => /\.(ogg|m4a|mp3|wav)$/i.test(f))
    .map(f => ({ f: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => a.size - b.size);
  return candidates.length ? candidates[0].f : '';
}
const SAMPLE_AUDIO = resolveSampleAudio();

// ---------------------------------------------------------------------------
// Infra de assercao
// ---------------------------------------------------------------------------
const results = [];
let passed = 0;
let failed = 0;

function assert(phase, condition, message, detail = '') {
  results.push({ phase, ok: !!condition, message, detail });
  if (condition) {
    passed++;
    console.log(`  ✅ PASS  ${message}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL  ${message}${detail ? `\n           ↳ ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

async function api(method, route, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let payload;
  if (raw) {
    payload = raw;
    Object.assign(headers, raw.getHeaders());
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  const started = Date.now();
  const res = await fetch(`${BASE_URL}${route}`, { method, headers, body: payload });
  const ms = Date.now() - started;

  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data, ms };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Provisionamento (idempotente)
// ---------------------------------------------------------------------------
async function loginAdmin() {
  const r = await api('POST', '/api/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }
  });
  if (r.status !== 200 || !r.data.token) {
    throw new Error(`Nao foi possivel autenticar o admin (${r.status}): ${JSON.stringify(r.data)}`);
  }
  return r.data.token;
}

async function provisionUsers(adminToken) {
  const existing = await api('GET', '/api/admin/users', { token: adminToken });
  const byEmail = new Map((Array.isArray(existing.data) ? existing.data : []).map(u => [u.email, u]));

  const users = [];
  for (let i = 1; i <= USER_COUNT; i++) {
    const idx = String(i).padStart(2, '0');
    const email = `loadtest${idx}@${TEST_DOMAIN}`;

    if (!byEmail.has(email)) {
      const created = await api('POST', '/api/admin/users', {
        token: adminToken,
        body: { name: `Load Test ${idx}`, email, password: TEST_PASSWORD, role: 'user', daily_limit: 50 }
      });
      if (created.status !== 200) {
        throw new Error(`Falha ao criar ${email}: ${JSON.stringify(created.data)}`);
      }
    }

    const login = await api('POST', '/api/auth/login', {
      body: { email, password: TEST_PASSWORD }
    });
    if (login.status !== 200 || !login.data.token) {
      throw new Error(`Falha no login de ${email}: ${JSON.stringify(login.data)}`);
    }
    users.push({ idx, email, token: login.data.token, id: login.data.user.id });
  }
  console.log(`\n⚙️  ${users.length} usuarios de teste provisionados e autenticados.`);
  return users;
}

// ---------------------------------------------------------------------------
// FASE A - Seguranca
// ---------------------------------------------------------------------------
async function phaseSecurity(users) {
  section('FASE A — SEGURANCA DA AUTENTICACAO');

  const noToken = await api('GET', '/api/transcriptions');
  assert('A', noToken.status === 401,
    'GET /api/transcriptions sem token deve retornar 401',
    `retornou ${noToken.status}${Array.isArray(noToken.data) ? ` com ${noToken.data.length} registros expostos` : ''}`);

  const adminNoToken = await api('GET', '/api/admin/users');
  assert('A', adminNoToken.status === 401,
    'GET /api/admin/users sem token deve retornar 401',
    `retornou ${adminNoToken.status} — rota administrativa aberta`);

  const badPass = await api('POST', '/api/auth/login', {
    body: { email: users[0].email, password: 'user123' }
  });
  assert('A', badPass.status === 401,
    'Login com a senha mestra "user123" deve retornar 401',
    `retornou ${badPass.status}${badPass.data && badPass.data.token ? ' e emitiu um token valido' : ''}`);

  const badPass2 = await api('POST', '/api/auth/login', {
    body: { email: users[0].email, password: 'admin123' }
  });
  assert('A', badPass2.status === 401,
    'Login com a senha mestra "admin123" deve retornar 401',
    `retornou ${badPass2.status}`);

  const escalate = await api('GET', '/api/admin/users', { token: users[0].token });
  assert('A', escalate.status === 403,
    'Usuario comum acessando /api/admin/users deve retornar 403',
    `retornou ${escalate.status}`);

  const forged = await api('GET', '/api/transcriptions', { token: 'token.invalido.aqui' });
  assert('A', forged.status === 403 || forged.status === 401,
    'Token invalido deve ser rejeitado',
    `retornou ${forged.status}`);
}

// ---------------------------------------------------------------------------
// FASE B - Isolamento entre usuarios
// ---------------------------------------------------------------------------
async function phaseIsolation(users) {
  section('FASE B — ISOLAMENTO DE DADOS ENTRE USUARIOS');

  // Cada usuario cria um projeto proprio
  const projects = [];
  for (const u of users) {
    const r = await api('POST', '/api/projects', {
      token: u.token,
      body: { name: `Projeto Privado ${u.idx}` }
    });
    if (r.status === 200 && r.data.id) projects.push({ owner: u, id: r.data.id, name: r.data.name });
  }
  assert('B', projects.length === users.length,
    `Cada um dos ${users.length} usuarios conseguiu criar seu projeto`,
    `criados: ${projects.length}`);

  // Usuario 1 lista projetos: deve ver apenas o seu
  const list = await api('GET', '/api/projects', { token: users[0].token });
  const visible = Array.isArray(list.data) ? list.data : [];
  const foreign = visible.filter(p => /^Projeto Privado /.test(p.name) && p.name !== `Projeto Privado ${users[0].idx}`);
  assert('B', foreign.length === 0,
    'Usuario 01 nao deve enxergar projetos dos outros usuarios',
    `enxergou ${foreign.length} projetos alheios (total visivel: ${visible.length})`);

  // Usuario 2 tenta apagar o projeto do usuario 1
  const victim = projects.find(p => p.owner.idx === users[0].idx);
  if (victim) {
    const del = await api('DELETE', `/api/projects/${victim.id}`, { token: users[1].token });
    const stillThere = await api('GET', '/api/projects', { token: users[0].token });
    const survived = (Array.isArray(stillThere.data) ? stillThere.data : []).some(p => p.id === victim.id);
    assert('B', survived,
      'Usuario 02 nao deve conseguir apagar o projeto do usuario 01',
      `DELETE retornou ${del.status} e o projeto ${survived ? 'sobreviveu' : 'FOI APAGADO'}`);
  }

  // Transcricoes: o usuario 1 nao deve ver as dos outros
  const trans = await api('GET', '/api/transcriptions', { token: users[0].token });
  const rows = Array.isArray(trans.data) ? trans.data : [];
  const alheias = rows.filter(t => t.user_id && t.user_id !== users[0].id);
  assert('B', alheias.length === 0,
    'Usuario 01 nao deve enxergar transcricoes de outros donos',
    `enxergou ${alheias.length} de ${rows.length} registros pertencentes a outros user_id`);

  // Uploads devem exigir autenticacao
  if (rows.length > 0 && rows[0].file_path) {
    const pub = await fetch(`${BASE_URL}${rows[0].file_path}`);
    assert('B', pub.status === 401 || pub.status === 403 || pub.status === 404,
      'Arquivo em /uploads nao deve ser servido publicamente sem autenticacao',
      `GET ${rows[0].file_path} retornou ${pub.status}`);
  }

  return projects;
}

// ---------------------------------------------------------------------------
// FASE C - Capacidade sob carga
// ---------------------------------------------------------------------------
async function phaseCapacity(users) {
  section('FASE C — CAPACIDADE COM UPLOADS SIMULTANEOS');

  if (!fs.existsSync(SAMPLE_AUDIO)) {
    console.log(`  ⚠️  Audio de amostra nao encontrado: ${SAMPLE_AUDIO}`);
    console.log('     Fase C ignorada. Coloque um .ogg curto nesse caminho para medir capacidade.');
    return;
  }

  const sizeMb = (fs.statSync(SAMPLE_AUDIO).size / 1024 / 1024).toFixed(2);
  console.log(`  Audio: ${path.basename(SAMPLE_AUDIO)} (${sizeMb} MB) × ${users.length} usuarios simultaneos`);
  console.log('  ⚠️  Esta fase consome credito real da OpenRouter.\n');

  const t0 = Date.now();
  const uploads = await Promise.all(users.map(async u => {
    const form = new FormData();
    form.append('files', fs.createReadStream(SAMPLE_AUDIO), `carga-${u.idx}.ogg`);
    form.append('language', 'pt');
    form.append('mode', 'golfinho');
    const r = await api('POST', '/api/transcribe', { token: u.token, raw: form });
    return { user: u, status: r.status, ms: r.ms, id: r.data && r.data.data && r.data.data[0] && r.data.data[0].id };
  }));
  const uploadWall = Date.now() - t0;

  const accepted = uploads.filter(u => u.status === 202 && u.id);
  const latencies = uploads.map(u => u.ms);

  assert('C', accepted.length === users.length,
    `Todos os ${users.length} uploads simultaneos aceitos com 202`,
    `aceitos: ${accepted.length}; status vistos: ${[...new Set(uploads.map(u => u.status))].join(', ')}`);

  console.log(`\n  Latencia de aceite (ate o 202):`);
  console.log(`    p50 ${percentile(latencies, 50)} ms | p95 ${percentile(latencies, 95)} ms | max ${Math.max(...latencies)} ms`);
  console.log(`    tempo total para enfileirar os ${users.length}: ${uploadWall} ms`);

  // Acompanha a fila ate todos terminarem
  console.log('\n  Aguardando o worker esvaziar a fila (timeout 20 min)...');
  const pending = new Map(accepted.map(a => [a.id, { user: a.user, started: t0, doneAt: null, status: 'pending' }]));
  const TIMEOUT_MS = 20 * 60 * 1000;
  let lastReport = 0;

  while ([...pending.values()].some(p => !p.doneAt) && Date.now() - t0 < TIMEOUT_MS) {
    await sleep(5000);
    for (const [id, entry] of pending) {
      if (entry.doneAt) continue;
      const r = await api('GET', `/api/transcriptions/${id}/status`, { token: entry.user.token });
      const st = r.data && r.data.status;
      if (st === 'completed' || st === 'failed') {
        entry.doneAt = Date.now();
        entry.status = st;
        console.log(`    [${((entry.doneAt - t0) / 1000).toFixed(0)}s] ${entry.user.email} → ${st}`);
      }
    }
    const done = [...pending.values()].filter(p => p.doneAt).length;
    if (Date.now() - lastReport > 30000) {
      console.log(`    ... ${done}/${pending.size} concluidos`);
      lastReport = Date.now();
    }
  }

  const finished = [...pending.values()].filter(p => p.doneAt);
  const completed = finished.filter(p => p.status === 'completed');
  const times = finished.map(p => (p.doneAt - p.started) / 1000);

  assert('C', finished.length === pending.size,
    'Todos os jobs sairam da fila antes do timeout',
    `${finished.length}/${pending.size} concluidos em 20 min`);

  assert('C', completed.length === pending.size,
    'Nenhum job terminou com status failed',
    `completed: ${completed.length}, failed: ${finished.length - completed.length}`);

  if (times.length) {
    console.log(`\n  Tempo fim-a-fim (upload → status final):`);
    console.log(`    primeiro ${Math.min(...times).toFixed(0)}s | mediana ${percentile(times, 50).toFixed(0)}s | ultimo ${Math.max(...times).toFixed(0)}s`);
    console.log(`    ↳ A diferenca entre o primeiro e o ultimo e o custo da fila serial (docs/MULTIUSER.md B-04).`);
  }
}

// ---------------------------------------------------------------------------
// Limpeza
// ---------------------------------------------------------------------------
async function cleanup(adminToken) {
  section('LIMPEZA DOS DADOS DE TESTE');
  const all = await api('GET', '/api/admin/users', { token: adminToken });
  const testUsers = (Array.isArray(all.data) ? all.data : []).filter(u => u.email.endsWith(`@${TEST_DOMAIN}`));

  for (const u of testUsers) {
    await api('PUT', `/api/admin/users/${u.id}`, { token: adminToken, body: { status: 'suspended' } });
  }
  console.log(`  ${testUsers.length} usuarios de teste suspensos.`);
  console.log('  Observacao: nao existe DELETE de usuario na API. Para remover de vez:');
  console.log(`    sqlite3 turboscribe.sqlite "DELETE FROM users WHERE email LIKE '%@${TEST_DOMAIN}';"`);
}

// ---------------------------------------------------------------------------
// Relatorio
// ---------------------------------------------------------------------------
function report() {
  section('RELATORIO FINAL');
  for (const phase of ['A', 'B', 'C']) {
    const rows = results.filter(r => r.phase === phase);
    if (!rows.length) continue;
    const ok = rows.filter(r => r.ok).length;
    const label = { A: 'Seguranca', B: 'Isolamento', C: 'Capacidade' }[phase];
    console.log(`  Fase ${phase} (${label}): ${ok}/${rows.length} aprovadas`);
  }
  console.log(`\n  TOTAL: ${passed} PASS / ${failed} FAIL`);

  if (failed > 0) {
    console.log('\n  Falhas:');
    results.filter(r => !r.ok).forEach(r => console.log(`    • [${r.phase}] ${r.message}\n      ${r.detail}`));
    console.log('\n  Se as falhas forem de Fase A/B, o sistema ainda NAO esta pronto para multiplos');
    console.log('  usuarios. Ver docs/MULTIUSER.md e executar T-01 e T-02 de docs/TASKS.md.');
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('\n🧪 TESTE DE PRONTIDAO MULTIUSUARIO — TranscreveAI');
  console.log(`   Alvo: ${BASE_URL} | Usuarios: ${USER_COUNT} | Fase C: ${NO_TRANSCRIBE ? 'desativada' : 'ATIVA (gasta credito)'}`);

  const adminToken = await loginAdmin();

  if (CLEANUP_ONLY) {
    await cleanup(adminToken);
    return;
  }

  const users = await provisionUsers(adminToken);

  await phaseSecurity(users);
  await phaseIsolation(users);
  if (!NO_TRANSCRIBE) await phaseCapacity(users);

  report();
}

main().catch(err => {
  console.error('\n💥 Erro fatal na execucao do teste:', err.message);
  process.exitCode = 1;
});
