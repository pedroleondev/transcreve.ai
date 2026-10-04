// Diagnóstico: clique REAL no campo de busca (Input.dispatchMouseEvent) e digita —
// confere se o readonly é removido no foco e se a digitação funciona.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9341';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9341', '--user-data-dir=' + path.join(__dirname, '..', '.edge-type-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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

  const inicial = await evalJs(`(() => { const i = document.getElementById('search-input'); return { readonlyNoLoad: i.hasAttribute('readonly'), valor: i.value }; })()`);
  console.log('estado inicial:', JSON.stringify(inicial));

  // clique real no input
  const rect = await evalJs(`(() => { const r = document.getElementById('search-input').getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  await sleep(600);
  await send('Input.insertText', { text: 'gravidez' });
  await sleep(600);
  const depois = await evalJs(`(() => ({
    readonlyAposClique: document.getElementById('search-input').hasAttribute('readonly'),
    valorDigitado: document.getElementById('search-input').value,
    focado: document.activeElement === document.getElementById('search-input'),
    linhasVisiveis: Array.from(document.querySelectorAll('#transcriptions-tbody tr')).filter(r => r.style.display !== 'none').length
  }))()`);
  console.log('após clique e digitação:', JSON.stringify(depois, null, 1));

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
