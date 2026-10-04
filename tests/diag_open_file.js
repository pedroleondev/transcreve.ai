// Diagnóstico: abre o app como admin, clica no primeiro arquivo da lista e
// captura erros de console + estado da tela de detalhes.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9336';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error('login falhou');

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9336', '--user-data-dir=' + path.join(__dirname, '..', '.edge-open-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => a.value || a.description || '').join(' '));
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'ERRO-JS: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
  await sleep(4000);

  // clica no primeiro link de arquivo da tabela
  const clickRes = await evalJs(`(() => {
    const row = document.querySelector('#transcriptions-tbody tr');
    if (!row) return 'SEM LINHAS';
    const btn = row.querySelector('[onclick^="openTranscriptionDetail"]') || row;
    btn.click();
    return 'clicado';
  })()`);
  console.log('clique:', clickRes);
  await sleep(3000);

  const state = await evalJs(`(() => ({
    viewDetalhesVisivel: !document.getElementById('view-details').classList.contains('hidden'),
    nome: (document.getElementById('detail-filename-text') || {}).innerText,
    meta: (document.getElementById('detail-meta') || {}).innerText,
    blocos: document.querySelectorAll('.speech-block').length,
    paragrafos: document.querySelectorAll('.cc-para').length,
    audioSrc: ((document.getElementById('audio-player') || {}).src || '').slice(0, 80),
    audioPronto: (() => { const a = document.getElementById('audio-player'); return a ? a.readyState : 'sem-audio'; })()
  }))()`);
  console.log('estado da tela:', JSON.stringify(state, null, 1));
  console.log('erros de console:', consoleErrors.length ? consoleErrors : 'nenhum');

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
