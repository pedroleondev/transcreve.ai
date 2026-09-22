const sqlite3 = require('sqlite3');
const path = require('path');

// Conexao propria: a transacao nao pode absorver escritas concorrentes do worker.
async function saveTranscriptSegments(id, edits, filename = path.join(__dirname, '..', 'turboscribe.sqlite')) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  if (!Array.isArray(edits) || !edits.length || edits.some(s => !s || typeof s.id !== 'string' || typeof s.text !== 'string') || new Set(edits.map(s => s.id)).size !== edits.length) {
    throw fail(400, 'Envie os segmentos completos, com IDs unicos e texto valido.');
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
