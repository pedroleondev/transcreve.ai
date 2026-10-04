// T-29 F3: validação da navegação estilo PWA em mobile (CDP headless).
// (1) abrir detalhe empilha history.state {falouView:'details'}
// (2) swipe esquerda->direita no miolo volta ao dashboard (follow + goBack)
// (3) swipe curto (<80px) NAO volta e devolve a view ao lugar
// (4) history.back() (gesto do sistema Android) volta ao dashboard via popstate
// (5) botao "Voltar para arquivos" (goBack) volta ao dashboard
// Nota: Input.dispatchTouchEvent nao entrega eventos touch ao JS neste setup
// headless (Edge CDP) — o swipe e validado com TouchEvents sinteticos, que
// disparam os mesmos listeners. O pipeline nativo (touch-action: pan-y) e
// responsabilidade do browser.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9339';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ad-NYjGHsK4vUSzrC';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SWIPE_HELPER = `
window.__swipe = (points) => {
  const fire = (type, pt) => {
    const target = pt ? (document.elementFromPoint(pt.x, pt.y) || document.getElementById('view-details')) : document.getElementById('view-details');
    const t = new Touch({ identifier: 1, target, clientX: pt.x, clientY: pt.y, pageX: pt.x, pageY: pt.y });
    const active = type === 'touchend' ? [] : [t];
    const ev = new TouchEvent(type, { touches: active, targetTouches: active, changedTouches: [t], bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
  };
  fire('touchstart', points[0]);
  for (let i = 1; i < points.length - 1; i++) fire('touchmove', points[i]);
  fire('touchend', points[points.length - 1]);
  return 'ok';
};
'ok'`;

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error('login falhou');

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9339', '--user-data-dir=' + path.join(__dirname, '..', '.edge-pwa-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map(a => a.value || a.description || '').join(' '));
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'ERRO-JS: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  // URL pura de propósito: com ?nocache=... o primeiro history.back() cairia
  // numa URL diferente e recarregaria a página em vez de disparar popstate.
  await send('Page.navigate', { url: `${BASE}/app` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', 'dark'); location.reload(); 'ok'`);
  await sleep(4000);
  await evalJs(SWIPE_HELPER);

  const estado = () => evalJs(`state.currentView + ' | transform=' + (document.getElementById('view-details').style.transform || 'nenhum') + ' | state=' + JSON.stringify(history.state)`);
  const abrirDetalhe = async () => {
    await evalJs(`(() => { const c = document.querySelector('.transcription-card [onclick^="openTranscriptionDetail"]') || document.querySelector('[onclick^="openTranscriptionDetail"]'); if (c) c.click(); return 'ok'; })()`);
    await sleep(2500);
    return estado();
  };
  const swipe = (fromX, toX, y) => {
    const pts = [];
    for (let x = fromX; x <= toX; x += 20) pts.push({ x, y });
    pts.push({ x: toX, y });
    return evalJs(`window.__swipe(${JSON.stringify(pts)})`);
  };

  // (1) abrir detalhe empilha state
  console.log('1 abre detalhe ->', await abrirDetalhe());

  // (2) swipe completo: follow durante o gesto + volta ao dashboard
  await evalJs(`(() => { const pts = []; for (let x = 40; x <= 155; x += 23) pts.push({ x, y: 420 }); window.__swipeStartOnly = pts; const t = new Touch({ identifier: 1, target: document.elementFromPoint(pts[0].x, pts[0].y), clientX: pts[0].x, clientY: pts[0].y }); const ev = new TouchEvent('touchstart', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }); (document.elementFromPoint(pts[0].x, pts[0].y) || document.getElementById('view-details')).dispatchEvent(ev); return 'ok'; })()`);
  await evalJs(`(() => { const el = document.elementFromPoint(90, 420) || document.getElementById('view-details'); const t = new Touch({ identifier: 1, target: el, clientX: 90, clientY: 420 }); const ev = new TouchEvent('touchmove', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true }); el.dispatchEvent(ev); return document.getElementById('view-details').style.transform || 'sem-follow'; })()`).then(r => console.log('2 follow durante gesto ->', r));
  await evalJs(`(() => { const pts = []; for (let x = 113; x <= 155; x += 21) pts.push({ x, y: 420 }); const fire = (pt) => { const el = document.elementFromPoint(pt.x, pt.y) || document.getElementById('view-details'); const t = new Touch({ identifier: 1, target: el, clientX: pt.x, clientY: pt.y }); el.dispatchEvent(new TouchEvent('touchmove', { touches: [t], targetTouches: [t], changedTouches: [t], bubbles: true, cancelable: true })); }; pts.forEach(fire); const el = document.getElementById('view-details'); const t = new Touch({ identifier: 1, target: el, clientX: 155, clientY: 420 }); el.dispatchEvent(new TouchEvent('touchend', { touches: [], targetTouches: [], changedTouches: [t], bubbles: true, cancelable: true })); return 'ok'; })()`);
  await sleep(700);
  console.log('2 apos swipe completo ->', await estado());

  // (3) swipe curto (<80px) nao volta e devolve a view
  console.log('3 reabre detalhe ->', await abrirDetalhe());
  await swipe(60, 110, 420);
  await sleep(500);
  console.log('3 apos swipe curto (fica em details, view recolocada) ->', await estado());

  // (4) history.back (gesto do sistema)
  console.log('4 reabre detalhe ->', await abrirDetalhe());
  await evalJs(`history.back(); 'ok'`);
  await sleep(800);
  console.log('4 apos history.back ->', await estado());

  // (5) botao "Voltar para arquivos"
  console.log('5 reabre detalhe ->', await abrirDetalhe());
  await evalJs(`(() => { const b = [...document.querySelectorAll('#view-details button')].find(x => x.textContent.includes('Voltar')); if (b) b.click(); return 'ok'; })()`);
  await sleep(800);
  console.log('5 apos botao voltar ->', await estado());

  console.log('erros de console:', consoleErrors.length ? consoleErrors : 'nenhum');
  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
setTimeout(() => { console.error('TIMEOUT-GUARD'); process.exit(2); }, 120000).unref();
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
