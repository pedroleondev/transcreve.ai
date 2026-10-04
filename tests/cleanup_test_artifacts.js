// Limpeza one-shot: remove transcrições de teste (sample.ogg/audio.ogg/missing.mp3)
// que a suíte acumulou no dashboard do admin antes da limpeza automática existir.
// Uso: node tests/cleanup_test_artifacts.js
const BASE = 'http://localhost:3000';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

async function main() {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@turboscribe.local', password: ADMIN_PASSWORD })
  });
  const { token } = await loginRes.json();
  if (!token) throw new Error('login falhou');

  const listRes = await fetch(`${BASE}/api/transcriptions?limit=500`, { headers: { Authorization: `Bearer ${token}` } });
  const items = await listRes.json();
  const junk = (Array.isArray(items) ? items : items.data || []).filter(t =>
    /^sample.*\.ogg$/i.test(t.file_name) || t.file_name === 'audio.ogg' || /missing\.mp3$/i.test(t.file_name)
  );
  console.log(`total no dashboard: ${(Array.isArray(items) ? items : items.data || []).length} | lixo de teste: ${junk.length}`);

  let removed = 0;
  for (const t of junk) {
    const r = await fetch(`${BASE}/api/transcriptions/${t.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) removed++;
    else console.log('falhou:', t.id, r.status);
  }
  console.log(`removidas: ${removed}`);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
