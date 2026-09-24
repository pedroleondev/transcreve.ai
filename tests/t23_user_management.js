// Teste de aceite T-23 — Gestão de usuários (admin cria usuários e admins).
// Zero custo de API: só auth + CRUD local, banco isolado (DB_PATH) e provedor mock.
// Uso: node tests/t23_user_management.js

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3123;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(os.tmpdir(), `t23-test-${Date.now()}.sqlite`);

let server;
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name} ${extra}`); }
}

async function api(method, url, { token, body } = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* resposta vazia */ }
  return { status: res.status, data };
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.status === 200) return;
    } catch (_) { /* ainda subindo */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}

async function login(email, password) {
  const { status, data } = await api('POST', '/api/auth/login', { body: { email, password } });
  return { status, token: data?.token, user: data?.user };
}

(async () => {
  console.log('T-23 — Gestão de usuários (banco isolado, provedor mock)\n');

  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, TRANSCRIBE_PROVIDER: 'mock', MOCK_LATENCY_MS: '80' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', d => process.stderr.write(`[server] ${d}`));

  try {
    await waitReady();

    // Login base (seed do db.js: admin + pedro.leon23 como user)
    const admin = await login('admin@turboscribe.local', 'admin123');
    check('login admin OK', admin.status === 200 && !!admin.token);
    const regular = await login('pedro.leon23@gmail.com', 'user123');
    check('login usuário comum OK', regular.status === 200 && !!regular.token);

    // Autorização
    let r = await api('POST', '/api/admin/users', { body: { name: 'X', email: 'x@x.com', password: '123456' } });
    check('POST sem token → 401', r.status === 401, `got ${r.status}`);
    r = await api('POST', '/api/admin/users', { token: regular.token, body: { name: 'X', email: 'x@x.com', password: '123456' } });
    check('POST com token de user → 403', r.status === 403, `got ${r.status}`);

    // Validações de criação
    r = await api('POST', '/api/admin/users', { token: admin.token, body: { name: 'Sem Email', email: 'nao-e-email', password: '123456' } });
    check('e-mail inválido → 400', r.status === 400, `got ${r.status}`);
    r = await api('POST', '/api/admin/users', { token: admin.token, body: { name: 'Senha Curta', email: 'curto@ex.com', password: '123' } });
    check('senha < 6 → 400', r.status === 400, `got ${r.status}`);
    r = await api('POST', '/api/admin/users', { token: admin.token, body: { name: 'Role Estranha', email: 'role@ex.com', password: '123456', role: 'super' } });
    check('role inválida → 400', r.status === 400, `got ${r.status}`);

    // Criação válida + duplicata
    r = await api('POST', '/api/admin/users', { token: admin.token, body: { name: 'Usuario Teste', email: 'teste@ex.com', password: 'senha123', role: 'user' } });
    check('criar usuário → 200', r.status === 200 && r.data?.success === true, `got ${r.status} ${JSON.stringify(r.data)}`);
    r = await api('POST', '/api/admin/users', { token: admin.token, body: { name: 'Duplicata', email: 'teste@ex.com', password: 'senha123' } });
    check('e-mail duplicado → 409', r.status === 409, `got ${r.status}`);

    // Login imediato do novo usuário
    const novo = await login('teste@ex.com', 'senha123');
    check('novo usuário loga imediatamente', novo.status === 200 && !!novo.token, `got ${novo.status}`);

    // Lista não vaza senha
    r = await api('GET', '/api/admin/users', { token: admin.token });
    check('lista usuários → 200', r.status === 200 && Array.isArray(r.data));
    check('lista não contém password_hash', r.data.every(u => !('password_hash' in u)));

    // Edição de role, status e reset de senha
    const novoId = novo.user?.id;
    check('token do novo usuário carrega id', !!novoId);

    r = await api('PUT', `/api/admin/users/${novoId}`, { token: admin.token, body: { role: 'admin' } });
    check('promover a admin → 200', r.status === 200, `got ${r.status}`);
    const meAfter = await api('GET', '/api/auth/me', { token: novo.token });
    check('role promovida refletida no /auth/me', meAfter.data?.user?.role === 'admin', `got ${meAfter.data?.user?.role}`);

    r = await api('PUT', `/api/admin/users/${admin.user.id}`, { token: admin.token, body: { role: 'user' } });
    check('auto-rebaixamento → 400', r.status === 400, `got ${r.status}`);
    r = await api('PUT', `/api/admin/users/${admin.user.id}`, { token: admin.token, body: { status: 'suspended' } });
    check('auto-suspensão → 400', r.status === 400, `got ${r.status}`);
    r = await api('PUT', '/api/admin/users/id-inexistente', { token: admin.token, body: { role: 'user' } });
    check('usuário inexistente → 404', r.status === 404, `got ${r.status}`);
    r = await api('PUT', `/api/admin/users/${novoId}`, { token: admin.token, body: { status: 'banido' } });
    check('status inválido → 400', r.status === 400, `got ${r.status}`);

    r = await api('PUT', `/api/admin/users/${novoId}`, { token: admin.token, body: { password: 'nova123456' } });
    check('reset de senha → 200', r.status === 200, `got ${r.status}`);
    const oldLogin = await login('teste@ex.com', 'senha123');
    check('login com senha antiga → 401', oldLogin.status === 401, `got ${oldLogin.status}`);
    const newLogin = await login('teste@ex.com', 'nova123456');
    check('login com nova senha → 200', newLogin.status === 200, `got ${newLogin.status}`);
    r = await api('PUT', `/api/admin/users/${novoId}`, { token: admin.token, body: { password: '123' } });
    check('reset com senha curta → 400', r.status === 400, `got ${r.status}`);

    r = await api('PUT', `/api/admin/users/${novoId}`, { token: admin.token, body: { daily_limit: -5 } });
    check('limite diário negativo → 400', r.status === 400, `got ${r.status}`);
    r = await api('PUT', `/api/admin/users/${novoId}`, { token: admin.token, body: { daily_limit: 10 } });
    check('limite diário válido → 200', r.status === 200, `got ${r.status}`);
  } catch (e) {
    failed++;
    console.error('ERRO INESPERADO:', e);
  } finally {
    server?.kill();
    try { fs.unlinkSync(DB); } catch (_) { /* já removido */ }
  }

  console.log(`\n${passed} PASS / ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
})();
