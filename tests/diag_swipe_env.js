// Diagnóstico: initSwipeBack rodou no ambiente headless?
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9341';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9341', '--user-data-dir=' + path.join(__dirname, '..', '.edge-diag2-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
    return r.result && r.result.result ? r.result.result.value : JSON.stringify(r.result);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${BASE}/app` });
  await sleep(3000);
  console.log(JSON.stringify(await evalJs(`({
    ontouchstart: 'ontouchstart' in window,
    pointerCoarse: matchMedia('(pointer: coarse)').matches,
    touchActionDetails: (document.getElementById('view-details') || {}).style ? document.getElementById('view-details').style.touchAction : 'view-ausente',
    maxTouchPoints: navigator.maxTouchPoints
  })`), null, 1));
  ws.close(); edge.kill(); process.exit(0);
}
setTimeout(() => process.exit(2), 60000).unref();
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
