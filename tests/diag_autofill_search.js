// Diagnóstico: simula o autofill do Chrome (valor injetado sem foco), recarrega
// e confere se a rede de segurança limpa a busca e a lista volta a aparecer.
const path = require('path');
const { spawn } = require('child_process');
const BASE = 'http://localhost:3000';
const DEBUG = 'http://localhost:9340';
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

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9340', '--user-data-dir=' + path.join(__dirname, '..', '.edge-autofill-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
  await sleep(2500);
  await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); location.reload(); 'ok'`);
  await sleep(4000);

  // injeta valor como o autofill faria (sem foco) e recarrega
  await evalJs(`(() => { const i = document.getElementById('search-input'); i.removeAttribute('readonly'); i.value = 'pedro.leon23@gmail.com'; handleSearch(); return 'injetado'; })()`);
  const antes = await evalJs(`({ valor: document.getElementById('search-input').value, linhas: document.querySelectorAll('#transcriptions-tbody tr').length })`);
  console.log('antes do reload:', JSON.stringify(antes));
  await send('Page.navigate', { url: `${BASE}/app?nocache2=${Date.now()}` });
  await sleep(4500);

  const depois = await evalJs(`(() => {
    const input = document.getElementById('search-input');
    const linhasVisiveis = Array.from(document.querySelectorAll('#transcriptions-tbody tr')).filter(r => r.style.display !== 'none').length;
    const nr = document.getElementById('search-no-results');
    input.focus();
    const readonlyRemovidoNoFoco = !input.hasAttribute('readonly');
    return {
      valorAposReload: input.value,
      readonlyAposFoco: readonlyRemovidoNoFoco,
      linhasVisiveis,
      feedbackSemResultadoVisivel: nr && !nr.classList.contains('hidden')
    };
  })()`);
  console.log('após reload:', JSON.stringify(depois, null, 1));

  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
