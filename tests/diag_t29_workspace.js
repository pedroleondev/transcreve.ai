// T-29 F3 — validação do workspace/lista: métricas, sidebar colapsável,
// mini-player persistente e empilhamento mobile. Desktop 1440 + mobile 360.
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9336';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ad-NYjGHsK4vUSzrC';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 't-29-f3');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error('login falhou');

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9336', '--user-data-dir=' + path.join(__dirname, '..', '.edge-ws-profile'), '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const jsErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'ERRO-JS: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  await send('Page.enable'); await send('Runtime.enable');

  // ---------- DESKTOP 1440 escuro ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', 'dark'); localStorage.setItem('sidebar-collapsed','0'); location.reload(); 'ok'`);
  await sleep(3500);

  const stats = await evalJs(`(() => { const el = document.getElementById('dashboard-stats'); return { html: el ? el.innerText.replace(/\\n/g,' | ') : 'AUSENTE', n: (state.transcriptions||[]).length }; })()`);
  console.log('stats:', JSON.stringify(stats));
  const jobs = await evalJs(`(() => { const el = document.getElementById('active-jobs'); return { hidden: el.classList.contains('hidden'), cards: el.querySelectorAll('.job-card').length }; })()`);
  console.log('active-jobs:', JSON.stringify(jobs));
  await shot('ws-desktop-dashboard.png');

  // sidebar colapsável
  await evalJs(`toggleSidebarCollapse(); 'ok'`);
  await sleep(700);
  const collapsed = await evalJs(`(() => { const s = document.getElementById('app-sidebar'); return { w: getComputedStyle(s).width, collapsed: s.classList.contains('sidebar-collapsed'), persisted: localStorage.getItem('sidebar-collapsed') }; })()`);
  console.log('sidebar colapsada:', JSON.stringify(collapsed));
  await shot('ws-desktop-sidebar-collapsed.png');
  await evalJs(`toggleSidebarCollapse(); 'ok'`);
  await sleep(500);

  // mini-player: tocar o primeiro áudio concluído da lista
  const hasPlayable = await evalJs(`!!document.querySelector('button[aria-label^="Ouvir"]')`);
  console.log('tem áudio ouvível na lista:', hasPlayable);
  if (hasPlayable) {
    await evalJs(`document.querySelector('button[aria-label^="Ouvir"]').click(); 'ok'`);
    await sleep(1500);
    const mini = await evalJs(`(() => { const d = document.getElementById('mini-player'); const a = document.getElementById('audio-player'); return { visivel: !d.classList.contains('hidden'), titulo: document.getElementById('mini-title').textContent, tocando: a && !a.paused, tempo: document.getElementById('mini-time').textContent }; })()`);
    console.log('mini-player:', JSON.stringify(mini));
    await shot('ws-desktop-miniplayer.png');
    // fechar pelo botão X
    await evalJs(`closeMiniPlayer(); 'ok'`);
    await sleep(400);
    const fechado = await evalJs(`document.getElementById('mini-player').classList.contains('hidden')`);
    console.log('mini-player fechou:', fechado);
  }

  // ---------- MOBILE 360 escuro ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
  await sleep(3500);
  const overflow = await evalJs(`document.documentElement.scrollWidth + ' x ' + window.innerWidth`);
  console.log('scrollWidth x innerWidth (mobile):', overflow);
  await shot('ws-mobile-dashboard.png');

  console.log('erros JS:', jsErrors.length ? jsErrors.join(' || ') : 'nenhum');
  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
