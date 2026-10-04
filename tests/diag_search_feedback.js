// Diagnóstico: busca sem resultados tem que mostrar feedback (não tabela em branco)
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9339';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9339', '--user-data-dir=' + path.join(__dirname, '..', '.edge-search-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
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

  const res1 = await evalJs(`(() => {
    const input = document.getElementById('search-input');
    input.value = 'xyznaoexiste';
    handleSearch();
    const nr = document.getElementById('search-no-results');
    const rowsVisiveis = Array.from(document.querySelectorAll('#transcriptions-tbody tr')).filter(r => r.style.display !== 'none').length;
    return {
      autocomplete: input.getAttribute('autocomplete'),
      feedbackVisivel: nr && !nr.classList.contains('hidden'),
      textoFeedback: (document.getElementById('search-no-results-text') || {}).innerText,
      rowsVisiveis
    };
  })()`);
  console.log('busca sem resultado:', JSON.stringify(res1));

  const res2 = await evalJs(`(() => {
    const input = document.getElementById('search-input');
    input.value = 'gravidez';
    handleSearch();
    const nr = document.getElementById('search-no-results');
    const rowsVisiveis = Array.from(document.querySelectorAll('#transcriptions-tbody tr')).filter(r => r.style.display !== 'none').length;
    return { feedbackVisivel: nr && !nr.classList.contains('hidden'), rowsVisiveis };
  })()`);
  console.log('busca com resultado:', JSON.stringify(res2));

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
