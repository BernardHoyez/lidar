/* ═══════════════════════════════════════════════════════════════
   LIDAR_PENTE v1.2.0 — Pente MNT LIDAR IGN → MBTiles
   Architecture identique à Platier CL v2.0.0
   Source MNT : IGN Géoplateforme WMTS — ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES
               Format image/x-bil;bits=32  TileMatrixSet WGS84G (EPSG:4326)
   Calcul pente : algorithme de Horn (3×3)
   Sortie : tuiles PNG niveaux de gris dans un MBTiles SQLite
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ─────────────────────────────────────────────────────
// Le MNT IGN n'est PAS disponible via WCS public.
// Il est servi via WMTS au format BIL (Binary Interleaved by Line) float32.
// TileMatrixSet WGS84G : grille EPSG:4326, origine coin supérieur-gauche (-180, 90)
// Niveau 0 : 2 tuiles en largeur (360° / 256px), 1 en hauteur
// Niveau L : 2^(L+1) colonnes, 2^L lignes
const WMTS_URL   = 'https://data.geopf.fr/wmts';
const MNT_LAYER  = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MNT_STYLE  = 'normal';
const MNT_TMS    = 'WGS84G';           // TileMatrixSet EPSG:4326
const MNT_FMT    = 'image/x-bil;bits=32';
const TILE_PX    = 256;                // pixels par tuile
const CONCUR     = 3;                  // tuiles parallèles max
const NODATA     = -99999;

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

// ══════════════════════════════════════════════════════════════════
//  SYSTÈME DE TUILES WGS84G (EPSG:4326)
//  Le TileMatrixSet WGS84G de l'IGN utilise une grille géographique :
//  - Origine : coin supérieur-gauche (-180°, 90°)
//  - Niveau L : nCols = 2^(L+1), nLignes = 2^L
//  - Tuile (col, row) couvre : lon ∈ [minLon, maxLon], lat ∈ [minLat, maxLat]
//  À NE PAS confondre avec le TileMatrixSet PM (Pseudo-Mercator) utilisé
//  par la carte de fond Leaflet.
// ══════════════════════════════════════════════════════════════════

// Nombre de colonnes et lignes au niveau L
const wgs84Cols = L => 1 << (L + 1);   // 2^(L+1)
const wgs84Rows = L => 1 << L;          // 2^L

// Lon/Lat → indices tuile WGS84G
function ll2wgs84(lon, lat, L) {
  const nCols = wgs84Cols(L);
  const nRows = wgs84Rows(L);
  const col = Math.floor((lon + 180) / 360 * nCols);
  const row = Math.floor((90 - lat)  / 180 * nRows);
  return { col: Math.max(0, Math.min(nCols - 1, col)),
           row: Math.max(0, Math.min(nRows - 1, row)) };
}

// BBox géographique d'une tuile WGS84G
function wgs84TileBBox(col, row, L) {
  const nCols = wgs84Cols(L);
  const nRows = wgs84Rows(L);
  return {
    minLon:  col      / nCols * 360 - 180,
    maxLon: (col + 1) / nCols * 360 - 180,
    maxLat: 90 -  row      / nRows * 180,
    minLat: 90 - (row + 1) / nRows * 180,
  };
}

// Liste des tuiles WGS84G couvrant une bbox, au niveau L
function bboxToTileList(bbox, L) {
  const tl = ll2wgs84(bbox.minLon, bbox.maxLat, L);
  const br = ll2wgs84(bbox.maxLon, bbox.minLat, L);
  const out = [];
  for (let col = tl.col; col <= br.col; col++)
    for (let row = tl.row; row <= br.row; row++)
      out.push({ L, col, row });
  return out;
}

// ── FETCH AVEC ABORT ───────────────────────────────────────────────
async function apiFetch(url) {
  if (!ST.ac || ST.ac.signal.aborted) throw new Error('Annulé');
  const r = await fetch(url, { signal: ST.ac.signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${url.slice(0, 100)}`);
  return r;
}

// ── PARSER BIL (Binary Interleaved by Line) float32 ───────────────
// Le format image/x-bil;bits=32 est du float32 little-endian brut,
// TILE_PX × TILE_PX valeurs, sans en-tête.
function parseBIL(buf) {
  const W = TILE_PX, H = TILE_PX;
  if (buf.byteLength < W * H * 4) {
    throw new Error(`BIL trop court : ${buf.byteLength} bytes (attendu ${W*H*4})`);
  }
  // float32 little-endian
  return new Float32Array(buf, 0, W * H);
}

// ── ALGORITHME DE HORN — pente en degrés ───────────────────────────
function computeSlope(elev, w, h, cellSizeM) {
  const slope = new Float32Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (elev[i] <= NODATA) continue;
      const fix = v => (v <= NODATA ? elev[i] : v);
      const a = fix(elev[(r-1)*w+(c-1)]), b = fix(elev[(r-1)*w+c]), cc = fix(elev[(r-1)*w+(c+1)]);
      const d = fix(elev[r*w+(c-1)]),                                 f  = fix(elev[r*w+(c+1)]);
      const g = fix(elev[(r+1)*w+(c-1)]), hh= fix(elev[(r+1)*w+c]), ii = fix(elev[(r+1)*w+(c+1)]);
      const dzdx = ((cc + 2*f + ii) - (a + 2*d + g)) / (8 * cellSizeM);
      const dzdy = ((g + 2*hh + ii) - (a + 2*b + cc)) / (8 * cellSizeM);
      slope[i] = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy)) * 180 / Math.PI;
    }
  }
  return slope;
}

// ── SLOPE → PNG niveaux de gris ────────────────────────────────────
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
    px[i*4] = px[i*4+1] = px[i*4+2] = g;
    px[i*4+3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  if (typeof OffscreenCanvas !== 'undefined') {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } else {
    const b64 = canvas.toDataURL('image/png').split(',')[1];
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
}

// ── RÉSOLUTION D'UNE TUILE WGS84G EN M/PX ─────────────────────────
// WGS84G niveau L : chaque tuile couvre 180°/2^L en latitude
// → hauteur en degrés = 180/2^L, en m = 180/2^L * 111320 m/°
// → résolution = hauteur_m / TILE_PX
function tileResolutionWGS84(row, L) {
  const nRows  = wgs84Rows(L);
  const latCtr = 90 - (row + 0.5) / nRows * 180;
  // taille angulaire d'un pixel en degrés lat
  const degPerPx = 180 / nRows / TILE_PX;
  return degPerPx * 111320;  // m/px (valeur approx., latitude peu affecte en France)
}

// ── FETCH TUILE MNT via WMTS WGS84G ───────────────────────────────
async function fetchMNTtile(col, row, L) {
  const url = WMTS_URL
    + `?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile`
    + `&LAYER=${MNT_LAYER}`
    + `&STYLE=${MNT_STYLE}`
    + `&FORMAT=${encodeURIComponent(MNT_FMT)}`
    + `&TILEMATRIXSET=${MNT_TMS}`
    + `&TILEMATRIX=${L}`
    + `&TILEROW=${row}`
    + `&TILECOL=${col}`;

  const resp = await apiFetch(url);

  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('xml') || ct.includes('html') || ct.includes('text')) {
    const txt = await resp.text();
    throw new Error(`WMTS erreur (${ct}) : ${txt.slice(0, 200)}`);
  }

  const buf = await resp.arrayBuffer();
  if (buf.byteLength < TILE_PX * TILE_PX * 4) {
    throw new Error(`Réponse trop courte (${buf.byteLength} bytes) — tuile hors couverture ?`);
  }
  return parseBIL(buf);
}

// ── CONSTRUIRE MBTILES PENTE ───────────────────────────────────────
// Les tuiles MBTiles sont stockées en convention XYZ PM (Pseudo-Mercator),
// car c'est ce que QGIS/MapTiler/TileServer attend.
// On convertit chaque tuile WGS84G → rendu PNG → réindexe en XYZ PM.
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
    ['description', `Pente MNT LIDAR IGN — seuil blanc ${seuilDeg}° — zoom ${zoom}`],
    ['format',      'png'],
    ['minzoom',     String(zoom)],
    ['maxzoom',     String(zoom)],
  ]) db.run('INSERT INTO metadata VALUES(?,?)', [k, v]);

  const ins   = db.prepare('INSERT OR REPLACE INTO tiles VALUES(?,?,?,?)');
  const total = tiles.length;
  let done = 0, inserted = 0, errs = 0;
  let diagDone = false;

  const firstRes = tileResolutionWGS84(tiles[0].row, tiles[0].L).toFixed(1);
  log(`${total} tuile(s) WGS84G — niveau ${zoom} — ~${firstRes} m/px`, 'info');

  for (let i = 0; i < total; i += CONCUR) {
    if (ST.ac.signal.aborted) throw new Error('Annulé');

    const batch = tiles.slice(i, i + CONCUR);

    const results = await Promise.allSettled(
      batch.map(async ({ L, col, row }) => {
        const elev  = await fetchMNTtile(col, row, L);   // Float32Array 256×256
        const cellM = tileResolutionWGS84(row, L);
        const slope = computeSlope(elev, TILE_PX, TILE_PX, cellM);
        const png   = await slopeToPNG(slope, TILE_PX, TILE_PX, seuilDeg);

        // Convertir WGS84G (col, row, L) → XYZ PM (xPM, yPM) pour MBTiles
        // On utilise le centre de la tuile WGS84G comme référence
        const bb     = wgs84TileBBox(col, row, L);
        const cLon   = (bb.minLon + bb.maxLon) / 2;
        const cLat   = (bb.minLat + bb.maxLat) / 2;
        const nPM    = 1 << zoom;
        const xPM    = Math.floor((cLon + 180) / 360 * nPM);
        const yPM_xyz = Math.floor(
          (1 - Math.log(Math.tan(cLat * Math.PI / 180) + 1 / Math.cos(cLat * Math.PI / 180)) / Math.PI) / 2 * nPM
        );
        const yPM_tms = nPM - 1 - yPM_xyz;   // convention TMS (Y inversé)

        // Stats élévatoires pour le diagnostic
        let mn = Infinity, mx = -Infinity;
        for (let p = 0; p < elev.length; p++) {
          if (elev[p] > NODATA) { mn = Math.min(mn, elev[p]); mx = Math.max(mx, elev[p]); }
        }
        return { L, col, row, xPM, yPM_tms, png, elevMin: mn, elevMax: mx };
      })
    );

    for (let j = 0; j < batch.length; j++) {
      done++;
      const { L, col, row } = batch[j];

      if (results[j].status === 'fulfilled') {
        const { xPM, yPM_tms, png, elevMin, elevMax } = results[j].value;

        if (!diagDone) {
          diagDone = true;
          log(`Diag 1ère tuile L${L}/${col}/${row} → PM z${zoom}/${xPM}/${yPM_tms} — BIL OK — élév [${elevMin.toFixed(1)}, ${elevMax.toFixed(1)}] m — PNG ${png.length} bytes`, 'info');
        }

        try {
          ins.run([zoom, xPM, yPM_tms, Array.from(png)]);
          inserted++;
        } catch (sqlErr) {
          errs++;
          log(`✗ SQL L${L}/${col}/${row} : ${sqlErr.message}`, 'err');
        }
      } else {
        errs++;
        log(`✗ WMTS L${L}/${col}/${row} : ${results[j].reason?.message}`, 'warn');
      }
    }

    await prog(
      `Tuiles ${done}/${total} — ${inserted} insérées${errs ? ` (${errs} erreurs)` : ''}`,
      15 + 80 * (done / total)
    );
  }

  ins.free();

  if (inserted === 0) {
    db.close();
    throw new Error(`Aucune tuile insérée sur ${total} (${errs} erreurs). Zone hors couverture LIDAR IGN ?`);
  }

  log(`SQLite : ${inserted}/${total} tuiles — export…`, inserted < total ? 'warn' : 'ok');
  await prog('Export SQLite…', 97);

  const raw  = db.export();
  const data = raw.slice();
  db.close();

  if (data.byteLength < 4096) throw new Error(`Export SQLite anormalement petit (${data.byteLength} bytes).`);
  return data;
}

// ── DÉCLENCHEUR TÉLÉCHARGEMENT ─────────────────────────────────────
function triggerDL(data, zoom, seuilDeg) {
  try {
    const blob = new Blob([data], { type: 'application/x-sqlite3' });
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

  const zoom     = parseInt($('tileZoom').value)  || 14;
  const seuilDeg = parseFloat($('seuilDeg').value) || 45;

  log(`▶ niveau WGS84G=${zoom}  seuil blanc=${seuilDeg}°`, 'info');

  try {
    await prog('Calcul de la grille de tuiles WGS84G…', 5);
    const tiles = bboxToTileList(ST.bbox, zoom);
    if (!tiles.length) throw new Error('Aucune tuile dans la zone.');

    if (tiles.length > 500)
      log(`⚠ ${tiles.length} tuiles — zone large ou niveau élevé. Peut être très long.`, 'warn');

    log(`Grille WGS84G : ${tiles.length} tuile(s) — niveau ${zoom} — ~${tileResolutionWGS84(tiles[0].row, zoom).toFixed(1)} m/px`, 'ok');

    await prog('Démarrage assemblage MBTiles…', 8);
    const mbt = await buildMBT(tiles, zoom, seuilDeg);
    ST.mbt = mbt;

    const sz = mbt.byteLength > 1048576
      ? `${(mbt.byteLength / 1048576).toFixed(2)} Mo`
      : `${(mbt.byteLength / 1024).toFixed(0)} Ko`;

    log(`MBTiles pente : ${sz}  (${tiles.length} tuile(s))`, 'ok');

    await prog('Téléchargement…', 99);
    triggerDL(mbt, zoom, seuilDeg);
    await prog('✓ Terminé', 100);
    setStatus('done');
    $('mbtSize').textContent = sz;
    $('mbtName').textContent = `lidar_pente_z${zoom}_s${seuilDeg}.mbtiles`;
    dlEl.classList.add('visible');
    log("✓ Terminé. Cliquez sur le bouton si le téléchargement n'a pas démarré.", 'ok');

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

log('LIDAR_PENTE v1.2 prêt. Dessinez un rectangle sur la carte.', 'ok');
