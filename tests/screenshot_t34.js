// Screenshots T-34: tela de detalhe em 375px (antes/depois do redesenho mobile).
// Uso: node tests/screenshot_t34.js [after|before]
// Liga o Edge headless sozinho (CDP :9334), tira os screenshots e mede os
// critérios de aceite (ordem do painel, Coluna oculta, toolbar <= 2 linhas,
// sem scroll horizontal), gravando o resumo em docs/screenshots/t-34/resumo.json.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9334';
const MODE = process.argv[2] || 'after';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 't-34', MODE);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 1) token real via login admin
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const loginData = await loginRes.json();
  if (!loginData.token) throw new Error('login falhou: ' + JSON.stringify(loginData));
  const token = loginData.token;

  const listRes = await fetch(`${BASE}/api/transcriptions`, { headers: { Authorization: `Bearer ${token}` } });
  const transcriptions = await listRes.json();
  const firstId = Array.isArray(transcriptions) && transcriptions.length ? transcriptions[0].id : null;
  if (!firstId) throw new Error('nenhuma transcricao disponivel para abrir o detalhe');

  // 2) Edge headless com CDP
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=9334`, '--user-data-dir=' + path.join(__dirname, '..', '.edge-t34-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  if (!targets || !targets.length) { edge.kill(); throw new Error('Edge CDP nao respondeu'); }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  const waitReady = async () => {
    for (let i = 0; i < 40; i++) {
      if (await evalJs('document.readyState') === 'complete') return;
      await sleep(250);
    }
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });

  // 3) entra na SPA autenticada e abre a tela de detalhe
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await waitReady(); await sleep(1500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
  await sleep(3000);
  await evalJs(`showView('dashboard'); openTranscriptionDetail('${firstId}'); 'ok'`);
  await sleep(2500);
  await shot('1-detail-toolbar.png');

  // 4) mede os critérios de aceite
  const metrics = await evalJs(`(() => {
    const panel = document.querySelector('#view-details .order-first, #view-details .lg\\\\:w-80') || [...document.querySelectorAll('#view-details > div')].pop();
    const central = document.querySelector('#view-details > div');
    const panelEl = document.querySelector('#view-details > div:last-child');
    const toolbar = central ? central.querySelectorAll('.relative')[0] : null;
    const bar = central ? [...central.querySelectorAll('div')].find(d => d.querySelector('#btn-mode-transcript')) : null;
    const searchToggle = document.getElementById('search-toggle');
    const comfortToggle = document.getElementById('btn-comfort-toggle');
    return {
      panelBeforeCentral: panelEl && central ? panelEl.getBoundingClientRect().top < central.getBoundingClientRect().top : null,
      toolbarHeight: bar ? bar.offsetHeight : null,
      toolbarLines: bar ? Math.round(bar.offsetHeight / 36 * 10) / 10 : null,
      searchToggleVisible: searchToggle ? !!searchToggle.offsetParent : null,
      comfortToggleVisible: comfortToggle ? !!comfortToggle.offsetParent : null,
      colNarrowHidden: (() => { const b = document.getElementById('btn-col-narrow'); if (!b) return 'sem-botao'; return b.closest('.hidden.md\\\\:flex') ? 'via-wrapper' : (!!b.offsetParent ? 'visivel' : 'oculto'); })(),
      scrollHorizontal: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  })()`);
  console.log('metricas:', JSON.stringify(metrics, null, 2));

  // 5) pesquisa expandida (só existe no "depois")
  if (await evalJs(`!!document.getElementById('search-toggle')`)) {
    await evalJs(`toggleSearchBox(); 'ok'`);
    await sleep(600);
    await shot('2-detail-search-open.png');
    await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'})); 'ok'`);
    await sleep(400);
  }

  // 6) dropdown de conforto aberto (só existe no "depois")
  if (await evalJs(`!!document.getElementById('btn-comfort-toggle')`)) {
    await evalJs(`toggleComfortControls(); 'ok'`);
    await sleep(600);
    await shot('3-detail-comfort-open.png');
    await evalJs(`setFontSize('lg'); 'ok'`);
    await sleep(400);
    await shot('4-detail-fonte-lg.png');
  }

  fs.writeFileSync(path.join(OUT, 'resumo.json'), JSON.stringify({ modo: MODE, quando: new Date().toISOString(), metrics }, null, 2));
  ws.close();
  edge.kill();
  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
