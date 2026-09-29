const sqlite3 = require('sqlite3');
const path = require('path');
const { isPostgres, pgPool } = require('../db');

// Conexao propria: a transacao nao pode absorver escritas concorrentes do worker.
// T-08 fase 2: no Postgres a transacao roda num client DEDICADO do pool (o pool
// suporta transacoes concorrentes, cada client e independente) — mesma logica,
// mesma validacao, dialeto traduzido na mao ($n + booleans nao se aplicam aqui:
// so UPDATE/SELECT com textos).
async function saveTranscriptSegments(id, edits, filename = path.join(__dirname, '..', 'turboscribe.sqlite')) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!Array.isArray(edits) || !edits.length || edits.some(s => !s || typeof s.id !== 'string' || typeof s.text !== 'string') || new Set(edits.map(s => s.id)).size !== edits.length) {
    throw fail(400, 'Envie os segmentos completos, com IDs unicos e texto valido.');
  }

  if (isPostgres) {
    const client = await pgPool.connect();
    const q = (sql, args = []) => client.query(sql, args);
    try {
      await q('BEGIN');
      const statusRes = await q('SELECT status FROM transcriptions WHERE id = $1', [id]);
      if (!statusRes.rows[0]) throw fail(404, 'Transcricao nao encontrada.');
      if (['pending', 'processing'].includes(statusRes.rows[0].status)) throw fail(409, 'Aguarde o processamento antes de editar.');
      const segmentsRes = await q('SELECT * FROM segments WHERE transcription_id = $1 ORDER BY start_time ASC', [id]);
      const segments = segmentsRes.rows;
      const byId = new Map(edits.map(s => [s.id, s.text]));
      if (segments.length !== edits.length || segments.some(s => !byId.has(s.id))) throw fail(400, 'Os segmentos nao correspondem a esta transcricao. Reabra o arquivo.');
      for (const segment of segments) {
        segment.text = byId.get(segment.id);
        await q('UPDATE segments SET text = $1 WHERE id = $2 AND transcription_id = $3', [segment.text, segment.id, id]);
      }
      const raw_text = segments.map(s => s.text).join('\n\n');
      await q('UPDATE transcriptions SET raw_text = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [raw_text, id]);
      await q('COMMIT');
      return { success: true, raw_text, segments };
    } catch (error) {
      await q('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, err => err ? reject(err) : resolve(connection));
  });
  db.configure('busyTimeout', 5000);
  const run = (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, err => err ? reject(err) : resolve()));
  const all = (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (err, rows) => err ? reject(err) : resolve(rows)));
  let transaction = false;
  try {
    await run('BEGIN IMMEDIATE'); transaction = true;
    const [row] = await all('SELECT status FROM transcriptions WHERE id = ?', [id]);
    if (!row) throw fail(404, 'Transcricao nao encontrada.');
    if (['pending', 'processing'].includes(row.status)) throw fail(409, 'Aguarde o processamento antes de editar.');
    const segments = await all('SELECT * FROM segments WHERE transcription_id = ? ORDER BY start_time ASC', [id]);
    const byId = new Map(edits.map(s => [s.id, s.text]));
    if (segments.length !== edits.length || segments.some(s => !byId.has(s.id))) throw fail(400, 'Os segmentos nao correspondem a esta transcricao. Reabra o arquivo.');
    for (const segment of segments) {
      segment.text = byId.get(segment.id);
      await run('UPDATE segments SET text = ? WHERE id = ? AND transcription_id = ?', [segment.text, segment.id, id]);
    }
    const raw_text = segments.map(s => s.text).join('\n\n');
    await run('UPDATE transcriptions SET raw_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [raw_text, id]);
    await run('COMMIT'); transaction = false;
    return { success: true, raw_text, segments };
  } catch (error) {
    if (transaction) await run('ROLLBACK');
    throw error;
  } finally {
    await new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));
  }
}
module.exports = { saveTranscriptSegments };
