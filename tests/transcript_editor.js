const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { saveTranscriptSegments } = require('../services/transcript-editor');
const { generateTXT, generateSRT, generateVTT } = require('../services/exporter');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcreveai-t04-'));
  const filename = path.join(directory, 'test.sqlite');
  const db = await new Promise((resolve, reject) => { const d = new sqlite3.Database(filename, e => e ? reject(e) : resolve(d)); });
  const run = sql => new Promise((resolve, reject) => db.exec(sql, e => e ? reject(e) : resolve()));
  const all = sql => new Promise((resolve, reject) => db.all(sql, (e, rows) => e ? reject(e) : resolve(rows)));
  let passed = 0;
  const check = (value, label) => { assert(value, label); console.log('PASS: ' + label); passed++; };
  try {
    await run("CREATE TABLE transcriptions(id TEXT PRIMARY KEY, status TEXT, raw_text TEXT, updated_at TEXT); CREATE TABLE segments(id TEXT PRIMARY KEY, transcription_id TEXT, speaker TEXT, start_time REAL, end_time REAL, text TEXT); INSERT INTO transcriptions VALUES ('t','completed','original',NULL), ('other','completed','outro',NULL); INSERT INTO segments VALUES ('a','t','Pessoa A',0,1,'um'),('b','t','Pessoa B',3,4,'dois'),('c','other','Pessoa C',0,1,'outro');");
    const edits = [{ id: 'b', text: 'Segundo editado' }, { id: 'a', text: 'Primeiro\ncom quebra' }];
    const result = await saveTranscriptSegments('t', edits, filename);
    check(result.raw_text === 'Primeiro\ncom quebra\n\nSegundo editado', 'texto recomposto na ordem cronologica');
    check(result.segments[0].start_time === 0 && result.segments[1].end_time === 4 && result.segments[1].speaker === 'Pessoa B', 'tempos e falantes preservados');
    check((await all("SELECT text FROM segments WHERE id='a'"))[0].text === edits[1].text, 'edicao persiste em nova leitura');
    for (const output of [generateTXT(result), generateTXT(result,result.segments,true), generateSRT(result.segments), generateVTT(result.segments)]) check(output.includes('Primeiro') && output.includes('Segundo editado'), 'exportacao usa texto editado');
    for (const invalid of [[{id:'a',text:'x'}], [{id:'a',text:'x'},{id:'a',text:'y'}], [{id:'a',text:'x'},{id:'c',text:'y'}], [{id:'a',text:1}]]) {
      await assert.rejects(saveTranscriptSegments('t', invalid, filename), e => e.status === 400); passed++;
    }
    await assert.rejects(saveTranscriptSegments('missing', edits, filename), e => e.status === 404); passed++;
    await run("UPDATE transcriptions SET status='processing' WHERE id='t'");
    await assert.rejects(saveTranscriptSegments('t', edits, filename), e => e.status === 409); passed++;
    await run("UPDATE transcriptions SET status='completed' WHERE id='t'; CREATE TRIGGER fail_second BEFORE UPDATE ON segments WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    await assert.rejects(saveTranscriptSegments('t', [{id:'a',text:'must rollback'},{id:'b',text:'fail'}], filename));
    check((await all("SELECT text FROM segments WHERE id='a'"))[0].text === edits[1].text && (await all("SELECT raw_text FROM transcriptions WHERE id='t'"))[0].raw_text === result.raw_text, 'falha intermediaria reverte toda a transacao');
    console.log(passed + '/' + passed + ' PASS');
  } finally {
    await new Promise(resolve => db.close(resolve));
    fs.unlinkSync(filename); fs.rmdirSync(directory);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
