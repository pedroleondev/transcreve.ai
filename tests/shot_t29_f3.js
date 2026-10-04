// T-29 F3 (telas): screenshots do header + sidebar na paleta Obsidian.
// Desktop 1440 escuro+claro (dashboard com sidebar fixa) e mobile 360 claro
// (dashboard + drawer aberto). deviceScaleFactor 1 para evitar artefato de tiling.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9338';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9338', '--user-data-dir=' + path.join(__dirname, '..', '.edge-f3-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };

  await send('Page.enable'); await send('Runtime.enable');

  // ---- Desktop 1440: escuro, depois claro ----
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', 'dark'); location.reload(); 'ok'`);
  await sleep(4000);
  console.log('dashboard escuro carregado, cards:', await evalJs(`document.querySelectorAll('.transcription-card, #transcriptions-tbody tr').length`));
  await shot('desktop-dark-dashboard.png');
  await evalJs(`setTheme('light'); 'ok'`);
  await sleep(1200);
  await shot('desktop-light-dashboard.png');

  // drawer do usuario (menu) no claro, para validar painel
  await evalJs(`toggleUserMenu(new Event('click')); 'ok'`);
  await sleep(600);
  await shot('desktop-light-usermenu.png');
  await evalJs(`toggleUserMenu(new Event('click')); 'ok'`);

  // ---- Mobile 360: claro, drawer aberto ----
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await evalJs(`setTheme('light'); 'ok'`);
  await sleep(800);
  await shot('mobile-light-dashboard.png');
  await evalJs(`openSidebar(); 'ok'`);
  await sleep(800);
  await shot('mobile-light-drawer.png');
  const drawerAberto = await evalJs(`!document.getElementById('app-sidebar').classList.contains('-translate-x-full')`);
  console.log('drawer aberto no mobile:', drawerAberto);

  // ---- Mobile 360 escuro ----
  await evalJs(`closeSidebar(); setTheme('dark'); 'ok'`);
  await sleep(800);
  await shot('mobile-dark-dashboard.png');

  console.log('erros de console:', consoleErrors.length ? consoleErrors : 'nenhum');
  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
