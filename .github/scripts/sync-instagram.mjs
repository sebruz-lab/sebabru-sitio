import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const token = process.env.IG_ACCESS_TOKEN;
const repo = process.env.GH_REPO;
if (!token) throw new Error('Falta IG_ACCESS_TOKEN');
if (!repo) throw new Error('Falta GH_REPO');

async function refreshToken(oldToken) {
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(oldToken)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Refresh fallo: ${res.status} ${await res.text()}`);
  return res.json();
}

async function getLatestPermalink(accessToken) {
  const url = `https://graph.instagram.com/me/media?fields=permalink,timestamp&limit=1&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Media fetch fallo: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data?.[0]?.permalink;
}

const refreshed = await refreshToken(token);
const newToken = refreshed.access_token;
console.log(`Token renovado, vence en ${Math.round(refreshed.expires_in / 86400)} dias`);

execFileSync('gh', ['secret', 'set', 'IG_ACCESS_TOKEN', '--body', newToken, '--repo', repo], { stdio: 'inherit' });
console.log('Secreto IG_ACCESS_TOKEN actualizado en GitHub');

const permalink = await getLatestPermalink(newToken);
if (!permalink) throw new Error('No se encontro ningun posteo');

const filePath = 'public/index.html';
const html = readFileSync(filePath, 'utf8');
const regex = /data-instgrm-permalink="([^"]+)"/;
const match = html.match(regex);
if (!match) throw new Error('No se encontro data-instgrm-permalink en index.html');

const currentPermalink = match[1].split('?')[0].replace(/\/$/, '');
const newPermalinkBase = permalink.replace(/\/$/, '');

if (currentPermalink !== newPermalinkBase) {
  const updated = html.replace(regex, `data-instgrm-permalink="${newPermalinkBase}/?utm_source=ig_embed&amp;utm_campaign=loading"`);
  writeFileSync(filePath, updated);
  console.log(`Permalink actualizado: ${newPermalinkBase}`);
} else {
  console.log('Sin cambios, el ultimo posteo ya esta reflejado.');
}
