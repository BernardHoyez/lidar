/* ═══════════════════════════════════════════════════════════════
   LIDAR_PENTE v1.0.0 — Pente MNT LIDAR IGN → MBTiles
   Architecture identique à Platier CL v2.0.0
   Source MNT : IGN Géoplateforme WCS (ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES)
   Calcul pente : algorithme de Horn (3×3)
   Sortie : tuiles PNG niveaux de gris dans un MBTiles SQLite
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ─────────────────────────────────────────────────────
const WCS_URL   = 'https://data.geopf.fr/wcs';
const WCS_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const TILE_PX   = 256;   // pixels par tuile WCS
const CONCUR    = 3;     // tuiles parallèles max
const NODATA    = -99999;

// ── STATE ──────────────────────────────────────────────────────────
const ST = {
  bbox  : null,
  ac    : null,   // AbortController
  mbt   : null,
  t0    : Date.now()
};

// ── DOM ────────────────────────────────────────────────────────────
const $      = id => document.getElementById(id);
const logEl  = $('logArea');
const barEl  = $('progressFill');
const lblEl  = $('progressLabel');
const pctEl  = $('progressPct');
const statEl = $('globalStatus');
const dlEl   = $('downloadZone');

// ── HORLOGE ────────────────────────────────────────────────────────
function ts() {
  const s = Math.floor((Date.now() - ST.t0) / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

// ── LOG ────────────────────────────────────────────────────────────
function log(msg, lv = 'info') {
  const d = document.createElement('div');
  d.className = 'log-line ' + lv;
  d.innerHTML = `<span class="ts">${ts()}</span><span class="msg">${msg}</span>`;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

// ── PROGRESSION ────────────────────────────────────────────────────
function prog(label, pct) {
  lblEl.textContent = label;
  pctEl.textContent = Math.round(pct) + '%';
  barEl.style.width = Math.min(100, pct) + '%';
  return new Promise(res => setTimeout(res, 4));
}

// ── STATUS ─────────────────────────────────────────────────────────
function setStatus(s) {
  const CL = { idle: 'chip-idle', run: 'chip-running', done: 'chip-done', err: 'chip-error' };
  const LB = { idle: 'Prêt', run: 'En cours…', done: 'Terminé ✓', err: 'Erreur' };
  statEl.className = 'status-chip ' + (CL[s] || 'chip-idle');
  statEl.innerHTML = `<span class="dot"></span>${LB[s] || s}`;
}

// ── CARTE LEAFLET ──────────────────────────────────────────────────
const map = L.map('map', { center: [45.0, 2.5], zoom: 10 });

L.tileLayer(
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png' +
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  { attribution: '© IGN', maxZoom: 19 }
).addTo(map);

const drawn = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw: {
    rectangle: { shapeOptions: { color: '#00c8a0', weight: 2 } },
    polygon: false, polyline: false, circle: false, circlemarker: false, marker: false
  },
  edit: { featureGroup: drawn, remove: true }
}));

map.on(L.Draw.Event.CREATED, e => {
  drawn.clearLayers();
  drawn.addLayer(e.layer);
  const b = e.layer.getBounds();
  ST.bbox = { minLon: b.getWest(), minLat: b.getSouth(), maxLon: b.getEast(), maxLat: b.getNorth() };
  updateCoords();
  map.fitBounds(b, { padding: [20, 20] });
  log(`Zone : [${ST.bbox.minLon.toFixed(4)}, ${ST.bbox.minLat.toFixed(4)}] → [${ST.bbox.maxLon.toFixed(4)}, ${ST.bbox.maxLat.toFixed(4)}]`, 'ok');
  uiEnable(true);
});
map.on(L.Draw.Event.DELETED, () => { ST.bbox = null; updateCoords(); uiEnable(false); });

function updateCoords() {
  const b = ST.bbox;
  $('cLonMin').textContent = b ? b.minLon.toFixed(4) : '—';
  $('cLonMax').textContent = b ? b.maxLon.toFixed(4) : '—';
  $('cLatMin').textContent = b ? b.minLat.toFixed(4) : '—';
  $('cLatMax').textContent = b ? b.maxLat.toFixed(4) : '—';
}

function uiEnable(on) {
  $('btnClear').disabled   = !on;
  $('btnProcess').disabled = !on;
  ['step2title', 'step3title'].forEach(id => $(id).classList.toggle('inactive', !on));
}

$('btnClear').addEventListener('click', () => {
  drawn.clearLayers();
  ST.bbox = ST.mbt = null;
  dlEl.classList.remove('visible');
  updateCoords(); uiEnable(false);
  prog('En attente', 0); setStatus('idle');
  log('Zone effacée.', 'warn');
});

const mapInfo = $('mapInfo');
map.on('mousemove', e => {
  mapInfo.style.display = 'block';
  mapInfo.textContent = `${e.latlng.lng.toFixed(5)}°E  ${e.latlng.lat.toFixed(5)}°N`;
});
map.on('mouseout', () => { mapInfo.style.display = 'none'; });

// ── TUILES XYZ ─────────────────────────────────────────────────────
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * (1 << z));
const lat2y = (lat, z) => Math.floor(
  (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << z)
);

function bboxToTileList(bbox, z) {
  const x0 = lon2x(bbox.minLon, z), x1 = lon2x(bbox.maxLon, z);
  const y0 = lat2y(bbox.maxLat, z), y1 = lat2y(bbox.minLat, z);
  const out = [];
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++)
      out.push({ z, x, y });
  return out;
}

// Bbox WGS84 d'une tuile XYZ → [minLon, minLat, maxLon, maxLat]
function tileBBox(x, y, z) {
  const n = 1 << z;
  const minLon =  x      / n * 360 - 180;
  const maxLon = (x + 1) / n * 360 - 180;
  const maxLat = Math.atan(Math.sinh(Math.PI * (1 - 2 *  y      / n))) * 180 / Math.PI;
  const minLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return { minLon, minLat, maxLon, maxLat };
}

// ── FETCH AVEC ABORT ───────────────────────────────────────────────
async function apiFetch(url) {
  if (!ST.ac || ST.ac.signal.aborted) throw new Error('Annulé');
  const r = await fetch(url, { signal: ST.ac.signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url.slice(0, 80)}`);
  return r;
}

// ── PARSER GEOTIFF MINIMAL (float32 + int16/int32) ─────────────────
// Supporte les GeoTIFF retournés par le WCS IGN (1 bande, strips)
function parseTIFF(buf) {
  const dv = new DataView(buf);
  const LE = dv.getUint16(0) === 0x4949;
  const r16  = o => dv.getUint16(o, LE);
  const r32  = o => dv.getUint32(o, LE);
  const r32s = o => dv.getInt32(o, LE);
  const rf32 = o => dv.getFloat32(o, LE);

  let ifd = r32(4);
  const nTags = r16(ifd); ifd += 2;

  let W = 0, H = 0, bps = 32, sfmt = 3;
  let stripOff = [], stripByte = [];

  for (let i = 0; i < nTags; i++) {
    const tag  = r16(ifd);
    const type = r16(ifd + 2);
    const cnt  = r32(ifd + 4);
    const vr   = ifd + 8;

    switch (tag) {
      case 256: W    = r16(vr) || r32(vr); break;
      case 257: H    = r16(vr) || r32(vr); break;
      case 258: bps  = r16(vr); break;
      case 339: sfmt = r16(vr); break; // 1=uint 2=int 3=float
      case 273:
        if (cnt === 1) stripOff = [r32(vr)];
        else { const o = r32(vr); stripOff = Array.from({ length: cnt }, (_, j) => r32(o + j * 4)); }
        break;
      case 279:
        if (cnt === 1) stripByte = [r32(vr)];
        else { const o = r32(vr); stripByte = Array.from({ length: cnt }, (_, j) => r32(o + j * 4)); }
        break;
    }
    ifd += 12;
  }

  const bpp = bps >> 3;
  const out = new Float32Array(W * H);
  let ptr = 0;
  for (let s = 0; s < stripOff.length; s++) {
    const npx = stripByte[s] / bpp;
    for (let p = 0; p < npx && ptr < W * H; p++, ptr++) {
      const o = stripOff[s] + p * bpp;
      if      (sfmt === 3) out[ptr] = rf32(o);
      else if (sfmt === 2) out[ptr] = r32s(o);
      else                 out[ptr] = r32(o);
    }
  }
  return { data: out, w: W, h: H };
}

// ── ALGORITHME DE HORN — pente en degrés ───────────────────────────
function computeSlope(elev, w, h, cellSizeM) {
  const slope = new Float32Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (elev[i] <= NODATA) continue;
      // Voisinage 3×3 — remplacer nodata par valeur centrale
      const fix = v => (v <= NODATA ? elev[i] : v);
      const a = fix(elev[(r-1)*w+(c-1)]), b = fix(elev[(r-1)*w+c]), cc = fix(elev[(r-1)*w+(c+1)]);
      const d = fix(elev[r*w+(c-1)]),                                 f = fix(elev[r*w+(c+1)]);
      const g = fix(elev[(r+1)*w+(c-1)]), hh= fix(elev[(r+1)*w+c]), ii= fix(elev[(r+1)*w+(c+1)]);
      const dzdx = ((cc + 2*f + ii) - (a + 2*d + g)) / (8 * cellSizeM);
      const dzdy = ((g + 2*hh + ii) - (a + 2*b + cc)) / (8 * cellSizeM);
      slope[i] = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy)) * 180 / Math.PI;
    }
  }
  return slope;
}

// ── SLOPE FLOAT32 → PNG RGBA (niveaux de gris) ────────────────────
// Retourne un Uint8Array PNG via OffscreenCanvas ou canvas standard
async function slopeToPNG(slope, w, h, seuilDeg) {
  let canvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
  } else {
    canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  const id  = ctx.createImageData(w, h);
  const px  = id.data;
  const k   = 255 / seuilDeg;
  for (let i = 0; i < w * h; i++) {
    const g = slope[i] <= 0 ? 0 : Math.min(255, Math.round(slope[i] * k));
    px[i*4]   = g;
    px[i*4+1] = g;
    px[i*4+2] = g;
    px[i*4+3] = 255;
  }
  ctx.putImageData(id, 0, 0);

  // Convertir en PNG binaire
  if (typeof OffscreenCanvas !== 'undefined') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } else {
    // Fallback : dataURL → ArrayBuffer
    const dataURL = canvas.toDataURL('image/png');
    const b64 = dataURL.split(',')[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
}

// ── FETCH TUILE MNT via WCS ────────────────────────────────────────
async function fetchMNTtile(x, y, z) {
  const bb = tileBBox(x, y, z);
  const url = WCS_URL
    + `?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage`
    + `&COVERAGEID=${WCS_LAYER}`
    + `&SUBSET=Long(${bb.minLon.toFixed(8)},${bb.maxLon.toFixed(8)})`
    + `&SUBSET=Lat(${bb.minLat.toFixed(8)},${bb.maxLat.toFixed(8)})`
    + `&WIDTH=${TILE_PX}&HEIGHT=${TILE_PX}`
    + `&FORMAT=image/tiff`;

  const resp = await apiFetch(url);
  // Si le WCS renvoie du XML d'erreur au lieu d'un TIFF
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('xml') || ct.includes('text')) {
    const txt = await resp.text();
    throw new Error('WCS erreur: ' + txt.slice(0, 120));
  }
  return parseTIFF(await resp.arrayBuffer());
}

// ── RÉSOLUTION APPROX. D'UNE TUILE EN M/PX ─────────────────────────
function tileResolution(y, z) {
  // latitude centrale de la tuile
  const n = 1 << z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI;
  return 156543.03 * Math.cos(lat * Math.PI / 180) / n;
}

// ── CONSTRUIRE MBTILES PENTE ───────────────────────────────────────
async function buildMBT(tiles, zoom, seuilDeg) {
  await prog('Chargement sql.js…', 10);
  log('sql.js : chargement SQLite WASM…', 'info');

  const SQL = await initSqlJs({
    locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
  });
  const db = new SQL.Database();

  db.run('CREATE TABLE metadata(name TEXT, value TEXT)');
  db.run('CREATE TABLE tiles(zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY(zoom_level,tile_column,tile_row))');
  db.run('CREATE UNIQUE INDEX tidx ON tiles(zoom_level,tile_column,tile_row)');

  for (const [k, v] of [
    ['name',        'LIDAR Pente IGN'],
    ['type',        'baselayer'],
    ['version',     '1'],
    ['description', `Pente MNT LIDAR IGN — seuil blanc ${seuilDeg}°`],
    ['format',      'png'],
    ['minzoom',     String(zoom)],
    ['maxzoom',     String(zoom)],
  ]) db.run('INSERT INTO metadata VALUES(?,?)', [k, v]);

  const ins   = db.prepare('INSERT OR REPLACE INTO tiles VALUES(?,?,?,?)');
  const total = tiles.length;
  let done = 0, errs = 0;

  log(`Téléchargement ${total} tuiles MNT zoom ${zoom}, calcul pente…`, 'info');

  for (let i = 0; i < total; i += CONCUR) {
    if (ST.ac.signal.aborted) throw new Error('Annulé');

    const batch = tiles.slice(i, i + CONCUR);

    const results = await Promise.allSettled(
      batch.map(async ({ z, x, y }) => {
        const { data, w, h } = await fetchMNTtile(x, y, z);
        const cellM = tileResolution(y, z) / w * TILE_PX;  // m/px réel de la tuile
        const slope = computeSlope(data, w, h, cellM);
        const png   = await slopeToPNG(slope, w, h, seuilDeg);
        return { z, x, y, png };
      })
    );

    for (let j = 0; j < batch.length; j++) {
      done++;
      if (results[j].status === 'fulfilled') {
        const { z, x, y, png } = results[j].value;
        ins.run([z, x, (1 << z) - 1 - y, png]);  // TMS : Y inversé
      } else {
        errs++;
        const { z, x, y } = batch[j];
        log(`✗ ${z}/${x}/${y} : ${results[j].reason?.message}`, 'warn');
      }
    }

    await prog(
      `Tuiles ${done}/${total}${errs ? ` (${errs} erreurs)` : ''}`,
      15 + 80 * (done / total)
    );
  }

  ins.free();
  log(`Export SQLite (${done - errs} tuiles insérées)…`, 'info');
  await prog('Export SQLite…', 97);

  const data = db.export();
  db.close();
  if (!data || data.byteLength < 512) throw new Error('Export SQLite vide.');
  return data;
}

// ── DÉCLENCHEUR TÉLÉCHARGEMENT ─────────────────────────────────────
function triggerDL(data, zoom, seuilDeg) {
  try {
    const blob = new Blob([data.buffer], { type: 'application/x-sqlite3' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `lidar_pente_z${zoom}_s${seuilDeg}.mbtiles`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    log('⬇ Téléchargement déclenché', 'ok');
  } catch (e) {
    log('Erreur téléchargement : ' + e.message, 'err');
  }
}

$('btnDownload').addEventListener('click', () => {
  if (ST.mbt) {
    const z = parseInt($('tileZoom').value) || 14;
    const s = parseFloat($('seuilDeg').value) || 45;
    triggerDL(ST.mbt, z, s);
  } else {
    log('Aucun fichier MBTiles disponible.', 'warn');
  }
});

// ── PIPELINE PRINCIPAL ─────────────────────────────────────────────
async function run() {
  if (!ST.bbox) { log('Aucune zone sélectionnée.', 'warn'); return; }

  ST.t0  = Date.now();
  ST.ac  = new AbortController();
  $('btnProcess').disabled = true;
  $('btnAbort').disabled   = false;
  dlEl.classList.remove('visible');
  setStatus('run');

  const zoom      = parseInt($('tileZoom').value)  || 14;
  const seuilDeg  = parseFloat($('seuilDeg').value) || 45;

  log(`▶ zoom=${zoom}  seuil blanc=${seuilDeg}°`, 'info');

  // Avertissement surface
  const dLon = ST.bbox.maxLon - ST.bbox.minLon;
  const dLat = ST.bbox.maxLat - ST.bbox.minLat;
  const x0 = lon2x(ST.bbox.minLon, zoom), x1 = lon2x(ST.bbox.maxLon, zoom);
  const y0 = lat2y(ST.bbox.maxLat, zoom), y1 = lat2y(ST.bbox.minLat, zoom);
  const nTiles = (x1 - x0 + 1) * (y1 - y0 + 1);

  if (nTiles > 500) {
    log(`⚠ ${nTiles} tuiles — zone large ou zoom élevé. Peut être très long.`, 'warn');
  }

  try {
    // 1. Calcul nombre de tuiles
    await prog('Calcul de la grille de tuiles…', 5);
    const tiles = bboxToTileList(ST.bbox, zoom);
    log(`Grille : ${tiles.length} tuiles (zoom ${zoom} — ~${tileResolution(y0, zoom).toFixed(1)} m/px)`, 'ok');
    if (!tiles.length) throw new Error('Aucune tuile dans la zone.');

    // 2. MNT + pente + MBTiles
    await prog('Démarrage assemblage MBTiles…', 8);
    const mbt = await buildMBT(tiles, zoom, seuilDeg);
    ST.mbt = mbt;

    const sz = mbt.byteLength > 1048576
      ? `${(mbt.byteLength / 1048576).toFixed(2)} Mo`
      : `${(mbt.byteLength / 1024).toFixed(0)} Ko`;

    log(`MBTiles pente : ${sz}  (${tiles.length} tuiles)`, 'ok');

    // 3. Téléchargement auto
    await prog('Téléchargement…', 99);
    triggerDL(mbt, zoom, seuilDeg);
    await prog('✓ Terminé', 100);
    setStatus('done');
    $('mbtSize').textContent = sz;
    $('mbtName').textContent = `lidar_pente_z${zoom}_s${seuilDeg}.mbtiles`;
    dlEl.classList.add('visible');
    log('✓ Terminé. Cliquez sur le bouton si le téléchargement n\'a pas démarré.', 'ok');

  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'Annulé') {
      log('Annulé.', 'warn'); setStatus('idle'); await prog('Annulé', 0);
    } else {
      log('ERREUR : ' + e.message, 'err');
      console.error('[LIDAR_PENTE]', e);
      setStatus('err'); await prog('Erreur', 0);
    }
  } finally {
    $('btnProcess').disabled = false;
    $('btnAbort').disabled   = true;
    ST.ac = null;
  }
}

$('btnProcess').addEventListener('click', run);
$('btnAbort').addEventListener('click', () => {
  if (ST.ac) { ST.ac.abort(); log('Annulation…', 'warn'); }
});

log('LIDAR_PENTE v1.0 prêt. Dessinez un rectangle sur la carte.', 'ok');
