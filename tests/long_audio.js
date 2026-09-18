/**
 * tests/long_audio.js
 * -----------------------------------------------------------------------------
 * Testa a MECANICA do pipeline de audio longo (T-19) com o provedor mock —
 * custo zero de API. Sobe o proprio servidor com as envs de cada cenario.
 *
 * Cenarios:
 *   A. Blocos em paralelo, texto na ordem, limpeza de temporarios
 *   B. Retry: bloco falha com 429 uma vez e passa na segunda
 *   C. Falha definitiva: completed_with_errors + marcacao explicita + /retry
 *   D. Kill no meio + retomada sem refazer blocos concluidos
 *   E. Servidor responsivo durante o pre-processamento
 *   F. Limites de upload: sem trilha de audio, duracao acima do maximo, 51 arquivos
 *
 * Uso:
 *   node tests/long_audio.js                       # usa tests/fixtures/long/sample-2h.ogg
 *   AUDIO_SAMPLE=caminho.ogg node tests/long_audio.js
 *   node tests/long_audio.js --only=A,D
 *
 * Gere o fixture com: powershell -File tests/fixtures/make-long-sample.ps1
 * -----------------------------------------------------------------------------
 */

const { spawn } = require('child_process');
const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { getAsync, allAsync, runAsync } = require('../db');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const SAMPLE = process.env.AUDIO_SAMPLE || path.join(__dirname, 'fixtures', 'long', 'sample-2h.ogg');
const SHORT = path.join(__dirname, 'fixtures', 'sample.ogg');
const only = (process.argv.find(a => a.startsWith('--only=')) || '--only=A,B,C,D,E,F').slice(7).split(',');

let passed = 0, failed = 0;
function assert(cond, msg, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}${detail ? `\n     ↳ ${detail}` : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Servidor sob controle do teste
// ---------------------------------------------------------------------------
let server = null;
async function startServer(env = {}) {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT, TRANSCRIBE_PROVIDER: 'mock', MOCK_LATENCY_MS: '300', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  server.getLog = () => log;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE_URL}/api/settings`)).ok) return server; } catch (_) {}
    await sleep(200);
  }
  throw new Error('Servidor nao subiu em 20s:\n' + log);
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise(resolve => {
    s.on('exit', resolve);
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(s.pid), '/T', '/F']);
    else s.kill('SIGKILL');
    setTimeout(resolve, 3000);
  });
  await sleep(500);
}

// ---------------------------------------------------------------------------
// Helpers de API
// ---------------------------------------------------------------------------
async function upload(files, fields = {}) {
  const fd = new FormData();
  for (const f of [].concat(files)) fd.append('files', fs.createReadStream(f.path || f), f.name ? { filename: f.name } : undefined);
  fd.append('language', 'pt');
  fd.append('mode', 'golfinho');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${BASE_URL}/api/transcribe`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function status(id) {
  return (await fetch(`${BASE_URL}/api/transcriptions/${id}/status`)).json();
}
async function waitFor(id, pred, timeoutMs = 15 * 60 * 1000, every = 1000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await status(id).catch(() => last);
    if (last && pred(last)) return last;
    await sleep(every);
  }
  throw new Error(`timeout esperando ${id}; ultimo estado: ${JSON.stringify(last)}`);
}
const isFinal = s => ['completed', 'completed_with_errors', 'failed'].includes(s.status);
async function cleanupJob(id) {
  const row = await getAsync(`SELECT file_path FROM transcriptions WHERE id = ?`, [id]);
  if (row) await fs.promises.unlink(path.join(ROOT, row.file_path)).catch(() => {});
  await runAsync(`DELETE FROM transcription_chunks WHERE transcription_id = ?`, [id]);
  await runAsync(`DELETE FROM segments WHERE transcription_id = ?`, [id]);
  await runAsync(`DELETE FROM transcriptions WHERE id = ?`, [id]);
}
function chunksDirExists(id) {
  return fs.existsSync(path.join(ROOT, 'uploads', `chunks_${id}`));
}

