// Testes in-memory da cifra em repouso (services/secrets.js) — aceite T-15.
// Nao toca no banco nem na rede: so cifra/decifra/mascara em memoria.
// Rodar: node tests/secrets.js

process.env.APP_SECRET_KEY = 'test_app_secret_key_com_mais_de_32_chars!';

const assert = require('assert');
const secrets = require('../services/secrets');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✅ [PASS ${pass + fail}] ${name}`);
  } catch (e) {
    fail++;
    console.error(`❌ [FAIL ${pass + fail}] ${name}: ${e.message}`);
  }
}

check('roundtrip: decrypt(encrypt(chave)) devolve a chave original', () => {
  const plain = 'sk-or-v1-abc123def456ghi789jkl012mno345pq';
  assert.strictEqual(secrets.decrypt(secrets.encrypt(plain)), plain);
});

check('formato enc:v1: e IV aleatorio por registro (mesmo plaintext => ciphertexts distintos)', () => {
  const plain = 'sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const a = secrets.encrypt(plain);
  const b = secrets.encrypt(plain);
  assert.ok(secrets.isEncrypted(a), 'deve marcar como cifrado');
  // enc:v1:<iv>:<tag>:<ciphertext> => 5 segmentos ao separar por ':'
  assert.strictEqual(a.split(':').length, 5, 'formato enc:v1:<iv>:<tag>:<ct>');
  assert.strictEqual(a.slice(0, 7), 'enc:v1:');
  assert.notStrictEqual(a, b);
});

check('ciphertext adulterado FALHA na decifragem (autenticacao GCM)', () => {
  const parts = secrets.encrypt('sk-or-v1-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').split(':');
  const ct = parts[4];
  parts[4] = (ct[0] === '0' ? '1' : '0') + ct.slice(1); // troca 1 nibble
  assert.throws(() => secrets.decrypt(parts.join(':')), /decifrar/i);
});

check('tag de autenticacao adulterada FALHA na decifragem', () => {
  const parts = secrets.encrypt('sk-or-v1-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').split(':');
  const tag = parts[3];
  parts[3] = (tag[0] === '0' ? '1' : '0') + tag.slice(1);
  assert.throws(() => secrets.decrypt(parts.join(':')), /decifrar/i);
});

check('IV adulterado FALHA na decifragem', () => {
  const parts = secrets.encrypt('sk-or-v1-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz').split(':');
  const iv = parts[2];
  parts[2] = (iv[0] === '0' ? '1' : '0') + iv.slice(1);
  assert.throws(() => secrets.decrypt(parts.join(':')), /decifrar/i);
});

check('valor legado em texto puro passa intacto (pre-migracao)', () => {
  const legacy = 'sk-or-v1-legadonacifrado0123456789abcdef';
  assert.strictEqual(secrets.decrypt(legacy), legacy);
  assert.ok(!secrets.isEncrypted(legacy));
});

check('mask: expoe so prefixo + ultimos 4, nunca o miolo', () => {
  const plain = 'sk-or-v1-abcdefghij0123456789ABCD';
  const m = secrets.mask(plain);
  assert.ok(m.startsWith('sk-or-v1-'), `mascara inesperada: ${m}`);
  assert.ok(m.includes('…'), `mascara sem elipse: ${m}`);
  assert.ok(m.endsWith('ABCD'));
  assert.ok(!m.includes('bcdefghi'), 'miolo vazou na mascara');
  assert.ok(!m.includes('0123456789'), 'miolo vazou na mascara');
});

check('mask: vazio vazio, curto vira bolinhas', () => {
  assert.strictEqual(secrets.mask(''), '');
  assert.strictEqual(secrets.mask('abc'), '••••');
});

console.log(`\n${fail === 0 ? '✅' : '❌'} secrets: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
