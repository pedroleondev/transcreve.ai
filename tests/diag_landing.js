// Screenshot da landing page atualizada (desktop 1440 full page em 2 capturas).
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9342';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'landing');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9342', '--user-data-dir=' + path.join(__dirname, '..', '.edge-landing-profile'), '--no-first-run', '--window-size=1440,2400', 'about:blank'], { stdio: 'ignore' });
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value || a.description || '').join(' '));
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/?v=${Date.now()}` });
  await sleep(3500);
  console.log('gif natural:', await evalJs(`(() => { const g = document.querySelector('img[src*="hero-tour"]'); return g ? g.naturalWidth + 'x' + g.naturalHeight : 'NAO CARREGOU'; })()`));
  await shot('landing-hero.png');
  await evalJs(`window.scrollTo(0, document.getElementById('telas').offsetTop - 40); 'ok'`);
  await sleep(800);
  await shot('landing-telas.png');
  await evalJs(`window.scrollTo(0, document.getElementById('planos').offsetTop - 40); 'ok'`);
  await sleep(800);
  await shot('landing-planos.png');
  console.log('erros:', errs.length ? errs : 'nenhum');
  ws.close(); edge.kill(); process.exit(0);
}
setTimeout(() => { console.error('TIMEOUT-GUARD'); process.exit(2); }, 90000).unref();
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
