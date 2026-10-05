// Análise da landing no mobile (360px): captura em blocos para avaliar
// indentação, hierarquia e quebras de layout.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9344';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots', 'landing');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9344', '--user-data-dir=' + path.join(__dirname, '..', '.edge-landing-m-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.result.data, 'base64'));
    console.log('salvo:', name);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: `${BASE}/?v=${Date.now()}` });
  await sleep(3500);
  // blocos: hero, telas, recursos, planos, faq
  const stops = [
    ['m-01-hero.png', 0],
    ['m-02-gif.png', null], // posicao do gif
    ['m-03-telas.png', 'telas'],
    ['m-04-recursos.png', 'recursos'],
    ['m-05-planos.png', 'planos'],
    ['m-06-faq.png', 'faq'],
  ];
  for (const [name, target] of stops) {
    if (target === null) {
      await evalJs(`window.scrollTo(0, document.querySelector('img[src*="hero-tour"]').getBoundingClientRect().top + window.scrollY - 120); 'ok'`);
    } else if (target === 0) {
      await evalJs(`window.scrollTo(0, 0); 'ok'`);
    } else {
      await evalJs(`window.scrollTo(0, document.getElementById('${target}').offsetTop - 60); 'ok'`);
    }
    await sleep(700);
    await shot(name);
  }
  // overflow horizontal? (indicador classico de "identacao quebrada")
  console.log('scrollWidth x innerWidth:', await evalJs(`document.documentElement.scrollWidth + ' x ' + window.innerWidth`));
  ws.close(); edge.kill(); process.exit(0);
}
setTimeout(() => { console.error('TIMEOUT-GUARD'); process.exit(2); }, 90000).unref();
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
