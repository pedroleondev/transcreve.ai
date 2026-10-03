// Checa T-34 (busca mobile): digita termo, navega com stepSearchHit e valida
// toolbar sticky + hit visível abaixo da barra + foco mantido no input.
const { spawn } = require('child_process');
const path = require('path');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9334';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: process.env.ADMIN_PASSWORD })
  });
  const token = (await loginRes.json()).token;
  const list = await (await fetch(`${BASE}/api/transcriptions`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const firstId = list[0].id;

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(__dirname, '..', '.edge-t34-check'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  await sleep(3000);
  await evalJs(`showView('dashboard'); openTranscriptionDetail('${firstId}'); 'ok'`);
  await sleep(2000);

  const r = await evalJs(`(async () => {
    toggleSearchBox();
    await new Promise(r => setTimeout(r, 300));
    const input = document.getElementById('transcript-search');
    input.value = 'arquivo';
    onTranscriptSearch('arquivo');
    await new Promise(r => setTimeout(r, 300));
    const before = {
      sticky: document.getElementById('reading-toolbar').classList.contains('toolbar-sticky'),
      hits: document.querySelectorAll('mark.search-hit').length,
      count: document.getElementById('search-count').innerText
    };
    // navega 2 ocorrencias pelas setas (mesmo clique do usuario)
    stepSearchHit(1); await new Promise(r => setTimeout(r, 400));
    stepSearchHit(1); await new Promise(r => setTimeout(r, 600));
    const hit = document.querySelector('mark.search-hit.ring-blue-500');
    const tb = document.getElementById('reading-toolbar').getBoundingClientRect();
    const hb = hit ? hit.getBoundingClientRect() : null;
    return {
      ...before,
      focoNoInput: document.activeElement === input,
      hitTop: hb ? Math.round(hb.top) : null,
      toolbarBottom: Math.round(tb.bottom),
      hitVisivelAbaixoDaBarra: hb ? hb.top >= tb.bottom - 2 : false,
      countApos: document.getElementById('search-count').innerText,
      scrollHorizontal: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  })()`);
  console.log(JSON.stringify(r, null, 2));
  ws.close(); edge.kill(); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
