// T-11: download de mídia a partir de URL — YouTube/Vimeo via yt-dlp (binário
// no container) e links diretos de arquivo (.mp3/.mp4/.wav/…) via fetch HTTP.
//
// Honestidade (regra do projeto): falha de download vira erro explícito com a
// causa (link privado/removido/dominio sem suporte) — nunca texto inventado.
//
// SSRF: em producao (NODE_ENV=production), URLs cujo host é privado/loopback
// sao recusadas. Fora de producao, liberado de proposito — e assim a suite de
// testes usa um mock HTTP local (aceite T-11: sem chamar YouTube de verdade).

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const DIRECT_MEDIA_EXT = [
  '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac', '.aac', '.wma',
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.wmv', '.mpeg', '.mpg', '.3gp', '.m4v'
];

const isProduction = process.env.NODE_ENV === 'production';
// Anti-SSRF: hosts privados/loopback recusados em producao. Escape hatch
// documentado (ALLOW_PRIVATE_DOWNLOADS=true) para self-host local/LAN — e
// assim a suite testa com um mock HTTP em 127.0.0.1 sem tocar no YouTube.
const allowPrivateHosts = !isProduction || process.env.ALLOW_PRIVATE_DOWNLOADS === 'true';

// Hosts privados/loopback: recusados SOMENTE em producao (anti-SSRF).
function isPrivateHost(hostname) {
  const h = String(hostname).toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true;
  return false;
}

// classifica a URL: 'youtube' | 'vimeo' | 'direct' | { error }
function classifyUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (_) {
    return { error: 'URL inválida. Cole um link completo, começando com http:// ou https://.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Só aceitamos links http:// ou https://.' };
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowPrivateHosts && isPrivateHost(host)) {
    return { error: 'Este endereço não é permitido.' };
  }
  const isYoutube = host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com' || host === 'youtu.be' || host === 'music.youtube.com';
  const isVimeo = host === 'vimeo.com' || host === 'www.vimeo.com';
  if (isYoutube || isVimeo) return { kind: isYoutube ? 'youtube' : 'vimeo' };
  const ext = path.extname(parsed.pathname).toLowerCase();
  if (DIRECT_MEDIA_EXT.includes(ext)) return { kind: 'direct', ext };
  return {
    error: 'Domínio não suportado. Use um link do YouTube ou Vimeo, ou um link direto de arquivo de áudio/vídeo (.mp3, .mp4, .wav, .ogg…).'
  };
}

function followGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Falou.ai/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        followGet(next, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`O servidor respondeu HTTP ${res.statusCode} para o link.`));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('Tempo esgotado ao baixar o link.')));
  });
}

// Baixa link direto de arquivo, abortando se passar de maxBytes.
async function downloadDirect(url, destPath, maxBytes) {
  const res = await followGet(url);
  const nameFromUrl = decodeURIComponent(path.basename(new URL(url).pathname) || 'arquivo-do-link');
  let received = 0;
  const out = fs.createWriteStream(destPath);
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          reject(new Error(`O arquivo do link é maior que o limite de ${Math.round(maxBytes / (1024 * 1024))} MB.`));
          return;
        }
        out.write(chunk);
      });
      res.on('end', resolve);
      res.on('error', reject);
      out.on('error', reject);
    });
  } finally {
    out.end();
  }
  return { fileName: nameFromUrl, size: received };
}

// Baixa YouTube/Vimeo com yt-dlp (áudio de melhor qualidade; --no-playlist =
// uma URL = uma transcrição, conforme escopo da T-11).
function downloadWithYtDlp(url, destPrefix, maxBytes) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '--no-progress', '--no-warnings', '--no-check-certificate',
      '-f', 'bestaudio/best',
      '--max-filesize', String(maxBytes),
      '--write-info-json', '--no-clean-info-json',
      '-o', destPrefix + '.%(ext)s',
      url
    ];
    const child = spawn('yt-dlp', args, { timeout: 300000 });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-800); });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('O componente de download (yt-dlp) não está instalado no servidor. Fale com o administrador.'));
        return;
      }
      reject(new Error(`Falha ao iniciar o download: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        const cause = /private|sign in|login|removed|unavailable|not available|copyright|age/i.test(stderrTail)
          ? 'o vídeo é privado, foi removido ou exige login/idade.'
          : 'não foi possível baixar o conteúdo do link.';
        reject(new Error(`Download falhou (${cause}) Detalhes: ${stderrTail.split('\n').filter(Boolean).pop() || 'sem detalhes'}`));
        return;
      }
      resolve();
    });
  });
}

// Ponto de entrada: baixa a URL para dentro de dir e devolve
// { filePath, fileName, size } com o arquivo final.
async function downloadFromUrl(rawUrl, dir, maxBytes) {
  const cls = classifyUrl(rawUrl);
  if (cls.error) throw Object.assign(new Error(cls.error), { statusHint: 400 });
  const id = `url-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

  if (cls.kind === 'direct') {
    const destPath = path.join(dir, id + cls.ext);
    try {
      const { fileName, size } = await downloadDirect(rawUrl, destPath, maxBytes);
      return { filePath: destPath, fileName, size };
    } catch (e) {
      await fs.promises.unlink(destPath).catch(() => {});
      throw e;
    }
  }

  const destPrefix = path.join(dir, id);
  await downloadWithYtDlp(rawUrl, destPrefix, maxBytes);
  // yt-dlp grava <prefix>.<ext> + <prefix>.info.json — localiza o media real.
  const files = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(destPrefix) + '.'));
  const media = files.find(f => !f.endsWith('.info.json'));
  if (!media) throw new Error('O download não gerou um arquivo de mídia reconhecível.');
  let title = path.basename(media);
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, files.find(f => f.endsWith('.info.json'))), 'utf8'));
    if (info.title) title = String(info.title).slice(0, 120);
  } catch (_) { /* sem título: usa o nome do arquivo */ }
  await Promise.all(files.filter(f => f.endsWith('.info.json')).map(f => fs.promises.unlink(path.join(dir, f)).catch(() => {})));
  const filePath = path.join(dir, media);
  return { filePath, fileName: title, size: fs.statSync(filePath).size };
}

module.exports = { classifyUrl, downloadFromUrl, DIRECT_MEDIA_EXT };
