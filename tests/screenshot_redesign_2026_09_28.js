// REDESIGN 2026-09-28 (tarde): validação da nova apresentação —
// (1) toggle "tempos e locutores" desligado gera texto contínuo sem chips,
// (2) aprimoramento renderiza no miolo (aba Resumo IA) em largura de leitura,
// (3) barra de pesquisa destaca ocorrências com contador.
// Reusa o mecanismo CDP de tests/screenshot_responsive.js.
// Pre-requisito: navegador headless com --remote-debugging-port=9333
// Uso: node tests/screenshot_redesign_2026_09_28.js
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9333';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'redesign-2026-09-28');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: 'admin123' })
  });
  const loginData = await loginRes.json();
  if (!loginData.token) throw new Error('login falhou: ' + JSON.stringify(loginData));
  const token = loginData.token;

  let targets;
  for (let i = 0; i < 30; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('aba nao encontrada no navegador CDP');
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
      const ready = await evalJs('document.readyState');
      if (ready === 'complete') return;
      await sleep(250);
    }
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  const setMetrics = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile
  });
  // helpers de contagem no DOM
  const countSeek = `document.querySelectorAll('#transcript-content button[onclick^="seekAudio"]').length`;
  const countChips = `document.querySelectorAll('#transcript-content span.rounded-full').length`;
  const setToggle = (on) => `(() => { const t = document.getElementById('toggle-timestamps'); t.checked = ${on}; t.dispatchEvent(new Event('change')); return 'ok'; })()`;

  await send('Page.enable');
  await send('Runtime.enable');

  // transcrição real com aprimoramento gerado na sessão anterior (hotfix)
  const TID = 'b04b3f1e-5e4a-4778-9056-b5466a9959c5';

  // desktop 1440: login na SPA e abertura da tela de detalhe
  await setMetrics(1440, 900, false);
  await send('Page.navigate', { url: `${BASE}/?nocache=${Date.now()}` });
  await waitReady(); await sleep(1200);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_reading_mode','transcript'); location.href='/?nocache='+Date.now(); 'ok'`);
  await sleep(2500);
  await evalJs(`showView('dashboard'); openTranscriptionDetail('${TID}'); 'ok'`);
  await sleep(2500);

  // (01) baseline: toggle ON — tempos e locutores visíveis
  console.log('toggle ON  | seek:', await evalJs(countSeek), '| chips:', await evalJs(countChips));
  await shot('01-desktop-toggle-on.png');

  // (02) toggle OFF — nada de tempo/locutor; texto contínuo em parágrafos
  await evalJs(setToggle(false));
  await sleep(800);
  const off = await evalJs(`JSON.stringify({seek: ${countSeek}, chips: ${countChips}, paragrafos: document.querySelectorAll('#transcript-content > p').length, texto: document.getElementById('transcript-content').innerText.length})`);
  console.log('toggle OFF |', off);
  await shot('02-desktop-toggle-off.png');

  // (03) aba Resumo IA — aprimoramento no miolo, largura e fonte de leitura
  await evalJs(`setReadingMode('summary'); 'ok'`);
  await sleep(900);
  const summary = await evalJs(`(() => {
    const c = document.getElementById('transcript-content');
    const cs = getComputedStyle(c);
    const header = c.querySelector('div.mb-5');
    return JSON.stringify({
      cabecalho: header ? header.innerText.slice(0, 60) : null,
      fonte: cs.fontSize, largura: Math.round(c.getBoundingClientRect().width),
      modo: state.readingMode, temEnhancement: !!(state.latestEnhancement && state.latestEnhancement.result_md)
    });
  })()`);
  console.log('aba Resumo IA |', summary);
  await evalJs(`document.getElementById('transcript-content').scrollIntoView({block:'start'}); 'ok'`);
  await sleep(400);
  await shot('03-desktop-summary-enhance.png');

  // (04) pesquisa no texto — destaque + contador
  await evalJs(`(() => { const i = document.getElementById('transcript-search'); i.value = 'teste'; i.dispatchEvent(new Event('input')); return 'ok'; })()`);
  await sleep(800);
  const search = await evalJs(`JSON.stringify({ocorrencias: document.querySelectorAll('#transcript-content mark.search-hit').length, contador: document.getElementById('search-count').innerText})`);
  console.log('pesquisa "teste" |', search);
  await shot('04-desktop-search-highlight.png');

  // mobile 375: sem scroll horizontal + texto contínuo
  await setMetrics(375, 812, true);
  await evalJs(`setReadingMode('transcript'); ${setToggle(false)}; 'ok'`);
  await sleep(900);
  const mob = await evalJs(`JSON.stringify({scrollHorizontal: document.documentElement.scrollWidth > window.innerWidth + 1, vw: window.innerWidth, seek: ${countSeek}, chips: ${countChips}})`);
  console.log('mobile toggle OFF |', mob);
  await shot('05-mobile-toggle-off.png');

  // mobile: aba Resumo IA ocupa a largura útil
  await evalJs(`setReadingMode('summary'); 'ok'`);
  await sleep(900);
  const mobSum = await evalJs(`(() => { const c = document.getElementById('transcript-content'); return JSON.stringify({largura: Math.round(c.getBoundingClientRect().width), vw: window.innerWidth}); })()`);
  console.log('mobile Resumo IA |', mobSum);
  await shot('06-mobile-summary.png');

  ws.close();
  console.log('DONE');
  process.exit(0);
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
