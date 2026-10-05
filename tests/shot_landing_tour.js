// Captura as cenas do "tour" da landing em 2x: desktop (1280 CSS -> 2560px)
// e mobile (360 CSS -> 720px). Simula uso real: dashboard -> abrir arquivo ->
// play com karaokê -> busca no texto. Nenhuma cena consome API paga (a busca
// é local e o play é o áudio já servido pela instância).
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9345';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ad-NYjGHsK4vUSzrC';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, '..', 'assets', 'landing');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error('login falhou');

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9345', '--user-data-dir=' + path.join(__dirname, '..', '.edge-tour-profile'), '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  const errs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', 'dark'); location.reload(); 'ok'`);
  await sleep(4500);

  // cena 1: dashboard
  await shot('cena-dashboard.png');

  // cena 2: editor com player tocando + karaokê grifado
  await evalJs(`(() => { const c = document.querySelector('#transcriptions-tbody [onclick^="openTranscriptionDetail"]'); if (c) c.click(); return 'ok'; })()`);
  await sleep(3000);
  await evalJs(`(() => { const b = [...document.querySelectorAll('#view-details button')].find(x => /Leitura/i.test(x.textContent)); if (b) b.click(); return 'ok'; })()`);
  await sleep(500);
  await evalJs(`(() => { const p = document.getElementById('audio-player'); if (p) p.play().catch(()=>{}); return 'ok'; })()`);
  await sleep(3500);
  await shot('cena-editor.png');

  // cena 3: busca no texto (funcionalidade local, zero custo de API)
  await evalJs(`(() => { const i = document.getElementById('transcript-search-input'); if (i) { i.removeAttribute('readonly'); i.value = 'plano'; i.dispatchEvent(new Event('input', { bubbles: true })); } return 'ok'; })()`);
  await sleep(700);
  await shot('cena-busca.png');

  // mobile: dashboard + editor
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
  await evalJs(`window.scrollTo(0,0); 'ok'`);
  await sleep(600);
  await shot('cena-mobile-dashboard.png');
  await evalJs(`(() => { const b = [...document.querySelectorAll('#view-details button')].find(x => /Transcrição/i.test(x.textContent)); if (b) b.click(); return 'ok'; })()`);
  await sleep(600);
  await evalJs(`window.scrollTo(0,0); 'ok'`);
  await sleep(400);
  await shot('cena-mobile-editor.png');

  console.log('erros:', errs.length ? errs : 'nenhum');
  ws.close(); edge.kill(); process.exit(0);
}
setTimeout(() => { console.error('TIMEOUT-GUARD'); process.exit(2); }, 150000).unref();
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
