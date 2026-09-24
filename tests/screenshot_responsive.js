// Screenshots T-17: valida layout em 375/768/1440 via Edge headless + CDP.
// Uso: node tests/screenshot_responsive.js
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9333';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 't-17');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 1) token real via login admin
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: 'admin123' })
  });
  const loginData = await loginRes.json();
  if (!loginData.token) throw new Error('login falhou: ' + JSON.stringify(loginData));
  const token = loginData.token;

  const listRes = await fetch(`${BASE}/api/transcriptions`, { headers: { Authorization: `Bearer ${token}` } });
  const transcriptions = await listRes.json();
  const firstId = Array.isArray(transcriptions) && transcriptions.length ? transcriptions[0].id : null;

  // 2) conectar no Edge headless
  let targets;
  for (let i = 0; i < 30; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('aba nao encontrada no Edge');
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
    if (r.result && r.result.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const waitReady = async () => {
    for (let i = 0; i < 40; i++) {
      const ready = await evalJs('document.readyState');
      if (ready === 'complete') return;
      await sleep(250);
    }
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  const setMetrics = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const sizes = [
    { w: 375, h: 812, mobile: true, label: '375-mobile' },
    { w: 768, h: 1024, mobile: false, label: '768-tablet' },
    { w: 1440, h: 900, mobile: false, label: '1440-desktop' },
  ];

  for (const s of sizes) {
    await setMetrics(s.w, s.h, s.mobile);
    // tela de login (sem token)
    await send('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}` });
    await waitReady(); await sleep(1200);
    await shot(`${s.label}-1-login.png`);

    // injeta token e recarrega -> dashboard
    await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.href='/?nocache='+Date.now(); 'ok'`);
    await sleep(2500);
    await shot(`${s.label}-2-dashboard.png`);

    // detalhe da transcrição
    if (firstId) {
      await evalJs(`showView('dashboard'); openTranscriptionDetail('${firstId}'); 'ok'`);
      await sleep(2000);
      await shot(`${s.label}-3-detail.png`);
    }
  }

  // modal em tela cheia no mobile
  await setMetrics(375, 812, true);
  await evalJs(`showView('dashboard'); openTranscribeModal(); 'ok'`);
  await sleep(1200);
  await shot('375-mobile-4-modal-transcribe.png');

  ws.close();
  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
