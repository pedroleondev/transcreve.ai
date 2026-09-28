// T-08 — Teste do ETL SQLite → PostgreSQL.
// RODAR DENTRO DO CONTAINER (o host `db` só resolve na rede do compose):
//   docker exec -w /app transcreveai-app node tests/t08_migration.js
//
// Cria um SQLite de fixture com as 10 tabelas, migra para um banco Postgres
// DESCARTÁVEL (criado e destruído aqui), valida contagens e conversões de tipo,
// e testa as travas de segurança (destino não-vazio recusado, dry-run não
// destrutivo). Nada toca no banco real nem no Postgres de produção local.

const os = require('os');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { Client } = require('pg');
const { migrate, convertRow } = require('../scripts/migrate-sqlite-to-postgres');

let passed = 0;
let failed = 0;
function assert(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

const FIXTURE = path.join(os.tmpdir(), `t08-fixture-${process.pid}.sqlite`);
const TEST_DB = `transcreveai_test_t08_${process.pid}`;

const pgBaseConfig = () => ({
  host: process.env.PGHOST || 'db',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'transcreveai',
  password: process.env.PGPASSWORD || 'transcreveai_local_dev',
});

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT DEFAULT 'user', daily_limit INTEGER DEFAULT 3,
  status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE api_keys (id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT, key_value TEXT NOT NULL,
  is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_check_at DATETIME, last_check_ok INTEGER, last_check_info TEXT);
CREATE TABLE system_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE system_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, details TEXT,
  ip_address TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE transcriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT,
  file_name TEXT NOT NULL, file_path TEXT NOT NULL, file_size INTEGER DEFAULT 0,
  duration_seconds REAL DEFAULT 0, language TEXT DEFAULT 'pt', mode TEXT DEFAULT 'max',
  status TEXT DEFAULT 'completed', raw_text TEXT, speaker_diarization INTEGER DEFAULT 0,
  progress INTEGER DEFAULT 0, error_message TEXT, ai_summary TEXT, stage TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  worker_attempts INTEGER NOT NULL DEFAULT 0, worker_started_at DATETIME);
CREATE TABLE segments (id TEXT PRIMARY KEY, transcription_id TEXT NOT NULL, speaker TEXT,
  start_time REAL NOT NULL, end_time REAL NOT NULL, text TEXT NOT NULL);
CREATE TABLE transcription_chunks (id TEXT PRIMARY KEY, transcription_id TEXT NOT NULL, idx INTEGER NOT NULL,
  offset_sec REAL NOT NULL, duration_sec REAL NOT NULL, path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, model_used TEXT,
  segments_json TEXT, error TEXT, started_at DATETIME, finished_at DATETIME, detected_language TEXT);
CREATE TABLE ai_analyses (id TEXT PRIMARY KEY, transcription_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'enhance',
  model TEXT, prompt_used TEXT, glossary_used TEXT, result_md TEXT, tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0, cost_usd REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  judge_model TEXT, judge_approved INTEGER, judge_feedback TEXT, attempts INTEGER DEFAULT 1);
