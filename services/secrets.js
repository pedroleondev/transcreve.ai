const crypto = require('crypto');

// Cifra em repouso para segredos guardados no SQLite (chave da OpenRouter).
// AES-256-GCM: IV aleatorio por registro + tag de autenticacao — alterar o
// ciphertext no banco falha na decifragem em vez de devolver lixo.
// Formato armazenado: enc:v1:<iv hex>:<tag hex>:<ciphertext hex>
// A chave-mestra vem de APP_SECRET_KEY (env). Em producao e obrigatoria.

const PREFIX = 'enc:v1:';
let masterKey = null;

function loadMasterKey() {
  if (masterKey) return masterKey;
  const secret = process.env.APP_SECRET_KEY || '';
  if (secret.length >= 32) {
    masterKey = crypto.createHash('sha256').update(secret, 'utf8').digest();
    return masterKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'APP_SECRET_KEY ausente ou curta (< 32 chars) com NODE_ENV=production. ' +
      'Gere com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  // Desenvolvimento sem APP_SECRET_KEY: deriva de JWT_SECRET para nao travar o
  // fluxo local, mas avisa — trocar o JWT_SECRET depois invalida a chave salva.
  console.warn('[secrets] APP_SECRET_KEY nao definida; derivando chave de cifra do JWT_SECRET (so para desenvolvimento).');
  masterKey = crypto.scryptSync(process.env.JWT_SECRET || 'dev', 'transcreveai-dev-salt', 32);
  return masterKey;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(plain) {
  const key = loadMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

// Aceita valor legado em texto puro (pre-migracao) e devolve como esta.
function decrypt(stored) {
  if (!isEncrypted(stored)) return stored || '';
  const [ivHex, tagHex, ctHex] = stored.slice(PREFIX.length).split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', loadMasterKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('Nao foi possivel decifrar o segredo: APP_SECRET_KEY mudou ou o registro foi alterado. Cadastre a chave de novo.');
  }
}

function mask(plain) {
  const s = String(plain || '');
  if (s.length <= 14) return s ? '••••' : '';
  return `${s.slice(0, 10)}…${s.slice(-4)}`;
}

module.exports = { encrypt, decrypt, isEncrypted, mask, loadMasterKey };
