const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const secrets = require('./services/secrets');
const { getJobSignal } = require('./services/job-context');

const dbPath = path.join(__dirname, 'turboscribe.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados SQLite:', err.message);
  } else {
    console.log('Conectado ao banco de dados SQLite local:', dbPath);
  }
});

db.configure('busyTimeout', 5000);

// Helper de exec em Promise
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    const signal = getJobSignal();
    if (signal?.aborted) return reject(signal.reason);
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    const signal = getJobSignal();
    if (signal?.aborted) return reject(signal.reason);
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    const signal = getJobSignal();
    if (signal?.aborted) return reject(signal.reason);
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Inicializar Esquema de Tabelas
async function initDatabase() {
  await runAsync('PRAGMA journal_mode=WAL');
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
        mode TEXT DEFAULT 'golfinho',
        status TEXT DEFAULT 'completed',
        raw_text TEXT,
        speaker_diarization INTEGER DEFAULT 0,
        progress INTEGER DEFAULT 0,
        error_message TEXT,
        ai_summary TEXT,
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

    const workerColumns = await allAsync('PRAGMA table_info(transcriptions)');
    for (const [name, type] of [['worker_attempts', 'INTEGER NOT NULL DEFAULT 0'], ['worker_started_at', 'DATETIME']]) {
      if (!workerColumns.some(column => column.name === name)) await runAsync('ALTER TABLE transcriptions ADD COLUMN ' + name + ' ' + type);
    }
    await runAsync('CREATE INDEX IF NOT EXISTS idx_transcriptions_queue ON transcriptions(status, created_at)');
    console.log('Tabelas SQLite verificadas/criadas com sucesso.');

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
    const keyCols = await allAsync(`PRAGMA table_info(api_keys)`);
    for (const [col, type] of [['last_check_at', 'DATETIME'], ['last_check_ok', 'INTEGER'], ['last_check_info', 'TEXT']]) {
      if (!keyCols.some(c => c.name === col)) {
        await runAsync(`ALTER TABLE api_keys ADD COLUMN ${col} ${type}`);
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
        `INSERT INTO api_keys (id, provider, name, key_value, is_active) VALUES (?, ?, ?, ?, 1)`,
        [uuidv4(), 'openrouter', 'Chave Principal OpenRouter', secrets.encrypt(envKey)]
      );
      console.log('Chave de API OpenRouter importada do .env e cifrada. O .env pode ficar sem OPENROUTER_API_KEY a partir de agora.');
    }

    // Seed Configurações Globais
    const defaultSettings = [
      { key: 'max_file_size_mb', value: '5120' },
      { key: 'max_duration_hours', value: '10' },
      { key: 'default_language', value: 'pt' },
      { key: 'chita_model', value: 'openai/whisper-1' },
      { key: 'golfinho_model', value: 'openai/whisper-large-v3-turbo' },
      { key: 'baleia_model', value: 'openai/whisper-large-v3' },
      { key: 'chita_enabled', value: 'true' },
      { key: 'golfinho_enabled', value: 'true' },
      { key: 'baleia_enabled', value: 'true' }
    ];

    for (const setting of defaultSettings) {
      const existing = await getAsync(`SELECT * FROM system_settings WHERE key = ?`, [setting.key]);
      if (!existing) {
        await runAsync(`INSERT INTO system_settings (key, value) VALUES (?, ?)`, [setting.key, setting.value]);
      } else if (setting.key.endsWith('_model')) {
        await runAsync(`UPDATE system_settings SET value = ? WHERE key = ?`, [setting.value, setting.key]);
      }
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
  db,
  runAsync,
  getAsync,
  allAsync,
  initDatabase,
  logAction
};
