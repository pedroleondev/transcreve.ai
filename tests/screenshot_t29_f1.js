// Screenshots T-29 F1: aplicação dos tokens Obsidian Wave em 3 larguras (375/768/1440)
// e nos dois temas (dark/light). Mede os tokens computados para provar que a
// paleta nova está viva. Uso: node tests/screenshot_t29_f1.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9334';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 't-29-f1');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(__dirname, '..', '.edge-t29-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
    if (r.result && r.result.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };

  await send('Page.enable');
  await send('Runtime.enable');

  const report = {};
  for (const theme of ['dark', 'light']) {
    for (const [w, h, label] of [[375, 812, 'mobile'], [768, 1024, 'tablet'], [1440, 900, 'desktop']]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 768 });
      await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
      await sleep(1500);
      await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', '${theme}'); location.reload(); 'ok'`);
      await sleep(3000);

      const tokens = await evalJs(`(() => {
        const cs = getComputedStyle(document.body);
        const s = getComputedStyle(document.querySelector('#view-dashboard > div > div, main'));
        return {
          dark: document.documentElement.classList.contains('dark'),
          bodyBg: cs.backgroundColor, bodyColor: cs.color,
          fontFamily: cs.fontFamily,
          surfaceVar: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
          accentVar: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
          scrollHorizontal: document.documentElement.scrollWidth > window.innerWidth + 1
        };
      })()`);
      report[`${theme}-${label}`] = tokens;

      await shot(`${theme}-${label}-dashboard.png`);
    }
  }

  // abre o detalhe no mobile dark pra evidenciar o miolo (editor)
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await evalJs(`localStorage.setItem('transcreveai_theme', 'dark'); location.reload(); 'ok'`);
  await sleep(2500);
  const listRes = await fetch(`${BASE}/api/transcriptions`, { headers: { Authorization: `Bearer ${token}` } });
  const transcriptions = await listRes.json();
  if (Array.isArray(transcriptions) && transcriptions.length) {
    await evalJs(`showView('dashboard'); openTranscriptionDetail('${transcriptions[0].id}'); 'ok'`);
    await sleep(2500);
    await shot('dark-mobile-detail.png');
  }

  fs.writeFileSync(path.join(OUT, 'resumo.json'), JSON.stringify({ quando: new Date().toISOString(), report }, null, 2));
  console.log('tokens:', JSON.stringify(report, null, 2));
  ws.close();
  edge.kill();
  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
