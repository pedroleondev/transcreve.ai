// Diagnóstico: o screenshot mobile repetiu o painel lateral — artefato do
// capture ou DOM realmente duplicado? Mede o DOM e recaptura sem beyond-viewport.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9338';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9338', '--user-data-dir=' + path.join(__dirname, '..', '.edge-mobile2-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  const shot = async (name, extra = {}) => {
    const r = await send('Page.captureScreenshot', { format: 'png', ...extra });
    require('fs').writeFileSync(path.join(__dirname, '..', 'docs', 'screenshots', name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 2, mobile: true });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_reading_mode', 'reading'); localStorage.setItem('transcreveai_theme', 'light'); location.reload(); 'ok'`);
  await sleep(4000);
  await evalJs(`(() => { const c = document.querySelector('.transcription-card [onclick^="openTranscriptionDetail"]'); if (c) c.click(); return 'ok'; })()`);
  await sleep(2500);

  const dom = await evalJs(`(() => {
    const sel = document.querySelectorAll('select').length;
    const labels = Array.from(document.querySelectorAll('label, h3, span')).filter(e => /VINCULAR A PROJETO/.test(e.textContent)).length;
    const tc = document.getElementById('transcript-content');
    const tcRect = tc ? tc.getBoundingClientRect() : null;
    const sidebar = document.querySelector('#view-details .lg\\\\:w-80');
    const sbRect = sidebar ? sidebar.getBoundingClientRect() : null;
    return {
      selectsNoDom: sel,
      labelsVincular: labels,
      bodyScrollH: document.body.scrollHeight,
      innerH: window.innerHeight,
      transcriptTop: tcRect ? Math.round(tcRect.top) : null,
      transcriptH: tcRect ? Math.round(tcRect.height) : null,
      sidebarTop: sbRect ? Math.round(sbRect.top) : null,
      sidebarH: sbRect ? Math.round(sbRect.height) : null,
      detalhesHtmlLen: document.getElementById('view-details').innerHTML.length
    };
  })()`);
  console.log('DOM:', JSON.stringify(dom, null, 1));

  await shot('diag-mobile2-viewport-only.png', { captureBeyondViewport: false });
  await sleep(1500);
  await shot('diag-mobile2-after-settle.png', { captureBeyondViewport: false });

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