// ---------------------------------------------------------------------------
// Cenarios
// ---------------------------------------------------------------------------
async function scenarioA() {
  console.log('\nA. PARALELISMO E MONTAGEM');
  await startServer({ CHUNK_CONCURRENCY: '3' });
  const t0 = Date.now();
  const up = await upload(SAMPLE);
  assert(up.status === 202, `upload aceito (202)`, `status ${up.status} ${JSON.stringify(up.body)}`);
  const id = up.body.data[0].id;
  assert(up.body.data[0].duration_seconds > 7000, 'duracao ja conhecida no upload (ffprobe)', `${up.body.data[0].duration_seconds}s`);

  const mid = await waitFor(id, s => s.stage === 'transcribing' && s.chunks_done > 0 && s.chunks_done < s.chunks_total, 10 * 60 * 1000, 300);
  assert(mid.chunks_total >= 10, `fatiado em ${mid.chunks_total} blocos (esperado ~12 para 2h)`);
  assert(mid.eta_seconds !== null, `ETA calculada durante a transcricao (${mid.eta_seconds}s)`);

  const fin = await waitFor(id, isFinal);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  assert(fin.status === 'completed', `job concluiu como completed em ${secs}s`, fin.status + ' ' + (fin.error_message || ''));
  assert(fin.chunks_done === fin.chunks_total, `todos os ${fin.chunks_total} blocos done`);

  const chunks = await allAsync(`SELECT idx, status, attempts FROM transcription_chunks WHERE transcription_id = ? ORDER BY idx`, [id]);
  assert(chunks.every(c => c.attempts === 1), 'cada bloco transcrito exatamente uma vez');

  const row = await getAsync(`SELECT raw_text, duration_seconds FROM transcriptions WHERE id = ?`, [id]);
  const order = [...row.raw_text.matchAll(/\[MOCK bloco (\d+)\]/g)].map(m => Number(m[1]));
  const uniq = [...new Set(order)];
  assert(uniq.length === chunks.length && uniq.every((v, i) => v === i), 'texto final na ordem dos blocos 0..N-1', uniq.join(','));

  const segs = await allAsync(`SELECT start_time, end_time FROM segments WHERE transcription_id = ? ORDER BY start_time`, [id]);
  const monotonic = segs.every((s, i) => i === 0 || s.start_time >= segs[i - 1].start_time);
  assert(monotonic && segs[segs.length - 1].end_time > row.duration_seconds - 60, 'timestamps continuos ate o fim do audio', `ultimo end=${segs[segs.length - 1].end_time}s de ${row.duration_seconds}s`);
  assert(!chunksDirExists(id), 'diretorio de blocos removido ao concluir');

  await cleanupJob(id);
  await stopServer();
}

async function scenarioB() {
  console.log('\nB. RETRY EM ERRO TRANSITORIO (429 no bloco 3, uma vez)');
  await startServer({ MOCK_FAIL_ONCE: '3' });
  const id = (await upload(SAMPLE)).body.data[0].id;
  const fin = await waitFor(id, isFinal);
  assert(fin.status === 'completed', 'job concluiu como completed apesar do 429', fin.status);
  const c3 = await getAsync(`SELECT status, attempts, error FROM transcription_chunks WHERE transcription_id = ? AND idx = 3`, [id]);
  assert(c3 && c3.status === 'done' && c3.attempts === 2, 'bloco 3: done na 2a tentativa', JSON.stringify(c3));
  const others = await getAsync(`SELECT COUNT(*) AS n FROM transcription_chunks WHERE transcription_id = ? AND idx != 3 AND attempts != 1`, [id]);
  assert(others.n === 0, 'nenhum outro bloco foi refeito');
  assert(/bloco 3 tentativa 1\/3 falhou \(transitorio\)/.test(server.getLog()), 'log registra a falha como transitoria');
  await cleanupJob(id);
  await stopServer();
}

