const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const secrets = require('./services/secrets');
const { getJobSignal } = require('./services/job-context');

// T-08 fase 2 — driver swap. DB_DRIVER=sqlite (default, produção atual) ou
// DB_DRIVER=postgres (service `db` do compose). A camada de acesso abaixo
// traduz o dialeto (? → $n, booleans) para o resto do app continuar igual;
// rollback = voltar DB_DRIVER=sqlite apontando pro arquivo antigo.
const DRIVER = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
const isPostgres = DRIVER === 'postgres';
const { PG_DDL } = require('./scripts/migrate-sqlite-to-postgres');

// ---------------------------------------------------------------------------
// Conexão por driver
// ---------------------------------------------------------------------------
let db;          // sqlite3.Database (driver sqlite)
let pool;        // pg.Pool (driver postgres)

function pgConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST || 'db',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'transcreveai',
    password: process.env.PGPASSWORD || 'transcreveai_local_dev',
    database: process.env.PGDATABASE || 'transcreveai',
  };
}

if (isPostgres) {
  const { Pool } = require('pg');
  pool = new Pool({ ...pgConfig(), max: parseInt(process.env.PGPOOL_MAX || '10', 10) });
  pool.on('error', (err) => console.error('Erro inesperado no pool PostgreSQL:', err.message));
  console.log('Driver PostgreSQL ativo:', JSON.stringify({ host: pgConfig().host, database: pgConfig().database }));
} else {
  const sqlite3 = require('sqlite3').verbose();
  // DB_PATH (env) permite isolar o banco em testes que sobem um segundo servidor
  // (incidente T-19: duas instâncias disputando o mesmo SQLite). Fora de testes,
  // nao definir — usa o turboscribe.sqlite padrao do diretorio do projeto.
  const dbPath = process.env.DB_PATH || path.join(__dirname, 'turboscribe.sqlite');
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Erro ao conectar ao banco de dados SQLite:', err.message);
    } else {
      console.log('Conectado ao banco de dados SQLite local:', dbPath);
    }
  });
  db.configure('busyTimeout', 5000);
}

// ---------------------------------------------------------------------------
// Tradução de dialeto (apenas driver postgres)
// ---------------------------------------------------------------------------
// ? → $1..$n, ignorando ? dentro de strings ('...') e identificadores ("...").
// O SQL do projeto não usa '' escapado dentro de literal nem operadores ?|/?&,
// então a varredura simples cobre 100% das queries existentes.
function toPgPlaceholders(sql) {
  let out = '', n = 0, inStr = false, inId = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inStr) { out += c; if (c === "'") inStr = false; continue; }
    if (inId) { out += c; if (c === '"') inId = false; continue; }
    if (c === "'") { inStr = true; out += c; continue; }
    if (c === '"') { inId = true; out += c; continue; }
    if (c === '?') { out += '$' + (++n); continue; }
    out += c;
  }
  return out;
}

