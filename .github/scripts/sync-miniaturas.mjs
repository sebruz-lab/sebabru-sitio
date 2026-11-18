// Mantiene al dia las miniaturas de los "facade" del podcast.
//
// Un facade es el cartel que reemplaza al reproductor: una imagen y un boton
// de play, y el iframe real se crea recien cuando alguien le hace clic. Eso
// saca de la carga inicial 1.001 KB de YouTube y 1.044 KB de Spotify, medidos
// con PageSpeed el 17/11/2026. El precio es que la imagen hay que tenerla, y
// como el Kit sale todas las semanas, una imagen fija envejece sola.
//
// Ninguna de las dos fuentes pide clave ni token:
//   - YouTube publica el RSS de cualquier playlist en /feeds/videos.xml.
//   - Spotify contesta el oEmbed de cualquier show sin autenticacion.
//
// El poster del mp4 sale con ffmpeg, que esta en los runners de ubuntu pero
// no en la maquina de Seba: si falta, se saltea y avisa, no falla.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const ejecutar = promisify(execFile);

const RAIZ = path.resolve(import.meta.dirname, '..', '..');
const IMG = path.join(RAIZ, 'public', 'img');

const PLAYLIST = 'PLxMY1XMl9aPWFsQtElx1EZcAoPyMCEYby';
const SHOW = '3pUBeAtMJw2WY3ykB82Tw3';
const MP4 = path.join(IMG, 'formaciones2026.mp4');
const POSTER = path.join(IMG, 'formaciones2026-poster.jpg');

let cambios = 0;
let fallos = 0;

async function bajar(url) {
    const r = await fetch(url, { redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' en ' + url);
    return Buffer.from(await r.arrayBuffer());
}

// Escribe solo si el contenido cambio: asi el commit automatico no genera
// ruido en el historial cada vez que corre el cron.
async function guardarSiCambio(destino, buffer, etiqueta) {
    let viejo = null;
    try { viejo = await readFile(destino); } catch {}
    if (viejo && viejo.equals(buffer)) {
        console.log('  = ' + etiqueta + ': sin cambios (' + Math.round(buffer.length / 1024) + ' KB)');
        return false;
    }
    await mkdir(path.dirname(destino), { recursive: true });
    await writeFile(destino, buffer);
    console.log('  + ' + etiqueta + ': ' + (viejo ? 'actualizada' : 'creada') + ' (' + Math.round(buffer.length / 1024) + ' KB)');
    cambios++;
    return true;
}

async function miniaturaYoutube() {
    const xml = await bajar('https://www.youtube.com/feeds/videos.xml?playlist_id=' + PLAYLIST);
    // El primer <yt:videoId> del feed es el ultimo video subido a la playlist.
    const m = /<yt:videoId>([^<]+)</.exec(xml.toString('utf8'));
    if (!m) throw new Error('el RSS de la playlist no trajo ningun videoId');
    const id = m[1];
    // sddefault (640x480) y no maxresdefault: maxres pesa 289 KB y la imagen
    // se ve al 75% de opacidad detras del boton de play, no se nota.
    const jpg = await bajar('https://i.ytimg.com/vi/' + id + '/sddefault.jpg');
    if (jpg.length < 2000) throw new Error('la miniatura de ' + id + ' vino vacia');
    console.log('  ultimo video: ' + id);
    await guardarSiCambio(path.join(IMG, 'kit-youtube.jpg'), jpg, 'kit-youtube.jpg');
}

async function miniaturaSpotify() {
    const url = 'https://open.spotify.com/oembed?url=https://open.spotify.com/show/' + SHOW;
    const datos = JSON.parse((await bajar(url)).toString('utf8'));
    if (!datos.thumbnail_url) throw new Error('el oEmbed no trajo thumbnail_url');
    const jpg = await bajar(datos.thumbnail_url);
    if (jpg.length < 2000) throw new Error('la portada de Spotify vino vacia');
    console.log('  ultimo episodio: ' + String(datos.title || '').slice(0, 60));
    await guardarSiCambio(path.join(IMG, 'kit-spotify.jpg'), jpg, 'kit-spotify.jpg');
}

async function posterDelVideo() {
    try {
        await ejecutar('ffmpeg', ['-version']);
    } catch {
        console.log('  - poster: ffmpeg no esta en esta maquina, lo salteo');
        return;
    }
    // Segundo 0.5 y no 0: el primer fotograma de un fundido de entrada suele
    // ser negro, y el poster quedaria igual que no tener poster.
    const tmp = path.join(IMG, '.poster-tmp.jpg');
    await ejecutar('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '0.5', '-i', MP4,
        '-frames:v', '1', '-q:v', '4', tmp]);
    const jpg = await readFile(tmp);
    await ejecutar(process.platform === 'win32' ? 'cmd' : 'rm',
        process.platform === 'win32' ? ['/c', 'del', tmp] : ['-f', tmp]).catch(() => {});
    await guardarSiCambio(POSTER, jpg, 'formaciones2026-poster.jpg');
}

const tareas = [
    ['Miniatura de YouTube', miniaturaYoutube],
    ['Portada de Spotify', miniaturaSpotify],
    ['Poster del mp4', posterDelVideo],
];

for (const [nombre, tarea] of tareas) {
    console.log(nombre + ':');
    try {
        await tarea();
    } catch (e) {
        // Una fuente caida no puede dejar el sitio sin las otras miniaturas:
        // la imagen vieja sigue sirviendo y el deploy no se rompe.
        console.error('  ! ' + nombre + ' fallo: ' + e.message);
        fallos++;
    }
}

console.log('');
console.log(cambios + ' imagen(es) actualizada(s), ' + fallos + ' fuente(s) con error.');
// Solo falla si TODAS fallaron: con una sola fuente viva, el sitio esta bien.
if (fallos === tareas.length) {
    console.error('Fallaron las tres fuentes: reviso que no haya cambiado una URL.');
    process.exit(1);
}
