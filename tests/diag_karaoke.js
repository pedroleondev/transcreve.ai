// Diagnóstico: valida karaoke (modo Leitura) + nerd toggle (dados técnicos).
// Abre uma transcrição concluída, confere meta sem modelo, liga o nerd mode,
// vai para o modo Leitura, dá play e confere palavra grifada (.cc-on).
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9335';
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

  const listRes = await fetch(`${BASE}/api/transcriptions?all=true`, { headers: { Authorization: `Bearer ${token}` } });
  const list = await listRes.json();
  const done = (Array.isArray(list) ? list : []).find(t => t.status === 'completed');
  if (!done) throw new Error('nenhuma transcrição completed encontrada');
  console.log('usando transcrição:', done.id, done.file_name);

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9335', '--autoplay-policy=no-user-gesture-required', '--user-data-dir=' + path.join(__dirname, '..', '.edge-karaoke-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
  await sleep(3500);

  await evalJs(`openTranscriptionDetail('${done.id}'); 'ok'`);
  await sleep(2500);

  // 1) Meta sem modelo (nerd off)
  const metaOff = await evalJs(`document.getElementById('detail-meta').innerText`);
  console.log('meta (nerd off):', metaOff);
  await shot('diag-karaoke-1-meta-nerd-off.png');

  // 2) Liga nerd mode
  await evalJs(`toggleNerdMode(); 'ok'`);
  await sleep(400);
  const metaOn = await evalJs(`document.getElementById('detail-meta').innerText`);
  const btnState = await evalJs(`document.getElementById('btn-nerd-toggle').className.includes('nerd-on')`);
  console.log('meta (nerd on):', metaOn, '| botão ativo:', btnState);
  await shot('diag-karaoke-2-meta-nerd-on.png');

  // 3) Modo Leitura + play
  await evalJs(`setReadingMode('reading'); 'ok'`);
  await sleep(800);
  const ccCount = await evalJs(`document.querySelectorAll('.cc-word').length`);
  console.log('spans .cc-word no modo Leitura:', ccCount);
  await evalJs(`(() => { const a = document.getElementById('audio-player'); a.play().catch(()=>{}); return 'ok'; })()`);
  await sleep(3500);
  const ccState = await evalJs(`(() => {
    const on = document.querySelector('.cc-word.cc-on');
    const para = document.querySelector('.cc-para.cc-block-active');
    return {
      tocando: !document.getElementById('audio-player').paused,
      tempo: document.getElementById('audio-player').currentTime,
      palavraAtiva: on ? on.textContent : null,
      paragrafoAtivo: !!para
    };
  })()`);
  console.log('estado karaoke:', JSON.stringify(ccState));
  await shot('diag-karaoke-3-leitura-play.png');

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