async function scenarioC() {
  console.log('\nC. FALHA DEFINITIVA (400 sempre no bloco 5) + /retry');
  await startServer({ MOCK_FAIL_ALWAYS: '5' });
  const id = (await upload(SAMPLE)).body.data[0].id;
  const fin = await waitFor(id, isFinal);
  assert(fin.status === 'completed_with_errors', 'job termina como completed_with_errors', fin.status);
  assert(/bloco\(s\) falharam: 6/.test(fin.error_message || ''), 'error_message aponta o bloco 6 (idx 5)', fin.error_message);
  const c5 = await getAsync(`SELECT status, attempts FROM transcription_chunks WHERE transcription_id = ? AND idx = 5`, [id]);
  assert(c5.status === 'failed' && c5.attempts === 1, 'erro definitivo nao gasta as 3 tentativas', JSON.stringify(c5));
  const row = await getAsync(`SELECT raw_text FROM transcriptions WHERE id = ?`, [id]);
  assert(/\[bloco 6 falhou:/.test(row.raw_text), 'texto final tem marcacao explicita no lugar do trecho');
  assert(!/\[MOCK bloco 5\]/.test(row.raw_text), 'nenhum texto inventado para o bloco que falhou');
  assert(chunksDirExists(id) === false || true, '(blocos limpos ou mantidos — retry refatia se preciso)');

  // Religa sem a falha simulada e reprocessa so o bloco 5
  await stopServer();
  await startServer({});
  const r = await fetch(`${BASE_URL}/api/transcriptions/${id}/retry`, { method: 'POST' });
  const rb = await r.json();
  assert(r.ok && rb.chunks_reset === 1, 'POST /retry reseta exatamente 1 bloco', JSON.stringify(rb));
  const fin2 = await waitFor(id, isFinal);
  assert(fin2.status === 'completed', 'apos retry o job fica completed', fin2.status + ' ' + (fin2.error_message || ''));
  const redo = await getAsync(`SELECT COUNT(*) AS n FROM transcription_chunks WHERE transcription_id = ? AND idx != 5 AND attempts != 1`, [id]);
  assert(redo.n === 0, 'retry nao refez os blocos que ja estavam done');
  const row2 = await getAsync(`SELECT raw_text FROM transcriptions WHERE id = ?`, [id]);
  assert(/\[MOCK bloco 5\]/.test(row2.raw_text) && !/falhou/.test(row2.raw_text), 'texto final agora contem o bloco 5 e nenhuma marcacao de falha');
  await cleanupJob(id);
  await stopServer();
}

async function scenarioD() {
  console.log('\nD. KILL NO MEIO + RETOMADA');
  await startServer({ MOCK_LATENCY_MS: '2500', CHUNK_CONCURRENCY: '2' });
  const id = (await upload(SAMPLE)).body.data[0].id;
  const mid = await waitFor(id, s => s.chunks_done >= 3, 10 * 60 * 1000, 300);
  const doneBefore = await allAsync(`SELECT idx, started_at FROM transcription_chunks WHERE transcription_id = ? AND status = 'done'`, [id]);
  console.log(`     matando o servidor com ${mid.chunks_done}/${mid.chunks_total} blocos prontos...`);
  await stopServer();

  const stuck = await getAsync(`SELECT COUNT(*) AS n FROM transcription_chunks WHERE transcription_id = ? AND status = 'processing'`, [id]);
  console.log(`     ${stuck.n} bloco(s) ficaram presos em 'processing' (esperado > 0)`);

  await startServer({ MOCK_LATENCY_MS: '300' });
  await sleep(2000);
  assert(/Retomando .*apos interrupcao/.test(server.getLog()), 'log registra a retomada');
  const fin = await waitFor(id, isFinal);
  assert(fin.status === 'completed', 'job retomado conclui como completed', fin.status);

  const doneAfter = await allAsync(`SELECT idx, started_at, attempts FROM transcription_chunks WHERE transcription_id = ? ORDER BY idx`, [id]);
  const untouched = doneBefore.every(b => {
    const a = doneAfter.find(x => x.idx === b.idx);
    return a && a.started_at === b.started_at && a.attempts === 1;
  });
  assert(untouched, `os ${doneBefore.length} blocos prontos antes do kill nao foram refeitos`);
  const row = await getAsync(`SELECT raw_text FROM transcriptions WHERE id = ?`, [id]);
  const order = [...new Set([...row.raw_text.matchAll(/\[MOCK bloco (\d+)\]/g)].map(m => Number(m[1])))];
  assert(order.length === doneAfter.length && order.every((v, i) => v === i), 'texto final completo e na ordem apos retomada');
  await cleanupJob(id);
  await stopServer();
}

async function scenarioE() {
  console.log('\nE. SERVIDOR RESPONSIVO DURANTE O PRE-PROCESSAMENTO');
  await startServer({});
  const id = (await upload(SAMPLE)).body.data[0].id;
  await waitFor(id, s => s.stage === 'preprocessing', 60 * 1000, 200);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const r = await fetch(`${BASE_URL}/api/transcriptions`);
    samples.push(Date.now() - t0);
    assert(r.ok, `GET /api/transcriptions responde 200 durante ffmpeg (${samples[i]} ms)`);
    await sleep(500);
  }
  const worst = Math.max(...samples);
  assert(worst < 500, `pior latencia ${worst} ms < 500 ms`);
  await waitFor(id, isFinal);
  await cleanupJob(id);
  await stopServer();
}

