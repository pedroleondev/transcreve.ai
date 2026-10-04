// Diagnóstico mobile: emula S24 (360x800), com modo Leitura persistido,
// clica no primeiro card e captura console + screenshot da tela de detalhes.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9337';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9337', '--user-data-dir=' + path.join(__dirname, '..', '.edge-mobile-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(__dirname, '..', 'docs', 'screenshots', name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_reading_mode', 'reading'); localStorage.setItem('transcreveai_theme', 'light'); location.reload(); 'ok'`);
  await sleep(4000);

  const cards = await evalJs(`document.querySelectorAll('.transcription-card').length`);
  console.log('cards visíveis:', cards);
  await shot('diag-mobile-dashboard.png');

  await evalJs(`(() => { const c = document.querySelector('.transcription-card [onclick^="openTranscriptionDetail"]'); if (c) c.click(); return 'ok'; })()`);
  await sleep(3000);
  const state = await evalJs(`(() => ({
    detalhesVisivel: !document.getElementById('view-details').classList.contains('hidden'),
    nome: (document.getElementById('detail-filename-text') || {}).innerText,
    ccWords: document.querySelectorAll('.cc-word').length,
    bodyHtmlLen: (document.getElementById('transcript-content') || { innerHTML: '' }).innerHTML.length,
    textoVisivel: ((document.getElementById('transcript-content') || {}).innerText || '').slice(0, 60)
  }))()`);
  console.log('estado detalhes:', JSON.stringify(state, null, 1));
  console.log('erros de console:', consoleErrors.length ? consoleErrors : 'nenhum');
  await shot('diag-mobile-detail.png');

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