// Booleans: o pg aceita JS boolean nativo; o node-sqlite3 não — converte p/ 1/0.
// SQL deve usar os literais TRUE/FALSE (válidos nos dois dialetos modernos).
function normalizeParams(params = []) {
  if (isPostgres) return params;
  return params.map(p => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

// ---------------------------------------------------------------------------
// Helpers de exec em Promise — mesma API para os dois drivers
// ---------------------------------------------------------------------------
function runAsync(sql, params = []) {
  if (isPostgres) {
    return new Promise((resolve, reject) => {
      const signal = getJobSignal();
      if (signal?.aborted) return reject(signal.reason);
      pool.query(toPgPlaceholders(sql), normalizeParams(params))
        .then(r => resolve({ changes: r.rowCount, lastID: null }))
        .catch(reject);
    });
  }
  return new Promise((resolve, reject) => {
    const signal = getJobSignal();
    if (signal?.aborted) return reject(signal.reason);
    db.run(sql, normalizeParams(params), function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  if (isPostgres) {
    return new Promise((resolve, reject) => {
      const signal = getJobSignal();
      if (signal?.aborted) return reject(signal.reason);
      pool.query(toPgPlaceholders(sql), normalizeParams(params))
        .then(r => resolve(r.rows[0] || null))
        .catch(reject);
    });
  }
  return new Promise((resolve, reject) => {
    const signal = getJobSignal();
    if (signal?.aborted) return reject(signal.reason);
    db.get(sql, normalizeParams(params), (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  if (isPostgres) {
    return new Promise((resolve, reject) => {
      const signal = getJobSignal();
      if (signal?.aborted) return reject(signal.reason);
      pool.query(toPgPlaceholders(sql), normalizeParams(params))
        .then(r => resolve(r.rows))
        .catch(reject);
    });
  }
  return new Promise((resolve, reject) => {
    const signal = getJobSignal();
    if (signal?.aborted) return reject(signal.reason);
    db.all(sql, normalizeParams(params), (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// ---------------------------------------------------------------------------
// Inicializar Esquema de Tabelas
// ---------------------------------------------------------------------------
async function initDatabase() {
  if (isPostgres) return initDatabasePostgres();
  return initDatabaseSqlite();
}

// ---- SQLite (legado, padrão) ----
async function initDatabaseSqlite() {
  // 25/09: journal_mode=DELETE (era WAL). O banco vive em bind-mount Windows
  // (Docker Desktop gRPC-FUSE), onde WAL+mmap corrompe a imagem em shutdown
  // abrupto — causou o incidente SQLITE_CORRUPT de 25/09. Em DELETE mode as
  // escritas são sequenciais e o fs tolera; busy_timeout protege os readers
  // durante o lock do writer. A migração do banco para volume nomeado
  // (WAL-safe) fica como task de infra.
  await runAsync('PRAGMA journal_mode=DELETE');
  await runAsync('PRAGMA busy_timeout=5000');
  try {
    // 0. Migração de Folders para Projects se necessário
    const foldersTableExists = await getAsync(`SELECT name FROM sqlite_master WHERE type='table' AND name='folders'`);
    if (foldersTableExists) {
      console.log('Migrando tabela "folders" para "projects"...');
      await runAsync(`ALTER TABLE folders RENAME TO projects`);
    }

    const transcriptionsTableExists = await getAsync(`SELECT name FROM sqlite_master WHERE type='table' AND name='transcriptions'`);
    if (transcriptionsTableExists) {
      const columns = await allAsync(`PRAGMA table_info(transcriptions)`);
      const hasFolderId = columns.some(col => col.name === 'folder_id');
      if (hasFolderId) {
        console.log('Renomeando coluna "folder_id" para "project_id" em "transcriptions"...');
        await runAsync(`ALTER TABLE transcriptions RENAME COLUMN folder_id TO project_id`);
      }

      const hasProgress = columns.some(col => col.name === 'progress');
      if (!hasProgress) {
        console.log('Adicionando coluna "progress" na tabela "transcriptions"...');
        await runAsync(`ALTER TABLE transcriptions ADD COLUMN progress INTEGER DEFAULT 0`);
      }

      const hasErrorMessage = columns.some(col => col.name === 'error_message');
      if (!hasErrorMessage) {
        console.log('Adicionando coluna "error_message" na tabela "transcriptions"...');
        await runAsync(`ALTER TABLE transcriptions ADD COLUMN error_message TEXT`);
      }

      const hasAiSummary = columns.some(col => col.name === 'ai_summary');
      if (!hasAiSummary) {
        console.log('Adicionando coluna "ai_summary" na tabela "transcriptions"...');
        await runAsync(`ALTER TABLE transcriptions ADD COLUMN ai_summary TEXT`);
      }

      const hasStage = columns.some(col => col.name === 'stage');
      if (!hasStage) {
        console.log('Adicionando coluna "stage" na tabela "transcriptions"...');
        await runAsync(`ALTER TABLE transcriptions ADD COLUMN stage TEXT`);
      }
    }
  } catch (err) {
    console.error('Erro durante a migração do banco de dados:', err.message);
    throw err;
  }

  {
    // 1. Tabela de Usuários
    await runAsync(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        daily_limit INTEGER DEFAULT 3,
        status TEXT DEFAULT 'active',
        plan TEXT DEFAULT 'gratuito',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // T-09: coluna de plano/assinatura em bancos legados (SQLite).
    const userColumns = await allAsync(`PRAGMA table_info(users)`);
    if (!userColumns.some(col => col.name === 'plan')) {
      console.log('Adicionando coluna "plan" na tabela "users"...');
      await runAsync(`ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'gratuito'`);
    }

    // 2. Tabela de Chaves de API
    await runAsync(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT,
        key_value TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Tabela de Configurações Globais
    await runAsync(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // 4. Tabela de Logs do Sistema
    await runAsync(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        action TEXT NOT NULL,
        details TEXT,
        ip_address TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 5. Tabela de Projetos
    await runAsync(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // 6. Tabela de Transcrições
    await runAsync(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        duration_seconds REAL DEFAULT 0,
        language TEXT DEFAULT 'pt',
        mode TEXT DEFAULT 'max',
        status TEXT DEFAULT 'completed',
        raw_text TEXT,
        speaker_diarization INTEGER DEFAULT 0,
        progress INTEGER DEFAULT 0,
        error_message TEXT,
        ai_summary TEXT,
        stage TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
      )
    `);

    // 7. Tabela de Segmentos da Transcrição
    await runAsync(`
      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY,
        transcription_id TEXT NOT NULL,
        speaker TEXT,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        text TEXT NOT NULL,
        FOREIGN KEY(transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
      )
    `);

    // 7. Blocos de audio de uma transcricao longa: cada bloco e a unidade de
    //    trabalho persistida, o que permite paralelismo, retry e retomada.
    await runAsync(`
      CREATE TABLE IF NOT EXISTS transcription_chunks (
        id TEXT PRIMARY KEY,
        transcription_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        offset_sec REAL NOT NULL,
        duration_sec REAL NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        model_used TEXT,
        segments_json TEXT,
        error TEXT,
        started_at DATETIME,
        finished_at DATETIME,
        FOREIGN KEY(transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
      )
    `);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_chunks_transcription ON transcription_chunks(transcription_id, idx)`);

    // 7b. T-20: idioma detectado pelo Whisper em cada bloco (language='auto').
    const chunkColumns = await allAsync('PRAGMA table_info(transcription_chunks)');
    if (!chunkColumns.some(col => col.name === 'detected_language')) {
      console.log('Adicionando coluna "detected_language" na tabela "transcription_chunks"...');
      await runAsync(`ALTER TABLE transcription_chunks ADD COLUMN detected_language TEXT`);
    }

    // 8. T-18: Análises/aprimoramentos de IA por transcrição (histórico: N por transcrição)
    await runAsync(`
      CREATE TABLE IF NOT EXISTS ai_analyses (
        id TEXT PRIMARY KEY,
        transcription_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'enhance',
        model TEXT,
        prompt_used TEXT,
        glossary_used TEXT,
        result_md TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost_usd REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(transcription_id) REFERENCES transcriptions(id) ON DELETE CASCADE
      )
    `);
    await runAsync(`CREATE INDEX IF NOT EXISTS idx_analyses_transcription ON ai_analyses(transcription_id, created_at)`);

    // 8b. T-25: JEV — veredicto do juiz de validação por aprimoramento
    const analysisColumns = await allAsync('PRAGMA table_info(ai_analyses)');
    if (!analysisColumns.some(col => col.name === 'judge_model')) {
      console.log('Adicionando colunas do JEV na tabela "ai_analyses"...');
      await runAsync(`ALTER TABLE ai_analyses ADD COLUMN judge_model TEXT`);
      await runAsync(`ALTER TABLE ai_analyses ADD COLUMN judge_approved INTEGER`);
      await runAsync(`ALTER TABLE ai_analyses ADD COLUMN judge_feedback TEXT`);
      await runAsync(`ALTER TABLE ai_analyses ADD COLUMN attempts INTEGER DEFAULT 1`);
    }

    // 9. T-18: Dicionário de correções (glossário) aplicado no aprimoramento
    await runAsync(`
      CREATE TABLE IF NOT EXISTS glossary (
        id TEXT PRIMARY KEY,
        wrong TEXT NOT NULL,
        correct TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const workerColumns = await allAsync('PRAGMA table_info(transcriptions)');
    for (const [name, type] of [['worker_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['worker_started_at', 'DATETIME']]) {
      if (!workerColumns.some(column => column.name === name)) await runAsync('ALTER TABLE transcriptions ADD COLUMN ' + name + ' ' + type);
    }
    await runAsync('CREATE INDEX IF NOT EXISTS idx_transcriptions_queue ON transcriptions(status, created_at)');

    // 10. T-28: tokens de confirmação de e-mail do auto-cadastro
    await runAsync(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Tabelas SQLite verificadas/criadas com sucesso.');

    await seedCoreData();
  }
}

// ---- PostgreSQL (T-08 fase 2) ----
async function initDatabasePostgres() {
  // DDL espelha o schema SQLite (PG_DDL, fonte única compartilhada com o ETL
  // da fase 1). As migrações imperativas do SQLite (PRAGMA, sqlite_master,
  // ALTER ADD COLUMN) não se aplicam: o Postgres sobe com o schema completo.
  await runAsync(PG_DDL);
  // T-09: PG_DDL é CREATE TABLE IF NOT EXISTS — não altera tabelas já
  // existentes. Garante a coluna users.plan em bancos PostgreSQL legados.
  const pgUserCols = await allAsync(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'plan'`
  );
  if (!pgUserCols.length) {
    console.log('Adicionando coluna "plan" na tabela "users" (PostgreSQL)...');
    await runAsync(`ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'gratuito'`);
  }
  console.log('Tabelas PostgreSQL verificadas/criadas com sucesso.');
  await seedCoreData();
}

// Seeds compartilhados pelos dois drivers (idempotentes).
async function seedCoreData() {
  // Seed Admin Padrão
  const adminUser = await getAsync(`SELECT * FROM users WHERE email = ?`, ['admin@turboscribe.local']);
  if (!adminUser) {
    const adminId = uuidv4();
    const passHash = await bcrypt.hash('admin123', 10);
    await runAsync(
      `INSERT INTO users (id, name, email, password_hash, role, daily_limit, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [adminId, 'Administrador SaaS', 'admin@turboscribe.local', passHash, 'admin', 999999, 'active']
    );
    console.log('Usuário Admin criado: admin@turboscribe.local / admin123');

    // Seed Usuário Padrão de Demonstração
    const userId = uuidv4();
    const userPassHash = await bcrypt.hash('user123', 10);
    await runAsync(
      `INSERT INTO users (id, name, email, password_hash, role, daily_limit, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, 'Pedro León', 'pedro.leon23@gmail.com', userPassHash, 'user', 3, 'active']
    );
    console.log('Usuário Demo criado: pedro.leon23@gmail.com / user123');
  }

  // Garantir que transcrições legado (admin-local) pertençam ao usuário principal (Pedro León)
  const defaultUser = await getAsync(`SELECT id FROM users WHERE email = ?`, ['pedro.leon23@gmail.com']);
  if (defaultUser) {
    await runAsync(`UPDATE transcriptions SET user_id = ? WHERE user_id = 'admin-local' OR user_id IS NULL`, [defaultUser.id]);
    await runAsync(`UPDATE projects SET user_id = ? WHERE user_id = 'admin-local' OR user_id IS NULL`, [defaultUser.id]);
  }

  // Colunas de verificacao da chave (resultado do ultimo teste contra a OpenRouter)
  if (!isPostgres) {
    const keyCols = await allAsync(`PRAGMA table_info(api_keys)`);
    for (const [col, type] of [['last_check_at', 'DATETIME'], ['last_check_ok', 'INTEGER'], ['last_check_info', 'TEXT']]) {
      if (!keyCols.some(c => c.name === col)) {
        await runAsync(`ALTER TABLE api_keys ADD COLUMN ${col} ${type}`);
      }
    }
  }

  // Migracao: chaves gravadas em texto puro passam a ser cifradas in-place.
  const plainKeys = await allAsync(`SELECT id, key_value FROM api_keys WHERE key_value != '' AND key_value NOT LIKE 'enc:v1:%'`);
  for (const k of plainKeys) {
    await runAsync(`UPDATE api_keys SET key_value = ? WHERE id = ?`, [secrets.encrypt(k.key_value), k.id]);
  }
  if (plainKeys.length) console.log(`[secrets] ${plainKeys.length} chave(s) de API cifrada(s) em repouso.`);
  await runAsync(`DELETE FROM api_keys WHERE key_value = ''`);

  // Seed unico a partir do .env: so quando ainda nao ha chave no banco.
  // Depois disso o banco (cifrado) e a fonte de verdade; o .env pode ficar sem a chave.
  const openrouterKey = await getAsync(`SELECT id FROM api_keys WHERE provider = 'openrouter'`);
  const envKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!openrouterKey && envKey) {
    await runAsync(
      `INSERT INTO api_keys (id, provider, name, key_value, is_active) VALUES (?, ?, ?, ?, TRUE)`,
      [uuidv4(), 'openrouter', 'Chave Principal OpenRouter', secrets.encrypt(envKey)]
    );
    console.log('Chave de API OpenRouter importada do .env e cifrada. O .env pode ficar sem OPENROUTER_API_KEY a partir de agora.');
  }

  // Seed Configurações Globais
  const defaultSettings = [
    { key: 'max_file_size_mb', value: '5120' },
    { key: 'max_duration_hours', value: '10' },
    { key: 'default_language', value: 'pt' },
    { key: 'base_model', value: 'openai/whisper-1' },
    { key: 'pro_model', value: 'openai/whisper-large-v3-turbo' },
    { key: 'max_model', value: 'openai/whisper-large-v3' },
    { key: 'base_enabled', value: 'true' },
    { key: 'pro_enabled', value: 'true' },
    { key: 'max_enabled', value: 'true' },
    { key: 'analysis_model', value: 'openai/gpt-4o-mini' },
    { key: 'analysis_prompt', value: '' }
  ];

  // T-16: migração idempotente — renomeia chaves antigas (chita/golfinho/baleia)
  // preservando valores customizados pelo admin, e migra o modo das transcrições legadas.
  const keyRenames = [
    { old: 'chita_model', next: 'base_model' },
    { old: 'golfinho_model', next: 'pro_model' },
    { old: 'baleia_model', next: 'max_model' },
    { old: 'chita_enabled', next: 'base_enabled' },
    { old: 'golfinho_enabled', next: 'pro_enabled' },
    { old: 'baleia_enabled', next: 'max_enabled' }
  ];
  for (const { old, next } of keyRenames) {
    const legacy = await getAsync(`SELECT value FROM system_settings WHERE key = ?`, [old]);
    const current = await getAsync(`SELECT value FROM system_settings WHERE key = ?`, [next]);
    if (legacy && !current) {
      await runAsync(`INSERT INTO system_settings (key, value) VALUES (?, ?)`, [next, legacy.value]);
    }
    if (legacy) {
      await runAsync(`DELETE FROM system_settings WHERE key = ?`, [old]);
    }
  }
  const modeRenames = [
    { old: 'chita', next: 'base' },
    { old: 'golfinho', next: 'pro' },
    { old: 'baleia', next: 'max' }
  ];
  for (const { old, next } of modeRenames) {
    await runAsync(`UPDATE transcriptions SET mode = ? WHERE mode = ?`, [next, old]);
  }

  for (const setting of defaultSettings) {
    const existing = await getAsync(`SELECT * FROM system_settings WHERE key = ?`, [setting.key]);
    if (!existing) {
      await runAsync(`INSERT INTO system_settings (key, value) VALUES (?, ?)`, [setting.key, setting.value]);
    } else if (setting.key.endsWith('_model')) {
      await runAsync(`UPDATE system_settings SET value = ? WHERE key = ?`, [setting.value, setting.key]);
    }
  }
}

// Log Auditoria Helper
async function logAction(userId, action, details, ipAddress = '127.0.0.1') {
  try {
    await runAsync(
      `INSERT INTO system_logs (id, user_id, action, details, ip_address) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), userId || null, action, JSON.stringify(details), ipAddress]
    );
  } catch (e) {
    console.error('Erro ao gravar log do sistema:', e.message);
  }
}

module.exports = {
  db: isPostgres ? pool : db,
  isPostgres,
  pgPool: isPostgres ? pool : null,
  runAsync,
  getAsync,
  allAsync,
  initDatabase,
  logAction
};
