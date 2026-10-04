// Diagnóstico 3: inspeciona a regra .bg-brand-surface gerada pelo Tailwind CDN.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9334';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const { token } = await loginRes.json();
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(__dirname, '..', '.edge-diag3-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
    if (r.result && r.result.exceptionDetails) return 'ERRO: ' + (r.result.exceptionDetails.exception?.description || '');
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
  await sleep(4000);

  const rules = await evalJs(`(() => {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && /brand-surface|brand-canvas/.test(r.selectorText) && !r.selectorText.includes('hover') && !r.selectorText.includes('dark')) {
          out.push(r.cssText.slice(0, 200));
        }
      }
    }
    return out.slice(0, 10);
  })()`);
  console.log(JSON.stringify(rules, null, 1));
  ws.close(); edge.kill(); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
