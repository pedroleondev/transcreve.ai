require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const { initDatabase, runAsync, getAsync, allAsync, logAction, isPostgres } = require('./db');
const { transcribeAudioFile, generateChatCompletion, runAnalysisChat, translateTranscript, getAvailableOpenRouterModels, testOpenRouterKey } = require('./services/openrouter');
const { isValidLanguage } = require('./services/languages');
const { smtpConfigured, sendVerificationEmail } = require('./services/mailer');
const { DEFAULT_ENHANCE_SYSTEM_PROMPT, buildEnhanceUserContent, splitTextIntoChunks, PROMPT_VERSION } = require('./services/prompts');
const { enhanceWithJudge } = require('./services/judge');
const secrets = require('./services/secrets');
const { queuePositionSql } = require('./services/queue');
const { saveTranscriptSegments } = require('./services/transcript-editor');
const { generateTXT, generateSRT, generateVTT, generateDOCX, generatePDF } = require('./services/exporter');
const archiver = require('archiver');
const { probeMedia } = require('./services/audio');
const { downloadFromUrl } = require('./services/urlfetch');
const { startQueueWorker, getJobProgress, retryFailedChunks } = require('./services/pipeline');
const billing = require('./services/billing');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'turboscribe_super_secret_jwt_key_2026';
const isProduction = process.env.NODE_ENV === 'production';

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'turboscribe_super_secret_jwt_key_2026')) {
  console.error('ERRO CRÍTICO: JWT_SECRET não definido ou usando valor padrão em ambiente de produção (NODE_ENV=production).');
  process.exit(1);
}

// T-27 (Asaas): em produção o webhook de cobrança precisa de token; em
// self-host local o operador define BILLING_STRICT=false para desenvolver
// sem o Asaas configurado (mesmo padrão do check de JWT acima).
if (process.env.NODE_ENV === 'production' &&
    !process.env.ASAAS_WEBHOOK_TOKEN &&
    process.env.BILLING_STRICT !== 'false') {
  console.error('ERRO CRÍTICO: ASAAS_WEBHOOK_TOKEN não definido em produção. Configure-o (e ASAAS_API_KEY) ou defina BILLING_STRICT=false para rodar localmente sem cobrança.');
  process.exit(1);
}

// Configuração do Upload de Áudios/Vídeos
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const MAX_FILES_PER_UPLOAD = Number(process.env.MAX_FILES_PER_UPLOAD || 50);

// T-07: limite de tamanho e de duração vivem em system_settings (admin edita
// no painel e vale na hora, sem restart). O env é apenas fallback.
async function getLimitSettings() {
  const rows = await allAsync(
    `SELECT key, value FROM system_settings WHERE key IN ('max_file_size_mb', 'max_duration_hours')`
  );
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // Valor '0' é VÁLIDO (bloqueia tudo): presença da chave decide, não o valor > 0.
  const rawMb = map.max_file_size_mb;
  const mb = (rawMb !== undefined && rawMb !== null && String(rawMb).trim() !== '' && !Number.isNaN(Number(rawMb)))
    ? Number(rawMb)
    : Number(process.env.MAX_UPLOAD_GB || 5) * 1024;
  const rawHours = map.max_duration_hours;
  const hours = (rawHours !== undefined && rawHours !== null && String(rawHours).trim() !== '' && !Number.isNaN(Number(rawHours)))
    ? Number(rawHours)
    : Number(process.env.MAX_AUDIO_HOURS || 10);
  return { maxFileSizeMb: mb, maxDurationHours: hours };
}

// Multer montado por request: o fileSize vem do settings ATUAL do admin.
function uploadWithDynamicLimits(req, res, next) {
  getLimitSettings()
    .then(({ maxFileSizeMb }) => {
      res.locals.maxFileSizeMb = maxFileSizeMb;
      multer({
        storage,
        limits: { fileSize: maxFileSizeMb * 1024 * 1024, files: MAX_FILES_PER_UPLOAD }
      }).array('files')(req, res, next);
    })
    .catch(next);
}

// T-07: estado da cota do usuário. daily_limit lido do banco a cada request
// (mesma filosofia do role/status no authenticateToken). Admin e contas com
// daily_limit >= 999999 são ilimitadas.
async function getQuotaState(userId) {
  const user = await getAsync(`SELECT role, daily_limit FROM users WHERE id = ?`, [userId]);
  if (!user) return null;
  const limit = Number(user.daily_limit);
  if (user.role === 'admin' || limit >= 999999) {
    return { exempt: true, used: 0, limit: limit || 999999 };
  }
  // T-08: datetime('now','-24 hours') é SQLite-only — cutoff calculado em JS
  // no formato 'YYYY-MM-DD HH:MM:SS' (comparável lexicamente no SQLite e
  // coercível a TIMESTAMP no Postgres).
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const row = await getAsync(
    `SELECT COUNT(*) AS n FROM transcriptions WHERE user_id = ? AND created_at >= ?`,
    [userId, cutoff]
  );
  return { exempt: false, used: row ? Number(row.n) : 0, limit };
}

// Middleware: recusa 429 antes mesmo de aceitar os bytes do upload.
async function checkDailyQuota(req, res, next) {
  try {
    const quota = await getQuotaState(req.user.id);
    if (quota && !quota.exempt && quota.used >= quota.limit) {
      return res.status(429).json({
        success: false,
        error: `Limite diário atingido: ${quota.used} de ${quota.limit} transcrições nas últimas 24 h. Tente novamente mais tarde ou fale com o administrador.`
      });
    }
    next();
  } catch (e) { next(e); }
}

// Multer aborta a requisicao inteira ao estourar um limite; traduz para JSON claro.
function uploadErrorHandler(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) return next(err);
  const maxMb = res.locals.maxFileSizeMb ?? Number(process.env.MAX_UPLOAD_GB || 5) * 1024;
  const map = {
    LIMIT_FILE_SIZE: [413, `Arquivo maior que o limite de ${maxMb} MB.`],
    LIMIT_FILE_COUNT: [400, `No maximo ${MAX_FILES_PER_UPLOAD} arquivos por envio.`],
    LIMIT_UNEXPECTED_FILE: [400, `Campo de arquivo inesperado: use "files".`]
  };
  const [status, message] = map[err.code] || [400, err.message];
  res.status(status).json({ success: false, error: message, code: err.code });
}

// Middlewares
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Desabilitar Cache do Navegador para desenvolvimento/atualizações dinâmicas
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// T-02: /uploads deixou de ser estático público. Cada áudio só é servido ao
// dono (admin precisa de ?all=true, como nas rotas de dados). O player usa
// ?token= porque <audio> não envia header Authorization. Nome sanitizado com
// path.basename para não sair do diretório de uploads.
app.get('/uploads/:file', authenticateToken, async (req, res) => {
  try {
    const fileName = path.basename(req.params.file);
    const row = await getAsync('SELECT user_id FROM transcriptions WHERE file_path = ?', ['/uploads/' + fileName]);
    const all = req.user.role === 'admin' && req.query.all === 'true';
    if (!row || (!all && row.user_id !== req.user.id)) {
      return res.status(404).send('Arquivo não encontrado.');
    }
    res.sendFile(path.join(uploadsDir, fileName));
  } catch (e) {
    res.status(500).send('Erro ao servir arquivo.');
  }
});

// Estáticos explícitos: o diretório do projeto NÃO é publicado como um todo.
// (com express.static(__dirname), /turboscribe.sqlite, /.env e o próprio
// server.js ficavam baixáveis por qualquer cliente sem autenticação)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
// T-29 F1: tokens Obsidian Wave (CSS estático seguro, mesma política dos demais)
app.get('/tokens.css', (req, res) => res.sendFile(path.join(__dirname, 'tokens.css')));
// T-20: lista canônica de idiomas do Whisper — usada pelo backend (validação)
// e pelo frontend (select do modal de upload). UMD, mesmo arquivo.
app.get('/languages.js', (req, res) => res.sendFile(path.join(__dirname, 'services', 'languages.js')));