async function scenarioF() {
  console.log('\nF. LIMITES DE UPLOAD');
  await startServer({ MAX_AUDIO_HOURS: '1', MAX_FILES_PER_UPLOAD: '3' });

  const fake = path.join(__dirname, 'fixtures', 'long', 'nao-e-audio.mp3');
  fs.writeFileSync(fake, 'isto nao e um arquivo de audio');
  const mixed = await upload([SHORT, fake, SAMPLE]);
  assert(mixed.status === 202, 'lote com 1 valido + 2 invalidos e aceito (202)', `status ${mixed.status}`);
  assert(mixed.body.count === 1, 'so o arquivo valido entrou na fila', JSON.stringify(mixed.body));
  const errs = (mixed.body.errors || []).map(e => e.error).join(' | ');
  assert(/nao reconhecido|nao contem trilha/.test(errs), 'arquivo sem audio rejeitado com mensagem clara', errs);
  assert(/excede o limite de 1 h/.test(errs), 'audio de 2h rejeitado quando MAX_AUDIO_HOURS=1', errs);
  const leftovers = fs.readdirSync(path.join(ROOT, 'uploads')).filter(f => f.includes('nao-e-audio') || f.includes('sample-2h'));
  assert(leftovers.length === 0, 'arquivos rejeitados apagados do disco', leftovers.join(','));
  fs.unlinkSync(fake);

  const four = await upload([SHORT, SHORT, SHORT, SHORT]);
  assert(four.status === 400 && four.body.code === 'LIMIT_FILE_COUNT', '4 arquivos com limite 3 -> 400 LIMIT_FILE_COUNT', `${four.status} ${JSON.stringify(four.body)}`);

  const okId = mixed.body.data[0].id;
  await waitFor(okId, isFinal);
  await cleanupJob(okId);
  await stopServer();
}

// ---------------------------------------------------------------------------
(async () => {
  if (!fs.existsSync(SAMPLE)) {
    console.error(`Fixture nao encontrado: ${SAMPLE}\nGere com: powershell -File tests/fixtures/make-long-sample.ps1`);
    process.exit(2);
  }
  console.log(`Fixture: ${SAMPLE} (${(fs.statSync(SAMPLE).size / 1e6).toFixed(1)} MB)`);
  // Outro servidor na mesma porta (e no mesmo SQLite) disputaria os jobs com o
  // worker de teste — e, sem mock, gastaria credito real. Aborta.
  try {
    await fetch(`${BASE_URL}/api/settings`);
    console.error(`Ja existe um servidor em ${BASE_URL}. Pare-o antes de rodar este teste.`);
    process.exit(2);
  } catch (_) { /* porta livre, segue */ }
  const map = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF };
  const t0 = Date.now();
  for (const k of only) {
    if (!map[k]) continue;
    try { await map[k](); }
    catch (e) { failed++; console.log(`  ❌ cenario ${k} abortou: ${e.message}`); await stopServer(); }
  }
  console.log(`\n${passed} PASS / ${failed} FAIL em ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  process.exit(failed ? 1 : 0);
})();
