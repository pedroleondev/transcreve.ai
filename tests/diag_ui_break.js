// Diagnóstico do bug reportado: menus transparentes / cliques não abrem.
// Carrega /app, captura erros de console, testa cliques nos menus e mede
// o fundo computado do dropdown do usuário e de outros painéis.
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

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
  if (!token) throw new Error('login falhou');

  const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9334', '--user-data-dir=' + path.join(__dirname, '..', '.edge-diag-profile'), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await (await fetch(`${DEBUG}/json/list`)).json(); if (targets && targets.length) break; } catch (_) {}
    await sleep(500);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map(); const consoleMsgs = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning'))
      consoleMsgs.push(m.params.type + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      consoleMsgs.push('EXCEPTION: ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) return 'ERRO-JS: ' + JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable'); await send('Runtime.enable');

  // SEM tema forçado (como o usuário usa) e COM tema claro, como no screenshot
  for (const theme of ['light', 'dark']) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${BASE}/app?nocache=${Date.now()}` });
    await sleep(2500);
    await evalJs(`localStorage.setItem('turboscribe_token', ${JSON.stringify(token)}); localStorage.setItem('transcreveai_theme', '${theme}'); location.reload(); 'ok'`);
    await sleep(3500);

    const diag = await evalJs(`(() => {
      const drop = document.querySelector('#user-menu-btn')?.closest('.group')?.querySelector('.absolute');
      const cs = drop ? getComputedStyle(drop) : null;
      const sidebar = document.getElementById('app-sidebar');
      const cssOk = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
      const rows = document.querySelectorAll('#transcriptions-tbody tr').length;
      const cards = document.querySelectorAll('#transcriptions-cards > div').length;
      return {
        tema: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        cssVarsOk: cssOk || 'VAZIO',
        dropdownBg: cs ? cs.backgroundColor : 'nao-achou-dropdown',
        dropdownDisplay: cs ? cs.display : '-',
        sidebarExiste: !!sidebar,
        linhasTabela: rows, cardsMobile: cards,
        jsOk: typeof openSidebar === 'function' && typeof showView === 'function' && typeof openTranscribeModal === 'function',
        lucideOk: typeof lucide !== 'undefined'
      };
    })()`);
    console.log(`[${theme}]`, JSON.stringify(diag, null, 1));

    // testa cliques reais
    const clickTest = await evalJs(`(() => {
      const out = {};
      try { document.getElementById('user-menu-btn').click(); out.userMenuClick = 'ok'; } catch (e) { out.userMenuClick = e.message; }
      const drop = document.querySelector('#user-menu-btn')?.closest('.group')?.querySelector('.absolute');
      out.dropVisibleAfterClick = drop ? getComputedStyle(drop).display : 'nao-achou';
      try { openSidebar(); out.openSidebar = 'ok'; } catch (e) { out.openSidebar = 'ERR ' + e.message; }
      const sb = document.getElementById('app-sidebar');
      out.sidebarState = sb ? sb.className.slice(0, 80) : 'nao-achou';
      try { showView('admin'); out.showViewAdmin = document.getElementById('view-admin')?.classList.contains('hidden') ? 'oculto' : 'visivel'; } catch (e) { out.showViewAdmin = 'ERR ' + e.message; }
      try { showView('dashboard'); } catch (_) {}
      return out;
    })()`);
    console.log(`[${theme}] cliques:`, JSON.stringify(clickTest, null, 1));
  }

  console.log('--- console errors/warnings ---');
  consoleMsgs.slice(0, 15).forEach(m => console.log(m));
  ws.close(); edge.kill(); console.log('DONE'); process.exit(0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