// Middleware de Autenticação JWT
// Aceita Authorization: Bearer <token> (API/padrão) ou ?token= (elementos de
// mídia como <audio>, que não enviam header — T-02).
//
// VALIDAÇÃO DE CONTA A CADA REQUEST (25/09): após verificar a assinatura do
// JWT, o middleware lê role/status FRESH do banco. Sem isso, um usuário
// suspenso (T-23) continuava usando a API normal até o token expirar (30d),
// e um usuário promovido a admin só ganhava o escopo ampliado após novo
// login. Suspenso ou deletado = 403 imediato, em qualquer rota.
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || (typeof req.query.token === 'string' ? req.query.token : null);

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token de autenticação não fornecido.' });
  }

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.status(403).json({ error: 'Sessão inválida ou expirada.' });
    try {
      const row = await getAsync(`SELECT role, status FROM users WHERE id = ?`, [user.id]);
      if (!row) return res.status(403).json({ error: 'Conta não encontrada.' });
      if (row.status !== 'active') {
        return res.status(403).json({ error: 'Conta suspensa. Contate o administrador.' });
      }
      req.user = { ...user, role: row.role };
      next();
    } catch (e) {
      res.status(500).json({ error: 'Falha ao validar sessão.' });
    }
  });
}

// Middleware de Verificação de Admin. O role JÁ vem fresco do banco via
// authenticateToken (que também garante status='active'), então aqui basta
// conferir o papel — sem nova query.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Acesso restrito a Administradores do SaaS.' });
  }
}

// T-02 — Isolamento multi-tenant.
// Escopo do usuário autenticado: admin só enxerga tudo com ?all=true EXPLÍCITO;
// qualquer outro usuário enxerga apenas o que é seu. Acesso a recurso alheio
// responde 404 (não 403) — não revela nem a existência do recurso.
function scopeOf(req) {
  return { userId: req.user.id, all: req.user.role === 'admin' && req.query.all === 'true' };
}

// Resolve a transcrição se — e somente se — existir E pertencer ao escopo.
async function ownedTranscription(id, scope) {
  const row = await getAsync('SELECT id, user_id, status FROM transcriptions WHERE id = ?', [id]);
  if (!row || (!scope.all && row.user_id !== scope.userId)) return null;
  return row;
}

// Inicializar Banco de Dados
secrets.loadMasterKey(); // em producao, recusa subir sem APP_SECRET_KEY
const databaseReady = initDatabase();

// ----------------------------------------------------
// ROTAS DE AUTENTICAÇÃO
// ----------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await getAsync(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    if (user.status === 'pending_verification') {
      return res.status(403).json({ error: 'Conta aguardando confirmação de e-mail. Verifique sua caixa de entrada (e o spam) ou solicite um novo link de confirmação.' });
    }
    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Conta suspensa pelo Administrador.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    await logAction(user.id, 'LOGIN', { email: user.email }, req.ip);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        daily_limit: user.daily_limit,
        plan: user.plan || 'gratuito'
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await getAsync(`SELECT id, name, email, role, daily_limit, status, plan, cpf_cnpj, created_at FROM users WHERE email = ? OR id = ?`, [req.user.email, req.user.id]);
    if (!user) {
      return res.json({ user: req.user });
    }
    // T-07: consumo do dia para a UI exibir "X de Y transcrições hoje".
    const quota = await getQuotaState(user.id);
    res.json({
      user: {
        ...user,
        used_today: quota ? quota.used : 0,
        quota_unlimited: quota ? quota.exempt : true
      }
    });
  } catch (e) {
    res.json({ user: req.user });
  }
});

// ----------------------------------------------------
// AUTO-CADASTRO + CONFIRMAÇÃO DE E-MAIL (T-28)
// ----------------------------------------------------

// Rate limit em memória por IP (instância única — suficiente para o deploy
// atual em um container). Janela deslizante de 10 min.
const rateBuckets = new Map();
function rateLimit(key, maxHits, windowMs) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= maxHits) { rateBuckets.set(key, hits); return false; }
  hits.push(now);
  rateBuckets.set(key, hits);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (!v.some(t => now - t < 10 * 60 * 1000)) rateBuckets.delete(k);
}, 5 * 60 * 1000).unref();

const REGISTER_WINDOW_MS = 10 * 60 * 1000;
const REGISTER_MAX_PER_IP = 5;
const RESEND_MAX_PER_IP = 5;
const VERIFY_TOKEN_TTL_MS = 30 * 60 * 1000;

function validRegisterPassword(pw) {
  // Regra explícita (aceite T-28): mín. 8 caracteres, com letra e número.
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 128) return 'A senha deve ter entre 8 e 128 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'A senha deve conter pelo menos uma letra e um número.';
  return null;
}

async function issueVerificationToken(userId) {
  const token = uuidv4() + uuidv4(); // 72 chars aleatórios
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_MS).toISOString().replace('T', ' ').slice(0, 19);
  await runAsync(
    `INSERT INTO email_verifications (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)`,
    [uuidv4(), userId, token, expiresAt]
  );
  return token;
}

