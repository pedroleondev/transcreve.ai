// Recaptura o screenshot do editor (player tocando) para a landing —
// a versão anterior foi tirada antes da migração do header Obsidian.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9343';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ad-NYjGHsK4vUSzrC';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error('login falhou');
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9343', '--user-data-dir=' + path.join(__dirname, '..', '.edge-shot-editor-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', 'dark'); location.reload(); 'ok'`);
  await sleep(4000);
  await evalJs(`(() => { const c = document.querySelector('#transcriptions-tbody [onclick^="openTranscriptionDetail"]'); if (c) c.click(); return 'ok'; })()`);
  await sleep(3000);
  // modo leitura + play para waveform/karaoke aparecerem
  await evalJs(`(() => { const b = [...document.querySelectorAll('#view-details button')].find(x => /Leitura/i.test(x.textContent)); if (b) b.click(); return 'ok'; })()`);
  await sleep(600);
  await evalJs(`(() => { const p = document.getElementById('audio-player'); if (p) { p.play().catch(()=>{}); } return 'ok'; })()`);
  await sleep(2500);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'landing', 'app-editor.png'), Buffer.from(r.result.data, 'base64'));
  console.log('salvo: assets/landing/app-editor.png');
  ws.close(); edge.kill(); process.exit(0);
}
setTimeout(() => { console.error('TIMEOUT-GUARD'); process.exit(2); }, 90000).unref();
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
