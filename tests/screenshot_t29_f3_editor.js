// Screenshot do editor (T-29 F3): player persistente + blocos de fala.
// Desktop 1440 (tudo visível) e mobile 375 rolado até o player.
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
  const { token } = await loginRes.json();
  if (!token) throw new Error('login falhou');

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(__dirname, '..', '.edge-t29f3-profile'), '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
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
    if (r.result && r.result.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  await send('Page.enable'); await send('Runtime.enable');

  const listRes = await fetch(`${BASE}/api/transcriptions`, { headers: { Authorization: `Bearer ${token}` } });
  const transcriptions = await listRes.json();
  const id = transcriptions.find(t => (t.segments || []).length >= 3)?.id || transcriptions[0].id;

  // Desktop: tudo visível
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2000);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', 'dark'); location.reload(); 'ok'`);
  await sleep(3000);
  await evalJs(`showView('dashboard'); openTranscriptionDetail('${id}'); 'ok'`);
  await sleep(3000);
  // toca 3s pra acender o segmento ativo e a waveform
  await evalJs(`(async () => { const a = document.getElementById('audio-player'); a.currentTime = 1; a.play(); await new Promise(r => setTimeout(r, 3000)); return a.currentTime; })()`);
  await shot('f3-desktop-editor-playing.png');
  const m1 = await evalJs(`(() => {
    const blocks = document.querySelectorAll('.speech-block').length;
    const active = document.querySelectorAll('.speech-block.seg-active').length;
    const canvas = document.getElementById('waveform-canvas');
    const tabActive = document.querySelectorAll('.mode-tab-active').length;
    return { blocks, active, canvasW: canvas ? canvas.clientWidth : 0, tabActive, time: document.getElementById('player-time').textContent };
  })()`);
  console.log('desktop:', JSON.stringify(m1));
  await evalJs(`document.getElementById('audio-player').pause(); 'ok'`);

  // Mobile: rolado até o player (depois do painel lateral)
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await evalJs(`location.reload(); 'ok'`);
  await sleep(3000);
  await evalJs(`showView('dashboard'); openTranscriptionDetail('${id}'); 'ok'`);
  await sleep(2500);
  await evalJs(`document.getElementById('player-bar').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); 'ok'`);
  await sleep(800);
  await shot('f3-mobile-editor-player.png');
  const sticky = await evalJs(`(() => { const b = document.getElementById('player-bar'); const cs = getComputedStyle(b); return { position: cs.position, top: cs.top, zIndex: cs.zIndex }; })()`);
  console.log('mobile sticky:', JSON.stringify(sticky));

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
