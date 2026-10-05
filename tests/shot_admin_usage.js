// Screenshot da aba admin "Uso & Custos" (observabilidade T-36).
// Uso: node tests/shot_admin_usage.js
// Edge headless via CDP :9336; grava em docs/screenshots/admin-usage/.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9336';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'admin-usage');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ad-NYjGHsK4vUSzrC';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PROFILE = path.join(__dirname, '..', '.edge-usage-profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const loginData = await loginRes.json();
  if (!loginData.token) throw new Error('login falhou: ' + JSON.stringify(loginData));
  const token = loginData.token;

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9336', '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  if (!targets || !targets.length) { edge.kill(); throw new Error('Edge CDP nao respondeu'); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
    await sleep(2500);
    await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
    await sleep(3500);
    await evalJs(`showView('admin'); switchAdminTab('usage'); 'ok'`);
    await sleep(2500);

    const checks = await evalJs(`(() => {
      const mrr = document.getElementById('usage-mrr');
      const rows = document.querySelectorAll('#admin-usage-tbody tr').length;
      const tabVisible = !document.getElementById('admin-tab-usage').classList.contains('hidden');
      const unitInput = document.getElementById('admin-usage-unit-cost');
      return { tabVisible, mrr: mrr ? mrr.textContent : null, rows, unitCost: unitInput ? unitInput.value : null };
    })()`);
    console.log('checks:', JSON.stringify(checks));
    await shot('1-admin-usage.png');

    const ok = checks.tabVisible && checks.rows > 0 && checks.mrr && checks.mrr !== '—';
    console.log(ok ? 'VALIDACAO OK' : 'VALIDACAO FALHOU');
    process.exitCode = ok ? 0 : 1;
  } finally {
    try { ws.close(); } catch (_) {}
    edge.kill();
    await sleep(500);
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
