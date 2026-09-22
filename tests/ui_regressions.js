const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const storage = new Map();
const elements = new Map();
let savedBody = null;
let dark = false;
const context = {
  localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
  document: {
    addEventListener() {},
    getElementById: id => elements.get(id),
    documentElement: { classList: { toggle: (name, enabled) => { dark = enabled; } } }
  },
  window: { matchMedia: () => ({ matches: true, addEventListener() {} }) },
  fetch: async (url, options) => { savedBody = JSON.parse(options.body); return { ok: true, json: async () => ({success: true, raw_text: savedBody.raw_text, segments: savedBody.segments}) }; },
  alert() {}, console
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
(async () => {
  let passed = 0;
  const check = (condition, label) => { assert(condition, label); console.log('PASS: ' + label); passed++; };
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const handlers = [...html.matchAll(/on(?:click|submit|input|change)="([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1]);
  check(handlers.every(name => ['alert', 'confirm'].includes(name) || typeof context[name] === 'function'), 'handlers do HTML existem');
  check(context.renderMarkdown('> citacao').includes('<blockquote'), 'citacao Markdown');
  check(!context.renderMarkdown('<img src=x onerror=alert(1)>').includes('<img'), 'HTML externo escapado');
  context.setTheme('dark'); check(dark && storage.get('transcreveai_theme') === 'dark', 'tema escuro persistido');
  context.setTheme('light'); check(!dark, 'tema claro');
  context.setTheme('system'); check(dark, 'tema sistema');
  elements.set('transcript-content', { querySelector: () => ({ innerText: 'Texto editado\n\nSegundo trecho' }), querySelectorAll: () => [{ dataset: {segmentId:'a'}, innerText: 'Texto editado' }, { dataset: {segmentId:'b'}, innerText: 'Segundo trecho' }] });
  vm.runInContext("state.activeTranscription = { id: 'test' }; state.readingMode = 'summary';", context);
  await context.saveTranscriptChanges(); check(savedBody === null, 'resumo nao sobrescreve transcricao');
  vm.runInContext("state.readingMode = 'transcript';", context);
  await context.saveTranscriptChanges(); check(savedBody.raw_text === 'Texto editado\n\nSegundo trecho', 'salvar exclui timestamps e rotulos');
  vm.runInContext("state.activeTranscription.segments = [{id:'a',text:'original'},{id:'b',text:'original'}];", context);
  await context.saveTranscriptChanges(); check(savedBody.segments[0].id === 'a' && savedBody.segments[1].text === 'Segundo trecho' && !('raw_text' in savedBody), 'edicao envia IDs e texto sem metadados');
  check(vm.runInContext("state.activeTranscription.segments[0].text", context) === 'Texto editado', 'estado atualizado apos salvar');
  elements.set('apikey-modal', { classList: { add() {} } });
  elements.set('apikey-input', { value: 'test-only', type: 'text' });
  elements.set('apikey-admin-password', { value: 'test-only' });
  context.closeApiKeyModal();
  check(elements.get('apikey-input').value === '' && elements.get('apikey-input').type === 'password' && elements.get('apikey-admin-password').value === '', 'fechar limpa segredos');
  // T-15: widget da chave — não-admin vê estado neutro e NÃO chama a API admin (evita o 403 virar "não configurada")
  elements.set('apikey-dot', { className: '' });
  elements.set('apikey-state-text', { textContent: '' });
  elements.set('apikey-masked', { textContent: '' });
  let btnHidden = false;
  elements.set('apikey-config-btn', { classList: { add: () => { btnHidden = true; }, remove: () => { btnHidden = false; } } });
  await vm.runInContext("state.currentUser = { id: 'u1', role: 'user' };", context);
  await context.loadApiKeyStatus();
  check(elements.get('apikey-state-text').textContent === 'gerenciada pelo admin' && btnHidden, 'nao-admin: estado neutro e botao oculto, sem chamada a API');
  await vm.runInContext("state.currentUser = { id: 'a1', role: 'admin' };", context);
  await context.loadApiKeyStatus();
  check(btnHidden === false, 'admin: botao de configurar reaparece');
  console.log(passed + '/' + passed + ' PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
