// T-08 — Migração SQLite → PostgreSQL (Fase 1: ferramental de migração).
//
// O app CONTINUA no SQLite nesta fase (DB_DRIVER=sqlite). Este script é o
// caminho oficial de migração quando a Fase 2 (driver swap) estiver pronta.
//
// Uso (sempre dentro do container, com o service `db` no ar):
//   node scripts/migrate-sqlite-to-postgres.js --dry-run   # DDL + plano, sem escrever nada
//   node scripts/migrate-sqlite-to-postgres.js             # migra para PG VAZIO
//   node scripts/migrate-sqlite-to-postgres.js --force     # TRUNCATE no destino antes de copiar
//
// Segurança:
//   - Abre o SQLite em READONLY (a fonte nunca é alterada).
//   - Transação única no Postgres: qualquer erro → rollback, nada fica pela metade.
//   - Recusa destino não-vazio sem --force.
//   - Valida contagens linha a linha no fim e imprime relatório; divergência = exit 1.
//
// Conexão com o Postgres (mesmas variáveis do cliente `pg`):
//   DATABASE_URL=postgres://user:pass@host:5432/db
//   ou PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE (defaults apontam p/ service `db`).

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { Client } = require('pg');

// Ordem respeita as FKs: pais antes de filhos.
const TABLE_ORDER = [
  'users',
  'projects',
  'transcriptions',
  'segments',
  'transcription_chunks',
  'ai_analyses',
  'glossary',
  'api_keys',
  'system_settings',
  'system_logs',
];

// Colunas 0/1 do SQLite que viram BOOLEAN no Postgres.
const BOOLEAN_COLUMNS = {
  api_keys: ['is_active', 'last_check_ok'],
  transcriptions: ['speaker_diarization'],
  ai_analyses: ['judge_approved'],
};

