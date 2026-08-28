const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const dbPath = path.join(__dirname, 'turboscribe.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Erro ao conectar ao banco de dados SQLite:', err.message);
  } else {
    console.log('Conectado ao banco de dados SQLite local:', dbPath);
  }
});

// Helper de exec em Promise
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Inicializar Esquema de Tabelas
async function initDatabase() {
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
    }
  } catch (err) {
    console.error('Erro durante a migração do banco de dados:', err.message);
  }

  db.serialize(async () => {
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

    // Seed / Sync Chave OpenRouter
    const openrouterKey = await getAsync(`SELECT * FROM api_keys WHERE provider = 'openrouter'`);
    const defaultKey = process.env.OPENROUTER_API_KEY || '';
    if (!openrouterKey) {
      await runAsync(
        `INSERT INTO api_keys (id, provider, name, key_value, is_active) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'openrouter', 'Chave Principal OpenRouter', defaultKey, 1]
      );
      console.log('Chave de API OpenRouter registrada com sucesso.');
    } else if (defaultKey && openrouterKey.key_value !== defaultKey) {
      await runAsync(`UPDATE api_keys SET key_value = ? WHERE provider = 'openrouter'`, [defaultKey]);
      console.log('Chave de API OpenRouter sincronizada com sucesso.');
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
  });
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
