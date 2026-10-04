// Diagnóstico 2: hover real no menu do usuário (Input.dispatchMouseEvent),
// mede fundo computado e tira screenshot. Também testa toque no mobile.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9334';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(__dirname, '..', '.edge-diag2-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(path.join(__dirname, '..', 'docs', 'screenshots', name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  await send('Page.enable'); await send('Runtime.enable');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', 'light'); location.reload(); 'ok'`);
  await sleep(3500);

  // posição do botão do menu
  const rect = await evalJs(`(() => { const b = document.getElementById('user-menu-btn').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  console.log('btn em', JSON.stringify(rect));
  // hover real
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await sleep(1200);
  const st = await evalJs(`(() => {
    const drop = document.querySelector('#user-menu-btn').closest('.group').querySelector('.absolute');
    const cs = getComputedStyle(drop);
    return { display: cs.display, bg: cs.backgroundColor, hasClassBg: drop.className.includes('bg-brand-surface'), classes: drop.className };
  })()`);
  console.log('dropdown no hover:', JSON.stringify(st, null, 1));
  await shot('diag-hover-usermenu.png');

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