CREATE TABLE glossary (id TEXT PRIMARY KEY, wrong TEXT NOT NULL, correct TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
`;

const FIXTURE_ROWS = {
  users: [
    ['u-admin', 'Admin', 'admin@exemplo.local', '$2a$10$hashfake', 'admin', 999999, 'active', '2026-01-01 10:00:00'],
    ['u-user', 'Cliente', 'cliente@exemplo.local', '$2a$10$hashfake2', 'user', 3, 'active', '2026-02-01 10:00:00'],
  ],
  projects: [['p-1', 'u-user', 'Vendas 2026', '2026-02-01 11:00:00']],
  transcriptions: [
    ['t-1', 'u-user', 'p-1', 'reuniao.ogg', '/app/uploads/reuniao.ogg', 12345678, 3661.5, 'pt', 'max',
     'completed', 'Texto bruto da reunião com acentuação: ção, ão.', 1, 100, null, null, null,
     '2026-03-01 09:00:00', '2026-03-01 09:30:00', 2, '2026-03-01 09:01:00'],
    ['t-2', 'u-user', null, 'entrevista.ogg', '/app/uploads/entrevista.ogg', 500, 120.25, 'auto', 'base',
     'pending', null, 0, 0, null, null, null,
     '2026-03-02 09:00:00', '2026-03-02 09:00:00', 0, null],
  ],
  segments: [
    ['s-1', 't-1', 'Locutor 1', 0.5, 4.75, 'Olá, vamos começar.'],
    ['s-2', 't-1', 'Locutor 2', 5.0, 9.25, 'Concordo com o ponto.'],
  ],
  transcription_chunks: [
    ['c-1', 't-1', 0, 0, 600, '/tmp/chunk0.ogg', 'done', 1, 'openai/whisper-large-v3',
     '[{"start":0.5,"text":"Oi"}]', null, '2026-03-01 09:05:00', '2026-03-01 09:10:00', 'pt'],
    ['c-2', 't-1', 1, 600, 61.5, '/tmp/chunk1.ogg', 'pending', 0, null, null, null, null, null, null],
  ],
  ai_analyses: [
    ['a-1', 't-1', 'enhance', 'openai/gpt-4o-mini', 'prompt usado', 'glossário', '# Resultado', 100, 50, 0.0001,
     '2026-03-01 10:00:00', 'openai/gpt-4o-mini', 1, 'aprovado', 1],
    ['a-2', 't-1', 'enhance', 'openai/gpt-4o-mini', null, null, null, 0, 0, null,
     '2026-03-01 10:05:00', 'openai/gpt-4o-mini', 0, 'reprovado: formato', 2],
  ],
  glossary: [['g-1', 'transcrical', 'transcrição', '2026-02-15 08:00:00']],
  api_keys: [['k-1', 'openrouter', 'Principal', 'enc:v1:aa:bb:cc', 1, '2026-01-01 00:00:00',
              '2026-03-01 00:00:00', 1, '{"limit":100}']],
  system_settings: [['max_file_size_mb', '5120'], ['analysis_model', 'openai/gpt-4o-mini']],
  system_logs: [['log-1', 'u-user', 'login', '{"ip":"127.0.0.1"}', '127.0.0.1', '2026-03-01 08:00:00']],
};

function run(db, sql, params = []) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

async function buildFixture() {
  if (fs.existsSync(FIXTURE)) fs.unlinkSync(FIXTURE);
  const db = new sqlite3.Database(FIXTURE);
  try {
    // db.run() executa UMA instrução por vez — o schema vem fatiado.
    for (const stmt of SCHEMA.split(';')) {
      if (stmt.trim()) await run(db, stmt);
    }
    for (const [table, rows] of Object.entries(FIXTURE_ROWS)) {
      for (const row of rows) {
        const placeholders = row.map(() => '?').join(', ');
        await run(db, `INSERT INTO "${table}" VALUES (${placeholders})`, row);
      }
    }
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

async function main() {
  console.log('T-08 — ETL SQLite → PostgreSQL\n');

  // Unidade: conversão booleana 0/1 → false/true/null.
  assert('convertRow: 1 → true', convertRow('api_keys', { is_active: 1 }).is_active === true);
  assert('convertRow: 0 → false', convertRow('transcriptions', { speaker_diarization: 0 }).speaker_diarization === false);
  assert('convertRow: null → null', convertRow('ai_analyses', { judge_approved: null }).judge_approved === null);
  assert('convertRow: coluna fora da lista não converte',
    convertRow('glossary', { wrong: 'x' }).wrong === 'x');

  await buildFixture();

  // Conexão de manutenção (cria/apaga o banco de teste).
  const admin = new Client({ ...pgBaseConfig(), database: 'postgres' });
  try {
    await admin.connect();
  } catch (err) {
    console.error(`FALHA: não conectei no Postgres (${err.message}).`);
    console.error('Rode dentro do container com o service db no ar:');
    console.error('  docker compose up -d db');
    console.error('  docker exec -w /app transcreveai-app node tests/t08_migration.js');
    process.exit(1);
  }

  const testConfig = { ...pgBaseConfig(), database: TEST_DB };
  let migrated = null;
  try {
    await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    console.log(`\nBanco de teste: ${TEST_DB}`);

    // 1. Migração real.
    migrated = await migrate({ sqlitePath: FIXTURE, pgConfig: testConfig, logger: () => {} });
    assert('migração completa (não dry-run)', migrated && migrated.dryRun === false);
    assert('10 tabelas migradas', migrated.report.length === 10);
    assert('todas as contagens batem', migrated.report.every((r) => r.source === r.target));

    // 2. Validação de conteúdo no destino.
    const pg = new Client(testConfig);
    await pg.connect();
    try {
      const count = async (t) => (await pg.query(`SELECT COUNT(*)::int AS n FROM "${t}"`)).rows[0].n;
      assert('users: 2 linhas', (await count('users')) === 2);
      assert('transcriptions: 2 linhas', (await count('transcriptions')) === 2);
      assert('system_settings: 2 linhas', (await count('system_settings')) === 2);

      const t1 = (await pg.query(`SELECT * FROM transcriptions WHERE id='t-1'`)).rows[0];
      assert('REAL → double precision (3661.5)', t1.duration_seconds === 3661.5);
      assert('0/1 → boolean (speaker_diarization true)', t1.speaker_diarization === true);
      assert('texto com acentos preservado',
        t1.raw_text === 'Texto bruto da reunião com acentuação: ção, ão.');
      assert('worker_attempts preservado (2)', t1.worker_attempts === 2);

      const t2 = (await pg.query(`SELECT speaker_diarization FROM transcriptions WHERE id='t-2'`)).rows[0];
      assert('boolean false para 0', t2.speaker_diarization === false);

      const key = (await pg.query(`SELECT * FROM api_keys WHERE id='k-1'`)).rows[0];
      assert('chave cifrada preservada literalmente', key.key_value === 'enc:v1:aa:bb:cc');
      assert('last_check_ok true', key.last_check_ok === true);

      const a2 = (await pg.query(`SELECT judge_approved, attempts FROM ai_analyses WHERE id='a-2'`)).rows[0];
      assert('judge_approved false para 0', a2.judge_approved === false);

      const log = (await pg.query(`SELECT "timestamp" FROM system_logs WHERE id='log-1'`)).rows[0];
      assert('system_logs.timestamp vira Date de calendário 2026-03-01',
        log.timestamp instanceof Date && log.timestamp.toISOString().startsWith('2026-03-01T08:00:00'));

      const seg = (await pg.query(
        `SELECT speaker FROM segments WHERE transcription_id='t-1' ORDER BY start_time`)).rows;
      assert('2 segmentos ligados à transcrição', seg.length === 2);
    } finally {
      await pg.end();
    }

    // 3. Trava de segurança: destino não-vazio é recusado sem --force.
    let refused = false;
    try {
      await migrate({ sqlitePath: FIXTURE, pgConfig: testConfig, logger: () => {} });
    } catch (err) {
      refused = /não está vazio/i.test(err.message);
    }
    assert('re-migrar sem --force é recusado', refused);

    // 4. Dry-run não escreve nada e devolve o plano.
    const dry = await migrate({ sqlitePath: FIXTURE, pgConfig: testConfig, dryRun: true, logger: () => {} });
    assert('dry-run marca dryRun=true', dry.dryRun === true);
    assert('dry-run lista as 10 tabelas', dry.plan.length === 10);
    assert('dry-run com contagens certas', dry.plan.every((p) => p.rows === FIXTURE_ROWS[p.table].length));
    const afterDry = (await admin.query(
      `SELECT datname FROM pg_database WHERE datname='${TEST_DB}'`)).rows.length;
    assert('dry-run não destrói o destino', afterDry === 1);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`).catch(() => {});
    await admin.end();
    if (fs.existsSync(FIXTURE)) fs.unlinkSync(FIXTURE);
  }

  console.log(`\n${passed}/${passed + failed} PASS`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('ERRO inesperado:', err);
  process.exit(1);
});