// POST /api/auth/register — cadastro público. Conta nasce 'pending_verification'
// e só vira 'active' via POST /api/auth/confirm. Sem SMTP em produção → 503.
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 120);
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanName) return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) return res.status(400).json({ error: 'E-mail inválido.' });
  const pwError = validRegisterPassword(password);
  if (pwError) return res.status(400).json({ error: pwError });
  // Rate limit só DEPOIS da validação: request malformada não gasta a cota do IP.
  if (!rateLimit(`register:${req.ip}`, REGISTER_MAX_PER_IP, REGISTER_WINDOW_MS)) {
    return res.status(429).json({ error: 'Muitas tentativas de cadastro. Aguarde alguns minutos e tente novamente.' });
  }
  // Aceite T-28: sem SMTP em produção o cadastro público fica DESABILITADO
  // (503 explícito). Escape hatch deliberado p/ self-host local: definir
  // REGISTRATION_REQUIRES_SMTP=false — o link vai para o log do servidor
  // (modo dev do services/mailer.js). A conta SEMPRE exige confirmação do token.
  if (isProduction && !smtpConfigured() && process.env.REGISTRATION_REQUIRES_SMTP !== 'false') {
    return res.status(503).json({ error: 'Cadastro indisponível no momento: envio de e-mail não configurado pelo administrador.' });
  }

  try {
    const existing = await getAsync(`SELECT id, status FROM users WHERE email = ?`, [cleanEmail]);
    if (existing) {
      // 409 claro (aceite), sem revelar mais nada sobre a conta.
      return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
    }
    const userId = uuidv4();
    const passHash = await bcrypt.hash(password, 10);
    await runAsync(
      `INSERT INTO users (id, name, email, password_hash, role, daily_limit, status, plan) VALUES (?, ?, ?, ?, 'user', 3, 'pending_verification', 'gratuito')`,
      [userId, cleanName, cleanEmail, passHash]
    );
    const token = await issueVerificationToken(userId);
    const { delivered } = await sendVerificationEmail(cleanEmail, cleanName, token);
    await logAction(userId, 'REGISTERED', { email: cleanEmail, email_delivered: delivered }, req.ip);
    res.status(201).json({
      ok: true,
      email_delivered: delivered,
      message: delivered
        ? 'Conta criada! Confirme seu e-mail para ativar.'
        : 'Conta criada! Enviamos o link de confirmação (modo desenvolvimento: veja o log do servidor).'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/confirm — ativa a conta com o token do e-mail (uso único, 30 min).
app.post('/api/auth/confirm', async (req, res) => {
  const token = String((req.body || {}).token || '').trim();
  if (!token) return res.status(400).json({ error: 'Token é obrigatório.' });
  try {
    const row = await getAsync(`SELECT * FROM email_verifications WHERE token = ?`, [token]);
    if (!row) return res.status(400).json({ error: 'Link de confirmação inválido.' });
    if (row.used_at) return res.status(400).json({ error: 'Este link já foi utilizado. Faça login ou solicite um novo.' });
    // Cross-driver: Postgres devolve TIMESTAMP como Date; SQLite, como string.
    const expiresAt = row.expires_at instanceof Date
      ? row.expires_at
      : new Date(String(row.expires_at).replace(' ', 'T') + 'Z');
    if (expiresAt < new Date()) {
      return res.status(400).json({ error: 'Link expirado (válido por 30 minutos). Solicite um novo.' });
    }
    await runAsync(`UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
    await runAsync(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'pending_verification'`, [row.user_id]);
    await logAction(row.user_id, 'EMAIL_CONFIRMED', null, req.ip);
    res.json({ ok: true, message: 'E-mail confirmado! Sua conta está ativa — faça login.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/resend — novo link de confirmação (resposta uniforme para
// não vazar quais e-mails existem).
app.post('/api/auth/resend', async (req, res) => {
  if (!rateLimit(`resend:${req.ip}`, RESEND_MAX_PER_IP, REGISTER_WINDOW_MS)) {
    return res.status(429).json({ error: 'Muitas solicitações. Aguarde alguns minutos.' });
  }
  const cleanEmail = String((req.body || {}).email || '').trim().toLowerCase();
  try {
    const user = await getAsync(`SELECT id, name, email, status FROM users WHERE email = ?`, [cleanEmail]);
    const uniform = 'Se a conta estiver aguardando confirmação, um novo link será enviado.';
    if (!user || user.status !== 'pending_verification') return res.json({ ok: true, message: uniform });
    if (isProduction && !smtpConfigured() && process.env.REGISTRATION_REQUIRES_SMTP !== 'false') return res.json({ ok: true, message: uniform });
    const token = await issueVerificationToken(user.id);
    await sendVerificationEmail(user.email, user.name, token);
    res.json({ ok: true, message: uniform });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/public/metrics — números REAIS e agregados para a landing
// (aceite: só publicar o que é medido; nada de métrica inventada).
app.get('/api/public/metrics', async (req, res) => {
  try {
    const t = await getAsync(`SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS secs FROM transcriptions WHERE status IN ('completed','completed_with_errors')`);
    const u = await getAsync(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`);
    res.json({
      transcriptions_completed: Number(t.n),
      audio_hours: Math.round((Number(t.secs) / 3600) * 10) / 10,
      active_users: Number(u.n)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// ROTAS DA PÁGINA DE CONTA (T-09)
// ----------------------------------------------------
// Perfil: o usuário edita o próprio nome (e-mail e papel são imutáveis aqui).
app.put('/api/account', authenticateToken, async (req, res) => {
  const { name, cpf_cnpj } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }
  const clean = String(name).trim().slice(0, 120);
  // T-27: CPF/CNPJ opcional no perfil, obrigatório só na hora de assinar
  // (validação de formato aqui; a exigência do Asaas é tratada no billing).
  let cpf = null;
  if (cpf_cnpj !== undefined && cpf_cnpj !== null && String(cpf_cnpj).trim() !== '') {
    cpf = String(cpf_cnpj).replace(/\D/g, '');
    if (cpf.length !== 11 && cpf.length !== 14) {
      return res.status(400).json({ error: 'CPF/CNPJ inválido — use 11 dígitos (CPF) ou 14 (CNPJ).' });
    }
  }
  try {
    if (cpf !== null) {
      await runAsync(`UPDATE users SET name = ?, cpf_cnpj = ? WHERE id = ?`, [clean, cpf, req.user.id]);
    } else {
      await runAsync(`UPDATE users SET name = ? WHERE id = ?`, [clean, req.user.id]);
    }
    await logAction(req.user.id, 'PROFILE_UPDATED', { name: clean, cpf: cpf ? 'informado' : undefined }, req.ip);
    res.json({ ok: true, name: clean, cpf_cnpj: cpf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Troca de senha exigindo a senha atual — também é o "esqueci a senha" do
// usuário logado (decisão de 01/10: fluxo por e-mail fica para a T-28, que
// trará SMTP/confirmação de e-mail; enquanto isso, logado, ele se resolve sozinho).
app.put('/api/auth/password', authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
  }
  if (String(new_password).length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres.' });
  }
  try {
    const user = await getAsync(`SELECT id, password_hash FROM users WHERE id = ?`, [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const match = await bcrypt.compare(String(current_password), user.password_hash);
    if (!match) {
      await logAction(req.user.id, 'PASSWORD_CHANGE_FAILED', null, req.ip);
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }
    const hash = await bcrypt.hash(String(new_password), 10);
    await runAsync(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.user.id]);
    await logAction(req.user.id, 'PASSWORD_CHANGED', null, req.ip);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Assinatura: espelho honesto do plano local + assinatura Asaas (T-27) quando existir.
app.get('/api/account/subscription', authenticateToken, async (req, res) => {
  try {
    const user = await getAsync(`SELECT plan, status, daily_limit, role, created_at FROM users WHERE id = ?`, [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const quota = await getQuotaState(req.user.id);
    const sub = await getAsync(
      `SELECT asaas_subscription_id, plan, cycle, status, current_period_end, created_at
         FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC`,
      [req.user.id]
    );
    const asaasActive = sub && ['pending', 'active', 'overdue'].includes(sub.status);
    res.json({
      plan: user.plan || 'gratuito',
      status: user.status,
      billing: asaasActive ? 'asaas' : 'local',
      subscription: asaasActive ? {
        plan: sub.plan,
        cycle: sub.cycle,
        status: sub.status,
        renews_at: sub.current_period_end || null
      } : null,
      quota: {
        used_today: quota ? quota.used : 0,
        limit: quota ? quota.limit : null,
        unlimited: quota ? quota.exempt : false
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// T-27 (Asaas): webhook público de cobrança. O Asaas manda o token no header
// `asaas-access-token` (não assina o payload). Sempre respondemos 200 para
// eventos reconhecidos/ignorados — a idempotência do handler garante que
// reentregas do mesmo evento não duplicam efeito.
app.post('/api/webhooks/asaas', express.json({ type: '*/*' }), async (req, res) => {
  try {
    if (!billing.verifyWebhookToken(req.get('asaas-access-token'))) {
      return res.status(401).json({ error: 'Token de webhook inválido.' });
    }
    const result = await billing.handleWebhook(req.body || {});
    if (result.ok) {
      await logAction(null, 'ASAAS_WEBHOOK', { event: req.body.event, effect: result.effect }, req.ip);
    } else {
      console.log(`[Asaas] evento ignorado: ${req.body && req.body.event} — ${result.reason}`);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[Asaas] erro no webhook:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// T-27 (Asaas): criar assinatura. Devolve a URL da 1ª fatura (PIX/boleto/cartão)
// para o frontend abrir em nova aba.
app.post('/api/account/subscribe', authenticateToken, async (req, res) => {
  if (!billing.billingEnabled()) return res.status(503).json({ error: 'Cobrança não configurada no servidor.' });
  const { plan, cycle } = req.body || {};
  try {
    const me = await getAsync(`SELECT id, name, email, cpf_cnpj FROM users WHERE id = ?`, [req.user.id]);
    if (!me) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const result = await billing.createSubscription(me, plan, cycle === 'annual' ? 'annual' : 'monthly');
    await logAction(req.user.id, 'SUBSCRIPTION_CREATED', { plan: result.plan, cycle: result.cycle }, req.ip);
    res.json({ invoice_url: result.invoiceUrl, plan: result.plan, cycle: result.cycle });
  } catch (e) {
    res.status(e.statusHint || 500).json({ error: e.message });
  }
});

// T-27 (Asaas): cancelar assinatura ativa e voltar ao plano gratuito.
app.post('/api/account/subscribe/cancel', authenticateToken, async (req, res) => {
  try {
    const me = await getAsync(`SELECT id, role FROM users WHERE id = ?`, [req.user.id]);
    if (!me) return res.status(404).json({ error: 'Usuário não encontrado.' });
    await billing.cancelSubscription(me);
    await logAction(req.user.id, 'SUBSCRIPTION_CANCELLED', null, req.ip);
    res.json({ ok: true, plan: 'gratuito' });
  } catch (e) {
    res.status(e.statusHint || 500).json({ error: e.message });
  }
});

// Logs de uso: transcrições recentes do próprio usuário com data, duração,
// modo e tokens consumidos pelas análises de IA (soma de ai_analyses).
app.get('/api/account/usage', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const items = await allAsync(
      `SELECT id, file_name, status, mode, language, duration_seconds, file_size, created_at
         FROM transcriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [req.user.id, limit]
    );
    const tokens = await allAsync(
      `SELECT transcription_id,
              COALESCE(SUM(tokens_in), 0) AS tokens_in,
              COALESCE(SUM(tokens_out), 0) AS tokens_out
         FROM ai_analyses WHERE transcription_id IN (SELECT id FROM transcriptions WHERE user_id = ?)
        GROUP BY transcription_id`,
      [req.user.id]
    );
    const tokenById = {};
    for (const t of tokens) tokenById[t.transcription_id] = Number(t.tokens_in) + Number(t.tokens_out);
    const recent = items.map(t => ({ ...t, ai_tokens: tokenById[t.id] || 0 }));
    const totals = await getAsync(
      `SELECT COUNT(*) AS total_transcriptions,
              COALESCE(SUM(duration_seconds), 0) AS total_seconds,
              COALESCE(SUM(file_size), 0) AS total_bytes
         FROM transcriptions WHERE user_id = ?`,
      [req.user.id]
    );
    const aiTotals = await getAsync(
      `SELECT COALESCE(SUM(a.tokens_in), 0) AS tokens_in, COALESCE(SUM(a.tokens_out), 0) AS tokens_out
         FROM ai_analyses a
         JOIN transcriptions t ON t.id = a.transcription_id
        WHERE t.user_id = ?`,
      [req.user.id]
    );
    res.json({
      recent,
      totals: {
        total_transcriptions: Number(totals.total_transcriptions),
        total_seconds: Number(totals.total_seconds),
        total_bytes: Number(totals.total_bytes),
        ai_tokens_in: Number(aiTotals.tokens_in),
        ai_tokens_out: Number(aiTotals.tokens_out)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// ROTAS DE PROJETOS (PROJECTS)
// ----------------------------------------------------
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    let sql = `SELECT p.*, COUNT(t.id) as file_count FROM projects p LEFT JOIN transcriptions t ON p.id = t.project_id`;
    const params = [];
    if (!scope.all) {
      sql += ` WHERE p.user_id = ?`;
      params.push(scope.userId);
    }
    sql += ` GROUP BY p.id ORDER BY p.created_at ASC`;
    const projects = await allAsync(sql, params);
    res.json(projects);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects', authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome do projeto é obrigatório.' });

  try {
    const projectId = uuidv4();
    await runAsync(`INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)`, [projectId, req.user.id, name]);
    await logAction(req.user.id, 'PROJECT_CREATED', { name }, req.ip);
    res.json({ id: projectId, name, file_count: 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    const row = await getAsync('SELECT user_id FROM projects WHERE id = ?', [req.params.id]);
    if (!row || (!scope.all && row.user_id !== scope.userId)) {
      return res.status(404).json({ error: 'Projeto não encontrado.' });
    }
    await runAsync(`DELETE FROM projects WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// ROTAS DE TRANSCRIÇÃO (CLIENT)
// ----------------------------------------------------
app.get('/api/transcriptions', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    const { project_id, search } = req.query;
    let sql = `SELECT t.*, ${queuePositionSql} AS queue_position, p.name as project_name FROM transcriptions t LEFT JOIN projects p ON t.project_id = p.id WHERE 1=1`;
    const params = [];

    if (!scope.all) {
      sql += ` AND t.user_id = ?`;
      params.push(scope.userId);
    }

    if (project_id === 'uncategorized') {
      sql += ` AND t.project_id IS NULL`;
    } else if (project_id) {
      sql += ` AND t.project_id = ?`;
      params.push(project_id);
    }

    if (search) {
      sql += ` AND (t.file_name LIKE ? OR t.raw_text LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY t.created_at DESC`;
    const transcriptions = await allAsync(sql, params);
    res.json(transcriptions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/transcriptions/:id', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    const transcription = await getAsync(
      `SELECT t.*, p.name as project_name FROM transcriptions t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?`,
      [req.params.id]
    );

    if (!transcription || (!scope.all && transcription.user_id !== scope.userId)) {
      return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }

    const segments = await allAsync(
      `SELECT * FROM segments WHERE transcription_id = ? ORDER BY start_time ASC`,
      [req.params.id]
    );

    res.json({ ...transcription, segments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint para obter modelos OpenRouter com taxas e nível de precisão
app.get('/api/openrouter/models', (req, res) => {
  res.json(getAvailableOpenRouterModels());
});

// Upload & Processamento de Transcrição (Assíncrono)
app.post('/api/transcribe', authenticateToken, checkDailyQuota, uploadWithDynamicLimits, uploadErrorHandler, async (req, res) => {
  const { mode: rawMode = 'max', model_id = null, project_id = null, speaker_diarization = false, ai_focus = null } = req.body;

  // T-20: idioma padrão é 'auto' (detecção automática pelo Whisper). Códigos
  // válidos vêm da lista canônica em services/languages.js; qualquer outro
  // valor é rejeitado com 400 antes de tocar em arquivo.
  const rawLanguage = String(req.body.language || 'auto').toLowerCase();
  const language = rawLanguage === 'auto' ? 'auto' : rawLanguage;
  if (language !== 'auto' && !isValidLanguage(language)) {
    return res.status(400).json({ error: `Idioma inválido: '${req.body.language}'. Use 'auto' ou um código ISO-639-1 da lista (ex.: pt, en, es, ja).` });
  }

  // T-16: aliases legados (chita/golfinho/baleia) aceitos por uma versão, com aviso de deprecação
  const LEGACY_MODE_ALIASES = { chita: 'base', golfinho: 'pro', baleia: 'max' };
  let mode = rawMode;
  if (LEGACY_MODE_ALIASES[rawMode]) {
    console.warn(`[T-16] Modo legado '${rawMode}' recebido em /api/transcribe; use '${LEGACY_MODE_ALIASES[rawMode]}'. Alias será removido na próxima versão.`);
    mode = LEGACY_MODE_ALIASES[rawMode];
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  // T-07: lote não pode estourar a cota restante (o pre-check já recusou
  // quem está no limite; aqui cobre "faltam 1, veio 3"). Arquivos aceitos no
  // multer são apagados antes de recusar.
  const quota = await getQuotaState(req.user.id);
  if (quota && !quota.exempt && quota.used + req.files.length > quota.limit) {
    await Promise.all(req.files.map(f => fs.promises.unlink(f.path).catch(() => {})));
    return res.status(429).json({
      success: false,
      error: `Limite diário: restam ${Math.max(quota.limit - quota.used, 0)} de ${quota.limit} transcrições nas últimas 24 h e você enviou ${req.files.length} arquivo(s).`
    });
  }

  const { maxDurationHours } = await getLimitSettings();
  const results = [];
  const errors = [];
  const effectiveModel = model_id || mode;

  // Valida cada arquivo com ffprobe ANTES de enfileirar: um invalido nao derruba os outros.
  for (const file of req.files) {
    const reject = async (message) => {
      errors.push({ file_name: file.originalname, error: message });
      await fs.promises.unlink(file.path).catch(() => {});
    };
    try {
      let probe;
      try {
        probe = await probeMedia(file.path);
      } catch (e) {
        await reject('Arquivo nao reconhecido como audio/video (ffprobe falhou).');
        continue;
      }
      if (!probe.hasAudio) {
        await reject('O arquivo nao contem trilha de audio.');
        continue;
      }
      if (probe.duration > maxDurationHours * 3600) {
        await reject(`Duracao de ${(probe.duration / 3600).toFixed(1)} h excede o limite de ${maxDurationHours} h.`);
        continue;
      }

      const transcriptionId = uuidv4();
      const relativePath = '/uploads/' + file.filename;

      await runAsync(
        `INSERT INTO transcriptions (id, user_id, project_id, file_name, file_path, file_size, duration_seconds, language, mode, status, raw_text, speaker_diarization, progress, ai_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          transcriptionId,
          req.user.id || 'admin-local',
          project_id || null,
          file.originalname,
          relativePath,
          file.size,
          probe.duration,
          language,
          effectiveModel,
          'pending',
          '',
          speaker_diarization === true || speaker_diarization === 'true',
          0,
          ai_focus || null
        ]
      );

      results.push({ id: transcriptionId, file_name: file.originalname, status: 'pending', progress: 0, duration_seconds: probe.duration });
    } catch (err) {
      console.error('Erro ao registrar áudio para transcrição na fila:', err);
      await reject(err.message);
    }
  }

  if (results.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Nenhum arquivo valido para transcrever.',
      errors
    });
  }

  res.status(202).json({ success: true, count: results.length, data: results, errors });
});

// T-11: transcrever a partir de um link (YouTube/Vimeo ou URL direta de
// arquivo de áudio/vídeo). Baixa para uploads/, passa pelo mesmo ffprobe e
// segue o fluxo normal da fila — mesmos limites de tamanho/duração da T-07.
// Falha de download NÃO gera texto fictício: vira linha 'failed' com
// error_message específico (visível na lista do usuário).
app.post('/api/transcribe/url', authenticateToken, checkDailyQuota, async (req, res) => {
  const { url, mode: rawMode = 'max', model_id = null, project_id = null, speaker_diarization = false, ai_focus = null } = req.body || {};
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return res.status(400).json({ success: false, error: 'Informe o link para transcrever.' });

  const rawLanguage = String(req.body.language || 'auto').toLowerCase();
  const language = rawLanguage === 'auto' ? 'auto' : rawLanguage;
  if (language !== 'auto' && !isValidLanguage(language)) {
    return res.status(400).json({ error: `Idioma inválido: '${req.body.language}'. Use 'auto' ou um código ISO-639-1 da lista (ex.: pt, en, es, ja).` });
  }
  const LEGACY_MODE_ALIASES = { chita: 'base', golfinho: 'pro', baleia: 'max' };
  let mode = rawMode;
  if (LEGACY_MODE_ALIASES[rawMode]) mode = LEGACY_MODE_ALIASES[rawMode];
  const effectiveModel = model_id || mode;

  // T-07: 1 link = 1 transcrição; respeita a cota restante.
  const quota = await getQuotaState(req.user.id);
  if (quota && !quota.exempt && quota.used + 1 > quota.limit) {
    return res.status(429).json({ success: false, error: `Limite diário atingido: ${quota.used} de ${quota.limit} transcrições nas últimas 24 h.` });
  }

  const { maxFileSizeMb, maxDurationHours } = await getLimitSettings();
  const displayName = rawUrl; // fallback; troca pelo título/nome real quando baixa
  const transcriptionId = uuidv4();

  let downloaded;
  try {
    downloaded = await downloadFromUrl(rawUrl, uploadsDir, maxFileSizeMb * 1024 * 1024);
  } catch (e) {
    // Erro de VALIDAÇÃO da URL (domínio não suportado, URL inválida, host
    // bloqueado) é 400 direto, sem criar linha — nada foi tentado.
    if (e.statusHint === 400) {
      return res.status(400).json({ success: false, error: e.message, errors: [{ file_name: rawUrl, error: e.message }] });
    }
    // Aceite T-11: falha de download/link privado -> linha 'failed' com causa.
    await runAsync(
      `INSERT INTO transcriptions (id, user_id, project_id, file_name, file_path, file_size, duration_seconds, language, mode, status, raw_text, speaker_diarization, progress, ai_summary, error_message)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, 'failed', '', ?, 0, ?, ?)`,
      [transcriptionId, req.user.id || 'admin-local', project_id || null, displayName, '', language, effectiveModel, speaker_diarization === true || speaker_diarization === 'true', ai_focus || null, e.message]
    );
    await logAction(req.user.id, 'URL_DOWNLOAD_FAILED', { url: rawUrl, error: e.message }, req.ip);
    return res.status(202).json({
      success: true, count: 1,
      data: [{ id: transcriptionId, file_name: displayName, status: 'failed', progress: 0, duration_seconds: 0, error_message: e.message }],
      errors: [{ file_name: displayName, error: e.message }]
    });
  }

  // Mesma validação de mídia do upload: ffprobe antes de enfileirar.
  let probe;
  try {
    probe = await probeMedia(downloaded.filePath);
  } catch (_) {
    await fs.promises.unlink(downloaded.filePath).catch(() => {});
    return res.status(400).json({ success: false, error: 'O conteúdo do link não foi reconhecido como áudio/vídeo (ffprobe falhou).', errors: [{ file_name: rawUrl }] });
  }
  if (!probe.hasAudio) {
    await fs.promises.unlink(downloaded.filePath).catch(() => {});
    return res.status(400).json({ success: false, error: 'O conteúdo do link não contém trilha de áudio.', errors: [{ file_name: rawUrl }] });
  }
  if (probe.duration > maxDurationHours * 3600) {
    await fs.promises.unlink(downloaded.filePath).catch(() => {});
    return res.status(400).json({ success: false, error: `Duração de ${(probe.duration / 3600).toFixed(1)} h excede o limite de ${maxDurationHours} h.`, errors: [{ file_name: rawUrl }] });
  }

  const relativePath = '/uploads/' + path.basename(downloaded.filePath);
  await runAsync(
    `INSERT INTO transcriptions (id, user_id, project_id, file_name, file_path, file_size, duration_seconds, language, mode, status, raw_text, speaker_diarization, progress, ai_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, 0, ?)`,
    [transcriptionId, req.user.id || 'admin-local', project_id || null, downloaded.fileName, relativePath, downloaded.size, probe.duration, language, effectiveModel, speaker_diarization === true || speaker_diarization === 'true', ai_focus || null]
  );
  await logAction(req.user.id, 'URL_QUEUED', { url: rawUrl, file: downloaded.fileName }, req.ip);
  res.status(202).json({ success: true, count: 1, data: [{ id: transcriptionId, file_name: downloaded.fileName, status: 'pending', progress: 0, duration_seconds: probe.duration }], errors: [] });
});

// Reprocessa so os blocos que falharam (job em completed_with_errors ou failed)
app.post('/api/transcriptions/:id/retry', authenticateToken, async (req, res) => {
  try {
    const row = await ownedTranscription(req.params.id, scopeOf(req));
    if (!row) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    if (!['failed', 'completed_with_errors'].includes(row.status)) return res.status(409).json({error: 'O job nao esta disponivel para reprocessamento.'});
    const reset = await retryFailedChunks(row.id);
    if (reset === 0 && row.status === 'failed') {
      // Falhou antes de fatiar (ex.: ffmpeg): recomeca do zero
      await runAsync(`UPDATE transcriptions SET status = 'pending', error_message = NULL, progress = 0, worker_attempts = 0, worker_started_at = NULL WHERE id = ?`, [row.id]);
    }
    res.json({ success: true, chunks_reset: reset });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Atualizar nome / mover pasta
app.put('/api/transcriptions/:id', authenticateToken, async (req, res) => {
  const { file_name, project_id, raw_text, segments } = req.body;
  const scope = scopeOf(req);
  const owned = await ownedTranscription(req.params.id, scope);
  if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
  if (segments !== undefined) {
    try {
      if (file_name !== undefined || project_id !== undefined) return res.status(400).json({ error: 'Salve os metadados separadamente da edicao dos segmentos.' });
      return res.json(await saveTranscriptSegments(req.params.id, segments));
    } catch (error) {
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'Nao foi possivel salvar a transcricao.' });
    }
  }
  try {
    if (file_name !== undefined) {
      await runAsync(`UPDATE transcriptions SET file_name = ? WHERE id = ?`, [file_name, req.params.id]);
    }
    if (project_id !== undefined) {
      await runAsync(`UPDATE transcriptions SET project_id = ? WHERE id = ?`, [project_id || null, req.params.id]);
    }
    if (raw_text !== undefined) {
      await runAsync(`UPDATE transcriptions SET raw_text = ? WHERE id = ?`, [raw_text, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Excluir transcrição
app.delete('/api/transcriptions/:id', authenticateToken, async (req, res) => {
  try {
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    await runAsync(`DELETE FROM transcriptions WHERE id = ?`, [req.params.id]);
    await runAsync(`DELETE FROM segments WHERE transcription_id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// EXPORTAÇÃO MULTI-FORMATO (PDF, DOCX, TXT, SRT, VTT)
// ----------------------------------------------------
app.get('/api/export/:id/:format', authenticateToken, async (req, res) => {
  const { id, format } = req.params;
  const includeTimestamps = req.query.timestamps === 'true';

  try {
    const scope = scopeOf(req);
    const transcription = await getAsync(`SELECT * FROM transcriptions WHERE id = ?`, [id]);
    if (!transcription || (!scope.all && transcription.user_id !== scope.userId)) {
      return res.status(404).send('Transcrição não encontrada.');
    }

    const segments = await allAsync(`SELECT * FROM segments WHERE transcription_id = ? ORDER BY start_time ASC`, [id]);
    const baseName = transcription.file_name.replace(/\.[^/.]+$/, '');

    switch (format.toLowerCase()) {
      case 'txt':
        const txtData = generateTXT(transcription, segments, includeTimestamps);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.txt"`);
        return res.send(txtData);

      case 'srt':
        const srtData = generateSRT(segments);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.srt"`);
        return res.send(srtData);

      case 'vtt':
        const vttData = generateVTT(segments);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.vtt"`);
        return res.send(vttData);

      case 'docx':
        const docxBuffer = await generateDOCX(transcription, segments, includeTimestamps);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.docx"`);
        return res.send(docxBuffer);

      case 'pdf':
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
        return generatePDF(transcription, segments, includeTimestamps, (err, pdfBuffer) => {
          if (err) return res.status(500).send('Erro ao gerar PDF');
          res.send(pdfBuffer);
        });

      default:
        return res.status(400).send('Formato de exportação não suportado.');
    }
  } catch (e) {
    res.status(500).send('Erro ao exportar arquivo: ' + e.message);
  }
});

// ----------------------------------------------------
// T-13 — ÁUDIO ORIGINAL AUTENTICADO
// Mesma política de escopo do resto do sistema: dono ou admin com ?all=true;
// recurso alheio responde 404. Suporte a Range (206) para seek de players.
// ----------------------------------------------------
app.get('/api/transcriptions/:id/audio', authenticateToken, async (req, res) => {
  try {
    const scope = scopeOf(req);
    const transcription = await getAsync(
      `SELECT id, user_id, file_name, file_path FROM transcriptions WHERE id = ?`,
      [req.params.id]
    );
    if (!transcription || (!scope.all && transcription.user_id !== scope.userId)) {
      return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }

    const fileName = path.basename(transcription.file_path || '');
    const fullPath = path.join(uploadsDir, fileName);
    if (!fileName || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Arquivo de áudio não encontrado no servidor.' });
    }

    const stat = fs.statSync(fullPath);
    const encodedName = encodeURIComponent(transcription.file_name || fileName);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');

    const range = req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      end = Math.min(end, stat.size - 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(fullPath, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', stat.size);
    return fs.createReadStream(fullPath).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// T-13 — EXPORTAÇÃO EM MASSA (ZIP)
// Reusa os exporters existentes; item inválido/alheio vira linha em _erros.txt
// e NÃO aborta o restante do lote.
// ----------------------------------------------------
const EXPORT_FORMATS = ['txt', 'srt', 'vtt', 'docx', 'pdf'];
const BULK_EXPORT_MAX_ITEMS = 100;

// Gera o buffer de um único item num formato (reuso dos exporters de exporter.js).
function renderExportBuffer(format, transcription, segments, includeTimestamps) {
  return new Promise((resolve, reject) => {
    switch (format) {
      case 'txt': return resolve(Buffer.from(generateTXT(transcription, segments, includeTimestamps), 'utf8'));
      case 'srt': return resolve(Buffer.from(generateSRT(segments), 'utf8'));
      case 'vtt': return resolve(Buffer.from(generateVTT(segments), 'utf8'));
      case 'docx': return generateDOCX(transcription, segments, includeTimestamps).then(resolve, reject);
      case 'pdf':
        return generatePDF(transcription, segments, includeTimestamps, (err, buf) =>
          err ? reject(err) : resolve(buf));
      default: return reject(new Error('Formato não suportado.'));
    }
  });
}

app.post('/api/export/bulk', authenticateToken, async (req, res) => {
  const { ids, format } = req.body || {};
  const fmt = String(format || '').toLowerCase();
  const includeTimestamps = req.body && req.body.include_timestamps === true;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos um id.' });
  }
  if (ids.length > BULK_EXPORT_MAX_ITEMS) {
    return res.status(400).json({ error: `Máximo de ${BULK_EXPORT_MAX_ITEMS} itens por exportação em massa.` });
  }
  if (!EXPORT_FORMATS.includes(fmt)) {
    return res.status(400).json({ error: 'Formato inválido. Use: ' + EXPORT_FORMATS.join(', ') });
  }

  try {
    const scope = scopeOf(req);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const errors = [];

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="transcreveai-${fmt}-${new Date().toISOString().slice(0, 10)}.zip"`
    );
    archive.on('error', () => { /* stream já em andamento; nada mais a responder */ });
    archive.pipe(res);

    const usedNames = new Set();
    for (const id of ids) {
      try {
        const t = await getAsync(`SELECT * FROM transcriptions WHERE id = ?`, [id]);
        if (!t || (!scope.all && t.user_id !== scope.userId)) {
          errors.push(`${id}: não encontrada ou sem permissão.`);
          continue;
        }
        const segments = await allAsync(
          `SELECT * FROM segments WHERE transcription_id = ? ORDER BY start_time ASC`, [id]);
        const buf = await renderExportBuffer(fmt, t, segments, includeTimestamps);

        const base = (t.file_name || id).replace(/\.[^/.]+$/, '');
        let name = `${base}.${fmt}`;
        let n = 1;
        while (usedNames.has(name)) name = `${base} (${n++}).${fmt}`;
        usedNames.add(name);
        archive.append(buf, { name });
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }

    if (errors.length) archive.append(errors.join('\n'), { name: '_erros.txt' });
    await archive.finalize();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// CHAT IA & TRADUÇÃO (OPENROUTER)
// ----------------------------------------------------
app.post('/api/chat', authenticateToken, async (req, res) => {
  const { transcript_text, prompt, transcription_id } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt é obrigatório.' });

  try {
    // T-02: quando o texto vem de uma transcrição, o dono precisa ser o usuário.
    if (transcription_id) {
      const owned = await ownedTranscription(transcription_id, scopeOf(req));
      if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }
    const answer = await generateChatCompletion(transcript_text || '', prompt);
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/translate', authenticateToken, async (req, res) => {
  const { transcript_text, target_language, transcription_id } = req.body;
  try {
    // T-02: idem — escopo por dono quando transcription_id é enviado.
    if (transcription_id) {
      const owned = await ownedTranscription(transcription_id, scopeOf(req));
      if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }
    const translatedText = await translateTranscript(transcript_text || '', target_language || 'English');
    res.json({ translatedText });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// T-18: APRIMORAMENTO DE TRANSCRIÇÃO POR IA (análise estruturada)
// System prompt e modelo configuráveis pelo admin; dicionário (glossary) aplicado.
// ----------------------------------------------------

// Lista os aprimoramentos de uma transcrição (mais recente primeiro)
app.get('/api/transcriptions/:id/analyses', authenticateToken, async (req, res) => {
  try {
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    const rows = await allAsync(
      `SELECT id, kind, model, prompt_used, glossary_used, result_md, tokens_in, tokens_out, cost_usd, created_at,
              judge_model, judge_approved, judge_feedback, attempts
       FROM ai_analyses WHERE transcription_id = ? ORDER BY created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Roda o aprimoramento: corrige palavras (dicionário), ortografia, concordância
// e estrutura o texto. Síncrono e em blocos para textos longos. Custo: tokens registrados.
app.post('/api/transcriptions/:id/enhance', authenticateToken, async (req, res) => {
  try {
    // T-02: recurso alheio → 404 (não 403), como nas demais rotas.
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) return res.status(404).json({ error: 'Transcrição não encontrada.' });
    const transcription = await getAsync(`SELECT * FROM transcriptions WHERE id = ?`, [req.params.id]);
    const sourceText = (transcription.raw_text || '').trim();
    if (!sourceText) return res.status(400).json({ error: 'Transcrição sem texto para aprimorar.' });

    const settings = await allAsync(`SELECT key, value FROM system_settings`);
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    const systemPrompt = (settingsMap.analysis_prompt || '').trim() || DEFAULT_ENHANCE_SYSTEM_PROMPT;
    const model = (settingsMap.analysis_model || '').trim() || 'openai/gpt-4o-mini';
    // T-25 (JEV): juiz de validação — modelos configuráveis no painel admin.
    // Desligado explicitamente com judge_enabled='0' (fluxo T-18 puro).
    const judgeEnabled = (settingsMap.judge_enabled || '1').trim() !== '0';
    const judgeModel = (settingsMap.judge_model || '').trim() || 'openai/gpt-4o-mini';

    const glossary = await allAsync(`SELECT wrong, correct FROM glossary ORDER BY wrong`);
    const glossaryJson = JSON.stringify(glossary);

    const chunks = splitTextIntoChunks(sourceText, 12000).map((original, index) => ({
      index,
      original,
      userContent: buildEnhanceUserContent(original, glossary)
    }));

    // T-25: geração + validação do juiz (retry com feedback se reprovar).
    const generate = async (userContent) => runAnalysisChat({ systemPrompt, userContent, model });
    const { results, tokensIn, tokensOut, attempts, judge } = await enhanceWithJudge({
      chunks, generate, glossary, judgeModel, judgeEnabled
    });
    const resultText = results.join('\n\n');

    const analysisId = uuidv4();
    await runAsync(
      `INSERT INTO ai_analyses (id, transcription_id, kind, model, prompt_used, glossary_used, result_md, tokens_in, tokens_out, judge_model, judge_approved, judge_feedback, attempts, created_at)
       VALUES (?, ?, 'enhance', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [analysisId, req.params.id, model, systemPrompt, glossaryJson, resultText, tokensIn, tokensOut,
       judgeEnabled ? judgeModel : null, judge ? !!judge.approved : null,
       judge && judge.issues.length ? JSON.stringify(judge.issues) : null, attempts]
    );
    res.json({ success: true, analysis: { id: analysisId, model, result_md: resultText, tokens_in: tokensIn, tokens_out: tokensOut, prompt_version: PROMPT_VERSION, attempts, judge } });
  } catch (e) {
    console.error('[T-18 Enhance Error]', e);
    // Sem texto inventado: falha de API/LLM retorna erro explícito, nada é persistido.
    res.status(502).json({ error: 'Falha ao aprimorar com IA: ' + e.message });
  }
});

// Dicionário de correções (glossário) — CRUD admin
app.get('/api/glossary', authenticateToken, async (req, res) => {
  try {
    const rows = await allAsync(`SELECT id, wrong, correct FROM glossary ORDER BY wrong`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/glossary', authenticateToken, requireAdmin, async (req, res) => {
  const { wrong, correct } = req.body || {};
  if (!wrong || !correct || !String(wrong).trim() || !String(correct).trim()) {
    return res.status(400).json({ error: 'Informe a forma errada e a forma correta.' });
  }
  try {
    const existing = await getAsync(`SELECT id FROM glossary WHERE wrong = ?`, [String(wrong).trim().toLowerCase()]);
    if (existing) return res.status(409).json({ error: 'Esse termo já existe no dicionário.' });
    const id = uuidv4();
    await runAsync(`INSERT INTO glossary (id, wrong, correct) VALUES (?, ?, ?)`, [id, String(wrong).trim().toLowerCase(), String(correct).trim()]);
    await logAction(req.user.id, 'GLOSSARY_ADD', { wrong, correct }, req.ip);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/glossary/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await runAsync(`DELETE FROM glossary WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------------------------------------
// PAINEL DE ADMINISTRAÇÃO SAAS (ADMIN ROUTES)
// ----------------------------------------------------

// Métricas Gerais do SaaS
app.get('/api/admin/metrics', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userCount = await getAsync(`SELECT COUNT(*) as count FROM users`);
    const totalTranscriptions = await getAsync(`SELECT COUNT(*) as count, SUM(duration_seconds) as total_duration, SUM(file_size) as total_size FROM transcriptions`);
    const apiKeyCount = await getAsync(`SELECT COUNT(*) as count FROM api_keys WHERE is_active = TRUE`);
    const recentLogs = await allAsync(`SELECT l.*, u.email as user_email FROM system_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.timestamp DESC LIMIT 10`);

    res.json({
      users_total: userCount.count || 0,
      transcriptions_count: totalTranscriptions.count || 0,
      hours_transcribed: ((totalTranscriptions.total_duration || 0) / 3600).toFixed(1),
      storage_used_mb: ((totalTranscriptions.total_size || 0) / (1024 * 1024)).toFixed(1),
      active_api_keys: apiKeyCount.count || 0,
      smtp_configured: smtpConfigured(), // T-28: aviso explícito no admin quando o cadastro público estiver fechado
      recent_logs: recentLogs
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Gerenciamento de Usuários
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await allAsync(`SELECT id, name, email, role, daily_limit, status, created_at FROM users ORDER BY created_at DESC`);
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  const { name, email, password, role = 'user', daily_limit = 3 } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos obrigatórios.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Função inválida (use "user" ou "admin").' });

  try {
    const existing = await getAsync('SELECT id FROM users WHERE email = ?', [email]);
    if (existing) return res.status(409).json({ error: 'Já existe um usuário com este e-mail.' });

    const userId = uuidv4();
    const passHash = await bcrypt.hash(password, 10);
    await runAsync(
      `INSERT INTO users (id, name, email, password_hash, role, daily_limit, status) VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [userId, name, email, passHash, role, daily_limit]
    );
    await logAction(req.user.id, 'ADMIN_USER_CREATED', { created_email: email, role }, req.ip);
    res.json({ success: true, id: userId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { role, status, daily_limit, password } = req.body;
  try {
    const target = await getAsync('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const isSelf = req.params.id === req.user.id;

    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Função inválida (use "user" ou "admin").' });
      if (isSelf && role !== 'admin') return res.status(400).json({ error: 'Você não pode rebaixar a si mesmo.' });
      await runAsync(`UPDATE users SET role = ? WHERE id = ?`, [role, req.params.id]);
    }
    if (status !== undefined) {
      if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Status inválido (use "active" ou "suspended").' });
      if (isSelf && status !== 'active') return res.status(400).json({ error: 'Você não pode suspender a si mesmo.' });
      await runAsync(`UPDATE users SET status = ? WHERE id = ?`, [status, req.params.id]);
    }
    if (daily_limit !== undefined) {
      const limit = parseInt(daily_limit, 10);
      if (!Number.isInteger(limit) || limit < 0) return res.status(400).json({ error: 'Limite diário inválido.' });
      await runAsync(`UPDATE users SET daily_limit = ? WHERE id = ?`, [limit, req.params.id]);
    }
    if (password !== undefined && password !== '') {
      if (String(password).length < 6) return res.status(400).json({ error: 'A senha deve ter ao menos 6 caracteres.' });
      await runAsync(`UPDATE users SET password_hash = ? WHERE id = ?`, [await bcrypt.hash(String(password), 10), req.params.id]);
    }

    await logAction(req.user.id, 'ADMIN_USER_UPDATED', { target_user: req.params.id, role, status }, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Chaves de API (OpenRouter). A chave e cifrada em repouso (services/secrets.js)
// e NUNCA sai do servidor: as rotas devolvem so a versao mascarada.
// Salvar/trocar exige a senha do admin; 5 falhas em 10 min bloqueiam o IP.
// ---------------------------------------------------------------------------
const keyAuthFailures = new Map(); // ip -> [timestamps]
const KEY_AUTH_MAX_FAILURES = 5;
const KEY_AUTH_WINDOW_MS = 10 * 60 * 1000;

function keyAuthBlocked(ip) {
  const now = Date.now();
  const recent = (keyAuthFailures.get(ip) || []).filter(t => now - t < KEY_AUTH_WINDOW_MS);
  keyAuthFailures.set(ip, recent);
  return recent.length >= KEY_AUTH_MAX_FAILURES;
}

async function verifyAdminPassword(req, password) {
  if (!password) return false;
  // Somente o admin autenticado no token valida a PROPRIA senha.
  // Sem fallback para "qualquer outro admin" — senao a senha de um admin
  // validaria troca de chave feita por outro (ou por token forjado de role).
  if (!req.user || !req.user.id || req.user.id === 'admin-local') return false;
  const user = await getAsync(`SELECT password_hash FROM users WHERE id = ? AND role = 'admin' AND status = 'active'`, [req.user.id]);
  return user ? bcrypt.compare(password, user.password_hash) : false;
}

function publicKeyRow(k) {
  let masked = '';
  try { masked = secrets.mask(secrets.decrypt(k.key_value)); } catch (_) { masked = '(indecifravel — cadastre de novo)'; }
  return {
    id: k.id,
    provider: k.provider,
    name: k.name,
    is_active: k.is_active,
    created_at: k.created_at,
    masked_key: masked,
    last_check_at: k.last_check_at,
    last_check_ok: k.last_check_ok === null ? null : Boolean(k.last_check_ok),
    last_check_info: k.last_check_info ? JSON.parse(k.last_check_info) : null
  };
}

app.get('/api/admin/apikeys', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const keys = await allAsync(`SELECT * FROM api_keys ORDER BY created_at DESC`);
    res.json(keys.map(publicKeyRow));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Estado da chave ativa, para o indicador da sidebar (nunca inclui a chave).
app.get('/api/admin/apikeys/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const active = await getAsync(`SELECT * FROM api_keys WHERE provider = 'openrouter' AND is_active = TRUE LIMIT 1`);
    if (!active) return res.json({ configured: false });
    res.json({ configured: true, ...publicKeyRow(active) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Testa uma chave informada (sem salvar) ou, sem body, a chave ativa atual.
app.post('/api/admin/apikeys/test', authenticateToken, requireAdmin, async (req, res) => {
  try {
    let candidate = (req.body && req.body.key_value || '').trim();
    let activeId = null;
    if (!candidate) {
      const active = await getAsync(`SELECT id, key_value FROM api_keys WHERE provider = 'openrouter' AND is_active = TRUE LIMIT 1`);
      if (!active) return res.status(404).json({ valid: false, error: 'Nenhuma chave configurada.' });
      candidate = secrets.decrypt(active.key_value);
      activeId = active.id;
    }
    if (!/^sk-or-v1-/.test(candidate)) {
      return res.status(400).json({ valid: false, error: 'Formato invalido: a chave da OpenRouter comeca com sk-or-v1-.' });
    }
    const result = await testOpenRouterKey(candidate);
    if (activeId) {
      await runAsync(
        `UPDATE api_keys SET last_check_at = CURRENT_TIMESTAMP, last_check_ok = ?, last_check_info = ? WHERE id = ?`,
        [result.valid, JSON.stringify(result.info || { error: result.error }), activeId]
      );
    }
    res.status(result.valid ? 200 : 422).json({ valid: result.valid, info: result.info, error: result.error, masked_key: secrets.mask(candidate) });
  } catch (e) {
    res.status(500).json({ valid: false, error: e.message });
  }
});

app.post('/api/admin/apikeys', authenticateToken, requireAdmin, async (req, res) => {
  const { name, key_value, admin_password } = req.body || {};
  const ip = req.ip || '0.0.0.0';
  if (keyAuthBlocked(ip)) {
    return res.status(429).json({ error: 'Muitas tentativas com senha incorreta. Aguarde 10 minutos.' });
  }
  const candidate = String(key_value || '').trim();
  if (!/^sk-or-v1-/.test(candidate)) return res.status(400).json({ error: 'Formato invalido: a chave da OpenRouter comeca com sk-or-v1-.' });

  try {
    if (!(await verifyAdminPassword(req, admin_password))) {
      keyAuthFailures.set(ip, [...(keyAuthFailures.get(ip) || []), Date.now()]);
      await logAction(req.user.id, 'ADMIN_APIKEY_AUTH_FAILED', { ip }, ip);
      return res.status(401).json({ error: 'Senha do administrador incorreta.' });
    }
    const check = await testOpenRouterKey(candidate);
    if (!check.valid) {
      return res.status(422).json({ error: `A chave nao passou no teste: ${check.error}` });
    }
    keyAuthFailures.delete(ip);

    const keyId = uuidv4();
    await runAsync(`UPDATE api_keys SET is_active = FALSE WHERE provider = 'openrouter'`);
    await runAsync(
      `INSERT INTO api_keys (id, provider, name, key_value, is_active, last_check_at, last_check_ok, last_check_info)
       VALUES (?, 'openrouter', ?, ?, TRUE, CURRENT_TIMESTAMP, TRUE, ?)`,
      [keyId, name || 'Chave OpenRouter', secrets.encrypt(candidate), JSON.stringify(check.info)]
    );
    await logAction(req.user.id, 'ADMIN_APIKEY_ADDED', { name, masked: secrets.mask(candidate) }, ip);
    res.json({ success: true, id: keyId, masked_key: secrets.mask(candidate), info: check.info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/apikeys/:id/activate', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await runAsync(`UPDATE api_keys SET is_active = FALSE WHERE provider = 'openrouter'`);
    await runAsync(`UPDATE api_keys SET is_active = TRUE WHERE id = ?`, [req.params.id]);
    await logAction(req.user.id, 'ADMIN_APIKEY_ACTIVATED', { key_id: req.params.id }, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/apikeys/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await runAsync(`DELETE FROM api_keys WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logs do Sistema e Auditoria
app.get('/api/admin/logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const logs = await allAsync(
      `SELECT l.*, u.email as user_email FROM system_logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.timestamp DESC LIMIT 100`
    );
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Configurações Globais do SaaS (Públicas e Admin)
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await allAsync(`SELECT * FROM system_settings`);
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    // Flags públicas sem segredos: o frontend decide se mostra "Em breve" ou
    // os botões reais de assinatura (T-27) e de verificação de e-mail (T-09).
    settingsMap.billing_enabled = billing.billingEnabled();
    settingsMap.smtp_configured = smtpConfigured();
    res.json(settingsMap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const settings = await allAsync(`SELECT * FROM system_settings`);
    const settingsMap = {};
    settings.forEach(s => settingsMap[s.key] = s.value);
    res.json(settingsMap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/settings', authenticateToken, requireAdmin, async (req, res) => {
  const { settings } = req.body;
  try {
    for (const [key, value] of Object.entries(settings || {})) {
      // T-08: INSERT OR REPLACE é SQLite-only; o equivalente Postgres é ON CONFLICT.
      const upsertSql = isPostgres
        ? `INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
        : `INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)`;
      await runAsync(upsertSql, [key, String(value)]);
    }
    await logAction(req.user.id, 'ADMIN_SETTINGS_UPDATED', settings, req.ip);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint para obter progresso da transcrição
app.get('/api/transcriptions/:id/status', authenticateToken, async (req, res) => {
  try {
    const owned = await ownedTranscription(req.params.id, scopeOf(req));
    if (!owned) {
      return res.status(404).json({ error: 'Transcrição não encontrada.' });
    }
    const row = await getAsync(`SELECT status, stage, progress, error_message, ai_summary FROM transcriptions WHERE id = ?`, [req.params.id]);
    const chunks = await getJobProgress(req.params.id);
    res.json({
      success: true,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      error_message: row.error_message,
      ...chunks,
      ai_summary: row.status.startsWith('completed') ? row.ai_summary : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Iniciar Servidor Express
databaseReady.then(async () => {
  const queue = await startQueueWorker();
  const server = app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Servidor Falou.ai Local rodando na porta ${PORT}`);
  console.log(`🔗 Acesso local: http://localhost:${PORT}`);
  console.log(`🔑 Configure a chave OpenRouter em: sidebar → CONFIGURAR CHAVE`);
  console.log(`=======================================================`);
  });
  const shutdown = () => { server.close(); queue.stop().finally(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}).catch(error => { console.error('Falha ao iniciar servidor:', error.message); process.exit(1); });
