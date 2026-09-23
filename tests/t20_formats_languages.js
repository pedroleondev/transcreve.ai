// Smoke test T-20 — provedor MOCK, banco isolado (DB_PATH), custo zero de API.
// Cobre: validação de idioma, language='auto' (detecção gravada), idioma fixo,
// upload de vídeo (extração -vn da trilha) e accept (front verificado à parte).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 't20-'));
const DB = path.join(TMP, 'test-t20.sqlite');
const SAMPLE = path.join(ROOT, 'tests', 'fixtures', 'sample.ogg');
const VIDEO = path.join(ROOT, 'tests', 'fixtures', 'clip-t20.mp4');

let passed = 0, failed = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { passed++; console.log(`  PASS ${msg}`); }
  else { failed++; console.log(`  FAIL ${msg}${detail ? `\n       ↳ ${detail}` : ''}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// vídeo de teste gerado dentro do container (ffmpeg só existe na imagem Docker):
//   docker exec transcreveai-app ffmpeg -y -f lavfi -i testsrc=duration=6:size=320x240:rate=10 \
//     -f lavfi -i sine=frequency=440:duration=6 -shortest -pix_fmt yuv420p //app/tests/fixtures/clip-t20.mp4
if (!fs.existsSync(VIDEO)) {
  console.error('Fixture de vídeo não encontrado: ' + VIDEO);
  process.exit(1);
}
console.log(`Fixture de vídeo: ${VIDEO} (${fs.statSync(VIDEO).size} bytes)`);

let server = null;
const EXTERNAL_SERVER = process.env.EXTERNAL_SERVER === '1'; // servidor mock já rodando em BASE (ex.: container efêmero)
async function startServer() {
  if (EXTERNAL_SERVER) {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${BASE}/api/settings`)).ok) return; } catch (_) {}
      await sleep(200);
    }
    throw new Error('Servidor externo não responde em ' + BASE);
  }
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TRANSCRIBE_PROVIDER: 'mock', MOCK_LATENCY_MS: '80' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  server.getLog = () => log;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/settings`)).ok) return; } catch (_) {}
    await sleep(200);
  }
  throw new Error('Servidor nao subiu:\n' + log);
}
async function stopServer() {
  if (!server || EXTERNAL_SERVER) return;
  const s = server; server = null;
  await new Promise(res => { s.on('exit', res); try { process.kill(s.pid, 'SIGKILL'); } catch (_) {} setTimeout(res, 3000); });
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: 'admin123' })
  });
  const data = await res.json();
  return data.token || data.data?.token;
}

async function upload(filePath, language, extraForm = {}) {
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  form.append('language', language);
  form.append('mode', 'pro');
  for (const [k, v] of Object.entries(extraForm)) form.append(k, v);
  const res = await fetch(`${BASE}/api/transcribe`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  return { status: res.status, data: await res.json() };
}

async function waitCompleted(id, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const res = await fetch(`${BASE}/api/transcriptions/${id}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const d = await res.json();
    const s = d.data?.status || d.status;
    if (s === 'completed' || s === 'completed_with_errors' || s === 'failed') return d.data || d;
    await sleep(1000);
  }
  return null;
}

async function getTranscription(id) {
  const res = await fetch(`${BASE}/api/transcriptions/${id}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const d = await res.json();
  return d.data || d;
}

let TOKEN;
(async () => {
  await startServer();
  try {
    console.log('\n[CENARIO 1] Idioma invalido rejeitado com 400 antes de enfileirar');
    TOKEN = await login();
    ok(!!TOKEN, 'login admin');
    const bad = await upload(SAMPLE, 'xx');
    ok(bad.status === 400, `language=xx → HTTP 400 (recebido ${bad.status})`);
    ok(/idioma inválido/i.test(bad.data.error || ''), `mensagem clara: "${bad.data.error}"`);

    console.log('\n[CENARIO 2] language=auto → Whisper "detecta" (mock=pt) e grava no job');
    const upAuto = await upload(SAMPLE, 'auto');
    if (!(([200,202].includes(upAuto.status)) && upAuto.data?.data?.[0]?.id)) console.log('       ↳ resposta:', upAuto.status, JSON.stringify(upAuto.data).slice(0, 400));
    ok(([200,202].includes(upAuto.status)) && upAuto.data?.data?.[0]?.id, 'upload auto aceito');
    const doneAuto = await waitCompleted(upAuto.data.data[0].id);
    ok(doneAuto && doneAuto.status === 'completed', `job completou (${doneAuto?.status})`);
    const tAuto = await getTranscription(upAuto.data.data[0].id);
    ok(tAuto.language === 'pt', `language gravado = 'pt' (detectado, era 'auto') — recebido '${tAuto.language}'`);
    ok((tAuto.raw_text || '').includes('[MOCK'), 'texto veio do mock (prefixo [MOCK)');

    console.log('\n[CENARIO 3] Idioma fixo ja → preservado no job');
    const upJa = await upload(SAMPLE, 'ja');
    ok(([200,202].includes(upJa.status)) && upJa.data?.data?.[0]?.id, 'upload ja aceito');
    await waitCompleted(upJa.data.data[0].id);
    const tJa = await getTranscription(upJa.data.data[0].id);
    ok(tJa.language === 'ja', `language gravado = 'ja' — recebido '${tJa.language}'`);

    console.log('\n[CENARIO 4] Vídeo MP4 → trilha de áudio extraída (-vn) e transcrito');
    const upVid = await upload(VIDEO, 'auto');
    ok(([200,202].includes(upVid.status)) && upVid.data?.data?.[0]?.id, 'upload de vídeo aceito (ffprobe achou áudio)');
    const doneVid = await waitCompleted(upVid.data.data[0].id);
    ok(doneVid && doneVid.status === 'completed', `job de vídeo completou (${doneVid?.status})`);
    const tVid = await getTranscription(upVid.data.data[0].id);
    ok(tVid.duration_seconds > 0, `duração detectada > 0 (${tVid.duration_seconds}s)`);

    console.log('\n[CENARIO 5] languages.js: lista servida e consistente');
    const langRes = await fetch(`${BASE}/languages.js`);
    const langText = await langRes.text();
    ok(langRes.ok && langText.includes('WHISPER_LANGUAGES'), '/languages.js servido');
    const L = require(path.join(ROOT, 'services', 'languages.js'));
    ok(L.LANGUAGES.length >= 98, `lista com ${L.LANGUAGES.length} idiomas (esperado >= 98)`);
    ok(L.isValidLanguage('pt') && L.isValidLanguage('yue') && !L.isValidLanguage('xx'), 'isValidLanguage valida corretamente');
    const top = L.listForSelect('');
    ok(top.slice(0, 4).map(l => l.code).join(',') === 'pt,en,es,ja', `fixados no topo: ${top.slice(0, 4).map(l => l.code).join(',')}`);
    ok(L.listForSelect('jap').some(l => l.code === 'ja'), 'busca "jap" acha japonês');
    ok(L.listForSelect('日本').some(l => l.code === 'ja'), 'busca nativa "日本" acha japonês');
  } catch (e) {
    failed++;
    console.error('ERRO no teste:', e.message);
    if (server?.getLog) console.error(server.getLog().split('\n').slice(-15).join('\n'));
  } finally {
    await stopServer();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n===== T-20 smoke: ${passed} PASS / ${failed} FAIL =====`);
  process.exit(failed ? 1 : 0);
})();
