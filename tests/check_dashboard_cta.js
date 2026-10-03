// Screenshot rápido do dashboard a 375px (valida CTA Transcrever Arquivos).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9334';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 't-34', 'after4');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: process.env.ADMIN_PASSWORD })
  });
  const token = (await loginRes.json()).token;
  if (!token) throw new Error('login falhou');

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(__dirname, '..', '.edge-dash-check'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  const send = (m, p = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method: m, params: p })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(3500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
  await sleep(3500);
  await evalJs(`showView('dashboard'); 'ok'`);
  await sleep(1500);

  const metrics = await evalJs(`(() => {
    const btns = [...document.querySelectorAll('#view-dashboard button')];
    const cta = btns.find(b => b.textContent.includes('Transcrever Arquivos'));
    if (!cta) return { erro: 'CTA nao encontrado' };
    const span = cta.querySelector('span');
    const cb = cta.getBoundingClientRect(), sb = span.getBoundingClientRect();
    return {
      ctaWidth: Math.round(cb.width),
      textoDentroDoBox: sb.left >= cb.left - 1 && sb.right <= cb.right + 1,
      scrollHorizontal: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  })()`);
  console.log('metricas:', JSON.stringify(metrics));

  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '1-dashboard-cta.png'), Buffer.from(r.result.data, 'base64'));
  console.log('salvo: 1-dashboard-cta.png');
  ws.close(); edge.kill(); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