// DDL Postgres — espelha o schema de db.js (initDatabase), com os tipos
// nativos: REAL → DOUBLE PRECISION, DATETIME → TIMESTAMP, 0/1 → BOOLEAN.
// Identificadores entre aspas porque system_logs tem coluna "timestamp".
const PG_DDL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  daily_limit INTEGER DEFAULT 3,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transcriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  duration_seconds DOUBLE PRECISION DEFAULT 0,
  language TEXT DEFAULT 'pt',
  mode TEXT DEFAULT 'max',
  status TEXT DEFAULT 'completed',
  raw_text TEXT,
  speaker_diarization BOOLEAN DEFAULT FALSE,
  progress INTEGER DEFAULT 0,
  error_message TEXT,
  ai_summary TEXT,
  stage TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  worker_attempts INTEGER NOT NULL DEFAULT 0,
  worker_started_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
  speaker TEXT,
  start_time DOUBLE PRECISION NOT NULL,
  end_time DOUBLE PRECISION NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transcription_chunks (
  id TEXT PRIMARY KEY,
  transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  offset_sec DOUBLE PRECISION NOT NULL,
  duration_sec DOUBLE PRECISION NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  model_used TEXT,
  segments_json TEXT,
  error TEXT,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  detected_language TEXT
);
CREATE TABLE IF NOT EXISTS ai_analyses (
  id TEXT PRIMARY KEY,
  transcription_id TEXT NOT NULL REFERENCES transcriptions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'enhance',
  model TEXT,
  prompt_used TEXT,
  glossary_used TEXT,
  result_md TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd DOUBLE PRECISION,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  judge_model TEXT,
  judge_approved BOOLEAN,
  judge_feedback TEXT,
  attempts INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS glossary (
  id TEXT PRIMARY KEY,
  wrong TEXT NOT NULL,
  correct TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT,
  key_value TEXT NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_check_at TIMESTAMP,
  last_check_ok BOOLEAN,
  last_check_info TEXT
);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS system_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  "timestamp" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chunks_transcription ON transcription_chunks(transcription_id, idx);
CREATE INDEX IF NOT EXISTS idx_analyses_transcription ON ai_analyses(transcription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transcriptions_queue ON transcriptions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_transcriptions_user ON transcriptions(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_segments_transcription ON segments(transcription_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
`;

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

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

function openSource(sqlitePath) {
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`Banco SQLite não encontrado: ${sqlitePath}`);
  }
  // READONLY: a fonte é intocável, até mesmo por engano.
  return new sqlite3.Database(sqlitePath, sqlite3.OPEN_READONLY);
}

function all(db, sql) {
  return new Promise((resolve, reject) =>
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));
}

function tableColumnsSqlite(db, table) {
  return all(db, `PRAGMA table_info("${table}")`).then((cols) => cols.map((c) => c.name));
}

// Converte os 0/1 nas colunas booleanas; resto passa intacto.
function convertRow(table, row) {
  const bools = BOOLEAN_COLUMNS[table] || [];
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = bools.includes(k) ? (v === null ? null : v !== 0) : v;
  }
  return out;
}

async function migrate({ sqlitePath, pgConfig: cfg, force = false, dryRun = false, logger = console.log }) {
  const source = openSource(sqlitePath);
  try {
    // 1. Snapshot da fonte: tabelas e contagens.
    const plan = [];
    for (const table of TABLE_ORDER) {
      const cols = await tableColumnsSqlite(source, table);
      const rows = await all(source, `SELECT * FROM "${table}"`);
      plan.push({ table, columns: cols, rows });
    }

    if (dryRun) {
      logger('--- DRY RUN ---');
      logger('DDL que seria aplicado no Postgres:');
      logger(PG_DDL.trim());
      logger('Plano de cópia (fonte: ' + sqlitePath + '):');
      for (const p of plan) logger(`  ${p.table}: ${p.rows.length} linhas, ${p.columns.length} colunas`);
      return { dryRun: true, plan: plan.map((p) => ({ table: p.table, rows: p.rows.length })) };
    }

    const target = new Client(cfg);
    await target.connect();
    try {
      // 2. DDL idempotente.
      await target.query(PG_DDL);

      // 3. Destino precisa estar vazio (a menos que --force).
      if (!force) {
        for (const { table } of plan) {
          const r = await target.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
          if (r.rows[0].n > 0) {
            throw new Error(`Destino não está vazio: "${table}" tem ${r.rows[0].n} linhas. ` +
              'Use --force para truncar e sobrescrever, ou aponte PGDATABASE para um banco limpo.');
          }
        }
      } else {
        await target.query(`TRUNCATE ${TABLE_ORDER.map((t) => `"${t}"`).join(', ')} CASCADE`);
        logger('--force: destino truncado.');
      }

      // 4. Cópia em transação única: tudo ou nada.
      await target.query('BEGIN');
      const report = [];
      try {
        for (const { table, columns, rows } of plan) {
          if (rows.length === 0) { report.push({ table, source: 0, target: 0 }); continue; }
          const colList = columns.map((c) => `"${c}"`).join(', ');
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const stmt = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;
          for (const row of rows) {
            const converted = convertRow(table, row);
            const values = columns.map((c) => converted[c]);
            await target.query(stmt, values);
          }
          const check = await target.query(`SELECT COUNT(*)::int AS n FROM "${table}"`);
          report.push({ table, source: rows.length, target: check.rows[0].n });
          if (check.rows[0].n !== rows.length) {
            throw new Error(`Divergência em "${table}": fonte ${rows.length} vs destino ${check.rows[0].n}`);
          }
        }
        await target.query('COMMIT');
      } catch (err) {
        await target.query('ROLLBACK');
        throw err;
      }

      logger('--- RELATÓRIO DE MIGRAÇÃO ---');
      for (const r of report) {
        logger(`  ${r.table}: ${r.source} → ${r.target} linhas ${r.source === r.target ? 'OK' : 'FALHA'}`);
      }
      const total = report.reduce((acc, r) => acc + r.target, 0);
      logger(`Total migrado: ${total} linhas em ${report.length} tabelas.`);
      return { dryRun: false, report };
    } finally {
      await target.end();
    }
  } finally {
    source.close();
  }
}

if (require.main === module) {
  const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'turboscribe.sqlite');
  migrate({ sqlitePath, pgConfig: pgConfig(), force: FORCE, dryRun: DRY_RUN })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migração abortada:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate, PG_DDL, TABLE_ORDER, BOOLEAN_COLUMNS, convertRow };
