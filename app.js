/* ═══════════════════════════════════════════════════════════════
   LIDAR_PENTE v3.2.0
   Détection d'irrégularités topographiques sur l'estran
   ───────────────────────────────────────────────────────────────
   Étape 1 : Rectangle → MNT BIL WMTS → masque estran [BMVE, PMVE]
             → polygone estran affiché sur la carte
   Étape 2 : WMTS LIDAR BIL float32 uniquement sur les tuiles
             intersectant l'estran → calcul pente Horn → grille pente
   Étape 3 : Visualiseur niveaux de gris + curseurs seuil min/max
   Étape 4 : Export MBTiles PNG
   ───────────────────────────────────────────────────────────────
   Déploiement : BernardHoyez.github.io/lidar
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ─────────────────────────────────────────────────────
const IGN_ALTI    = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_WMTS    = 'https://data.geopf.fr/wmts';
const ALTI_RES    = 'ign_rge_alti_wld';
const MNT_LAYER   = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MNT_FMT     = 'image/x-bil;bits=32';
const MNT_TMS     = 'WGS84G';
const WGS84G_LMIN = 6;   // niveaux disponibles pour HIGHRES (GetCapabilities)
const WGS84G_LMAX = 14;  // au-delà → HTTP 404
const BIL_NODATA  = -99999; // noDataValue IGN officiel
const TILE_PX     = 256;
const BATCH       = 40;
const DELAY_MS    = 230;
const CONCUR      = 3;
const MIN_AREA    = 1000;
const SIMP_TOL    = 0.00004;

// ── STATE ──────────────────────────────────────────────────────────
const ST = {
  bbox  : null,
  mask  : null, cols: 0, rows: 0,   // masque estran
  poly  : null,                      // GeoJSON estran vectorisé
  slope : null,                      // Float32Array pentes (coord. tuile PM)
  tiles : null,                      // [{z,x,y}] tuiles PM sélectionnées
  mbt   : null,
  ac    : null,
  t0    : Date.now()
};

// ── DOM ────────────────────────────────────────────────────────────
const $     = id => document.getElementById(id);
const logEl = $('logArea');
const barEl = $('progressFill');
const lblEl = $('progressLabel');
const pctEl = $('progressPct');
const statEl= $('globalStatus');
const dlEl  = $('downloadZone');

function ts(){
  const s=Math.floor((Date.now()-ST.t0)/1000);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function log(msg,lv='info'){
  const d=document.createElement('div');
  d.className='log-line '+lv;
  d.innerHTML=`<span class="ts">${ts()}</span><span class="msg">${msg}</span>`;
  logEl.appendChild(d);
  logEl.scrollTop=logEl.scrollHeight;
}
function prog(label,pct){
  lblEl.textContent=label;
  pctEl.textContent=Math.round(pct)+'%';
  barEl.style.width=Math.min(100,pct)+'%';
  return new Promise(r=>setTimeout(r,4));
}
function setStatus(s){
  const CL={idle:'chip-idle',run:'chip-running',done:'chip-done',err:'chip-error'};
  const LB={idle:'Prêt',run:'En cours…',done:'Terminé ✓',err:'Erreur'};
  statEl.className='status-chip '+(CL[s]||'chip-idle');
  statEl.innerHTML=`<span class="dot"></span>${LB[s]||s}`;
}

// ── CARTE LEAFLET ──────────────────────────────────────────────────
const map=L.map('map',{center:[50.5,1.6],zoom:11});
// Forcer Leaflet à recalculer la taille après que le DOM flex soit résolu
L.tileLayer(
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'+
  '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png'+
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  {attribution:'© IGN',maxZoom:19}
).addTo(map);

const drawn=new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  draw:{rectangle:{shapeOptions:{color:'#00c8a0',weight:2}},
        polygon:false,polyline:false,circle:false,circlemarker:false,marker:false},
  edit:{featureGroup:drawn,remove:true}
}));

let estranLyr=null;

map.on(L.Draw.Event.CREATED,e=>{
  drawn.clearLayers(); drawn.addLayer(e.layer);
  const b=e.layer.getBounds();
  ST.bbox={minLon:b.getWest(),minLat:b.getSouth(),maxLon:b.getEast(),maxLat:b.getNorth()};
  resetState();
  updateCoords();
  log(`Zone : [${ST.bbox.minLon.toFixed(4)}, ${ST.bbox.minLat.toFixed(4)}] → [${ST.bbox.maxLon.toFixed(4)}, ${ST.bbox.maxLat.toFixed(4)}]`,'ok');
  uiEnable(true);
});
map.on(L.Draw.Event.DELETED,()=>{ST.bbox=null;resetState();updateCoords();uiEnable(false);});

const mapInfo=$('mapInfo');
map.on('mousemove',e=>{mapInfo.style.display='block';mapInfo.textContent=`${e.latlng.lng.toFixed(5)}°E  ${e.latlng.lat.toFixed(5)}°N`;});
map.on('mouseout',()=>{mapInfo.style.display='none';});

function resetState(){
  ST.mask=ST.poly=ST.slope=ST.tiles=ST.mbt=null;
  ST.cols=ST.rows=0;
  if(estranLyr){map.removeLayer(estranLyr);estranLyr=null;}
  dlEl.classList.remove('visible');
  $('visuSection').style.display='none';
}
function updateCoords(){
  const b=ST.bbox;
  $('cLonMin').textContent=b?b.minLon.toFixed(4):'—';
  $('cLonMax').textContent=b?b.maxLon.toFixed(4):'—';
  $('cLatMin').textContent=b?b.minLat.toFixed(4):'—';
  $('cLatMax').textContent=b?b.maxLat.toFixed(4):'—';
}
function uiEnable(on){
  $('btnClear').disabled   = !on;
  $('btnEstran').disabled  = !on;
  ['step2title','step3title'].forEach(id=>$(id).classList.toggle('inactive',!on));
}

$('btnClear').addEventListener('click',()=>{
  drawn.clearLayers();
  ST.bbox=null;
  resetState();
  updateCoords();
  uiEnable(false);
  prog('En attente',0);setStatus('idle');
  log('Zone effacée.','warn');
});

// ── FETCH AVEC ABORT ───────────────────────────────────────────────
async function apiFetch(url){
  if(!ST.ac||ST.ac.signal.aborted) throw new Error('Annulé');
  const r=await fetch(url,{signal:ST.ac.signal});
  if(!r.ok) throw new Error(`HTTP ${r.status} — ${url.slice(0,80)}`);
  return r;
}

// ═══════════════════════════════════════════════════════════════════
//  ÉTAPE 1 : ESTRAN
//  MNT depuis tuiles WMTS BIL (même source que pentes, bien plus dense)
//  → masque [BMVE, PMVE] → polygone → carte
// ═══════════════════════════════════════════════════════════════════

// ── MNT depuis WMTS BIL ─────────────────────────────────────────────
// On télécharge toutes les tuiles WGS84G couvrant la bbox au niveau L,
// on les assemble en une grille d'altitudes dense, puis on applique le masque.
async function getMNT(bbox, mntZoom) {
  // Niveau WGS84G : utiliser le niveau demandé, clampé dans [6,14]
  const L = Math.max(WGS84G_LMIN, Math.min(WGS84G_LMAX, mntZoom));

  // Tuiles WGS84G couvrant la bbox
  const nC = wgs84Cols(L), nR = wgs84Rows(L);
  const col0 = Math.max(0, Math.floor((bbox.minLon + 180) / 360 * nC));
  const col1 = Math.min(nC-1, Math.floor((bbox.maxLon + 180) / 360 * nC));
  const row0 = Math.max(0, Math.floor((90 - bbox.maxLat) / 180 * nR));
  const row1 = Math.min(nR-1, Math.floor((90 - bbox.minLat) / 180 * nR));

  const tilesCols = col1 - col0 + 1;
  const tilesRows = row1 - row0 + 1;
  const nTiles = tilesCols * tilesRows;

  // Grille résultante : assemblage de TILE_PX×TILE_PX par tuile
  const gCols = tilesCols * TILE_PX;
  const gRows = tilesRows * TILE_PX;
  const grid  = new Float32Array(gCols * gRows).fill(NaN);

  // BBox réelle couverte par l'assemblage (pas exactement == bbox demandée)
  const tl = wgs84TileBBox(col0, row0, L);
  const br = wgs84TileBBox(col1, row1, L);
  const gridBBox = {
    minLon: tl.minLon, maxLon: br.maxLon,
    minLat: br.minLat, maxLat: tl.maxLat
  };

  const resM = tileResWGS84(row0, L).toFixed(1);
  log(`Grille MNT BIL : ${tilesCols}×${tilesRows} tuiles WGS84G L=${L} → ${gCols}×${gRows} px (~${resM} m/px)`, 'info');
  await prog(`MNT 0/${nTiles} tuiles`, 3);

  let done = 0, errs = 0;
  const tileList = [];
  for (let tc = col0; tc <= col1; tc++)
    for (let tr = row0; tr <= row1; tr++)
      tileList.push({tc, tr});

  for (let i = 0; i < tileList.length; i += CONCUR) {
    if (ST.ac.signal.aborted) throw new Error('Annulé');
    const batch = tileList.slice(i, i + CONCUR);
    const results = await Promise.allSettled(batch.map(({tc, tr}) => fetchBILcached(tc, tr, L)));
    for (let j = 0; j < batch.length; j++) {
      const {tc, tr} = batch[j];
      if (results[j].status === 'fulfilled') {
        const bil = results[j].value;
        // Copier les TILE_PX×TILE_PX valeurs dans la grille assemblée
        const offX = (tc - col0) * TILE_PX;
        const offY = (tr - row0) * TILE_PX;
        for (let py = 0; py < TILE_PX; py++) {
          for (let px = 0; px < TILE_PX; px++) {
            const v = bil[py * TILE_PX + px];
            grid[(offY + py) * gCols + (offX + px)] = (v < BIL_NODATA / 2) ? NaN : v;
          }
        }
      } else {
        errs++;
        log(`✗ MNT tuile L${L}/${tc}/${tr} : ${results[j].reason?.message}`, 'warn');
      }
      done++;
    }
    await prog(`MNT ${done}/${nTiles} tuiles${errs ? ` (${errs} err)` : ''}`, 3 + 27*(done/nTiles));
  }

  let vmin=Infinity, vmax=-Infinity, nv=0;
  for (const v of grid) if (!isNaN(v)) { if(v<vmin) vmin=v; if(v>vmax) vmax=v; nv++; }
  log(`MNT BIL : ${nv}/${gCols*gRows} px valides — alt. ${vmin.toFixed(1)} / ${vmax.toFixed(1)} m NGF`, 'ok');

  return { grid, cols: gCols, rows: gRows, bbox: gridBBox };
}

// ── Masque estran — flood-fill depuis la mer ───────────────────────
// Stratégie :
// 1. Identifier les cellules "mer" = v < bmve ou NaN côté mer
// 2. Flood-fill depuis les bords du domaine pour trouver toute la mer connexe
// 3. L'estran = cellules v <= pmve ET connectées (voisines) à la zone mer
//    → on dilate la zone mer jusqu'à pmve
function makeMaskEstran(grid, cols, rows, bmve, pmve) {
  const SEA  = 1;  // mer (< bmve ou NaN connecté à la mer)
  const INTR = 2;  // estran [bmve, pmve]
  const state = new Uint8Array(cols * rows); // 0=terre/inconnu

  // Passe 1 : classer les cellules connues
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i];
    if (isNaN(v) || v < bmve)       state[i] = SEA;
    else if (v <= pmve)             state[i] = INTR;
    // v > pmve → 0 (terre, hors estran)
  }

  // Passe 2 : flood-fill BFS depuis tous les bords marqués SEA
  // pour ne garder que la mer connexe à l'extérieur
  // (évite d'inclure des mares intérieures isolées comme mer)
  const seaConnected = new Uint8Array(cols * rows);
  const queue = [];

  // Amorcer depuis les 4 bords
  for (let c = 0; c < cols; c++) {
    if (state[c] === SEA)                    { seaConnected[c] = 1; queue.push(c); }
    const bot = (rows-1)*cols + c;
    if (state[bot] === SEA)                  { seaConnected[bot] = 1; queue.push(bot); }
  }
  for (let r = 0; r < rows; r++) {
    const l = r*cols, ri = r*cols + cols-1;
    if (state[l]  === SEA) { seaConnected[l]  = 1; queue.push(l); }
    if (state[ri] === SEA) { seaConnected[ri] = 1; queue.push(ri); }
  }

  // BFS — la mer connexe peut traverser des cellules NaN (estuaires, chenaux)
  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    const r = Math.floor(i / cols), c = i % cols;
    const nbrs = [];
    if (c > 0)       nbrs.push(i - 1);
    if (c < cols-1)  nbrs.push(i + 1);
    if (r > 0)       nbrs.push(i - cols);
    if (r < rows-1)  nbrs.push(i + cols);
    for (const j of nbrs) {
      if (!seaConnected[j] && state[j] === SEA) {
        seaConnected[j] = 1;
        queue.push(j);
      }
    }
  }

  // Passe 3 : l'estran final = cellules INTR adjacentes à la mer connexe
  // On dilate la mer connexe vers les cellules INTR (BFS de l'estran)
  const mask = new Uint8Array(cols * rows);
  const q2 = [];

  // Amorcer : cellules INTR voisines d'une cellule mer connexe
  for (let i = 0; i < cols * rows; i++) {
    if (state[i] !== INTR) continue;
    const r = Math.floor(i / cols), c = i % cols;
    const nbrs = [];
    if (c > 0)       nbrs.push(i - 1);
    if (c < cols-1)  nbrs.push(i + 1);
    if (r > 0)       nbrs.push(i - cols);
    if (r < rows-1)  nbrs.push(i + cols);
    if (nbrs.some(j => seaConnected[j])) {
      mask[i] = 1;
      q2.push(i);
    }
  }

  // BFS de l'estran connexe
  let q2i = 0;
  while (q2i < q2.length) {
    const i = q2[q2i++];
    const r = Math.floor(i / cols), c = i % cols;
    const nbrs = [];
    if (c > 0)       nbrs.push(i - 1);
    if (c < cols-1)  nbrs.push(i + 1);
    if (r > 0)       nbrs.push(i - cols);
    if (r < rows-1)  nbrs.push(i + cols);
    for (const j of nbrs) {
      if (!mask[j] && state[j] === INTR) {
        mask[j] = 1;
        q2.push(j);
      }
    }
  }

  return mask;
}

// ── Marching Squares ───────────────────────────────────────────────
function maskToSegs(mask,cols,rows,bbox){
  const cW=(bbox.maxLon-bbox.minLon)/cols;
  const cH=(bbox.maxLat-bbox.minLat)/rows;
  const p2w=([px,py])=>[bbox.minLon+px*cW,bbox.maxLat-py*cH];
  const segs=[];
  for(let r=0;r<rows-1;r++){
    for(let c=0;c<cols-1;c++){
      const tl=mask[r*cols+c],tr=mask[r*cols+c+1];
      const bl=mask[(r+1)*cols+c],br=mask[(r+1)*cols+c+1];
      const idx=(tl<<3)|(tr<<2)|(br<<1)|bl;
      if(idx===0||idx===15) continue;
      const T=[c+.5,r],B=[c+.5,r+1],L=[c,r+.5],R=[c+1,r+.5];
      const T_={1:[[L,B]],2:[[B,R]],3:[[L,R]],4:[[T,R]],
                5:[[T,R],[B,L]],6:[[T,B]],7:[[T,L]],
                8:[[T,L]],9:[[T,B]],10:[[T,L],[B,R]],
                11:[[T,R]],12:[[L,R]],13:[[B,R]],14:[[L,B]]};
      for(const s of (T_[idx]||[])) segs.push([p2w(s[0]),p2w(s[1])]);
    }
  }
  return segs;
}
function assembleRings(segs){
  if(!segs.length) return [];
  const EPS=1e-9;
  const eq=([ax,ay],[bx,by])=>Math.abs(ax-bx)<EPS&&Math.abs(ay-by)<EPS;
  const used=new Uint8Array(segs.length);
  const rings=[];
  for(let s=0;s<segs.length;s++){
    if(used[s]) continue;
    used[s]=1;
    const ring=[segs[s][0],segs[s][1]];
    let go=true;
    while(go){
      go=false;
      const tail=ring[ring.length-1];
      for(let j=0;j<segs.length;j++){
        if(used[j]) continue;
        if(eq(segs[j][0],tail)){ring.push(segs[j][1]);used[j]=1;go=true;break;}
        if(eq(segs[j][1],tail)){ring.push(segs[j][0]);used[j]=1;go=true;break;}
      }
    }
    if(ring.length>=4) rings.push(ring);
  }
  return rings;
}
const eq2=(a,b)=>Math.abs(a[0]-b[0])<1e-9&&Math.abs(a[1]-b[1])<1e-9;
function dropSmall(gj){
  if(!gj) return null;
  const t=gj.geometry.type;
  if(t==='Polygon') return turf.area(gj)>=MIN_AREA?gj:null;
  if(t==='MultiPolygon'){
    const ok=gj.geometry.coordinates.filter(c=>turf.area(turf.polygon(c))>=MIN_AREA);
    if(!ok.length) return null;
    return ok.length===1?turf.polygon(ok[0]):turf.multiPolygon(ok);
  }
  return gj;
}
function maskToGeoJSON(mask,cols,rows,bbox){
  const segs=maskToSegs(mask,cols,rows,bbox);
  if(!segs.length) return null;
  const rings=assembleRings(segs);
  if(!rings.length) return null;
  log(`${rings.length} anneau(x) extraits`,'info');
  const closed=rings.map(r=>{
    const rr=[...r];
    if(!eq2(rr[0],rr[rr.length-1])) rr.push(rr[0]);
    return rr;
  }).filter(r=>r.length>=4);
  if(!closed.length) return null;
  const gj=closed.length===1?turf.polygon([closed[0]]):turf.multiPolygon(closed.map(r=>[r]));
  let simp;
  try{simp=turf.simplify(gj,{tolerance:SIMP_TOL,highQuality:false});}
  catch{simp=gj;}
  return dropSmall(simp);
}

// ── Tuiles XYZ PM depuis masque ────────────────────────────────────
const lon2x=(lon,z)=>Math.floor((lon+180)/360*(1<<z));
const lat2y=(lat,z)=>Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*(1<<z));

function tilesFromMask(mask,cols,rows,bbox,zoom){
  const cW=(bbox.maxLon-bbox.minLon)/cols;
  const cH=(bbox.maxLat-bbox.minLat)/rows;
  const tileSet=new Set();
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      if(!mask[r*cols+c]) continue;
      const lon=bbox.minLon+(c+0.5)*cW;
      const lat=bbox.maxLat-(r+0.5)*cH;
      const tx=lon2x(lon,zoom),ty=lat2y(lat,zoom);
      tileSet.add(`${zoom}/${tx}/${ty}`);
      for(let dx=-1;dx<=1;dx++) for(let dy=-1;dy<=1;dy++){
        if(dx||dy) tileSet.add(`${zoom}/${tx+dx}/${ty+dy}`);
      }
    }
  }
  return [...tileSet].map(k=>{const[z,x,y]=k.split('/').map(Number);return{z,x,y};});
}

// ── FONCTIONS WMTS LIDAR ───────────────────────────────────────────

// TileMatrixSet WGS84G
const wgs84Cols=L=>1<<(L+1);
const wgs84Rows=L=>1<<L;
function ll2wgs84(lon,lat,L){
  const nC=wgs84Cols(L),nR=wgs84Rows(L);
  return{
    col:Math.max(0,Math.min(nC-1,Math.floor((lon+180)/360*nC))),
    row:Math.max(0,Math.min(nR-1,Math.floor((90-lat)/180*nR)))
  };
}
function tileResWGS84(row,L){
  const nR=wgs84Rows(L);
  return 180/nR/TILE_PX*111320; // m/px
}

// Convertit tuile XYZ PM → tuile WGS84G au niveau L clampé dans [6,14]
function pm2wgs84(x, y, z, L) {
  const wgsL = Math.max(WGS84G_LMIN, Math.min(WGS84G_LMAX, L));
  const n = 1 << z;
  const lon = (x + 0.5) / n * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2*(y+0.5)/n))) * 180 / Math.PI;
  return { ...ll2wgs84(lon, lat, wgsL), wgsL };
}

// Fetch BIL float32
async function fetchBIL(col,row,L){
  const url=IGN_WMTS
    +`?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile`
    +`&LAYER=${MNT_LAYER}&STYLE=normal`
    +`&FORMAT=${encodeURIComponent(MNT_FMT)}`
    +`&TILEMATRIXSET=${MNT_TMS}`
    +`&TILEMATRIX=${L}&TILEROW=${row}&TILECOL=${col}`;
  const resp=await apiFetch(url);
  const ct=resp.headers.get('content-type')||'';
  if(ct.includes('xml')||ct.includes('html')||ct.includes('text')){
    const txt=await resp.text();
    throw new Error(`WMTS erreur: ${txt.slice(0,100)}`);
  }
  const buf=await resp.arrayBuffer();
  if(buf.byteLength<TILE_PX*TILE_PX*4)
    throw new Error(`BIL trop court (${buf.byteLength}b)`);
  return new Float32Array(buf,0,TILE_PX*TILE_PX);
}

// Cache BIL
const bilCache=new Map();
async function fetchBILcached(col,row,L){
  const k=`${L}/${col}/${row}`;
  if(bilCache.has(k)) return bilCache.get(k);
  const bil=await fetchBIL(col,row,L);
  bilCache.set(k,bil);
  return bil;
}

// Algorithme de Horn — pente en degrés
function hornSlope(elev, w, h, cellM) {
  const slope = new Float32Array(w*h).fill(NaN);
  for (let r = 1; r < h-1; r++) {
    for (let c = 1; c < w-1; c++) {
      const i = r*w+c;
      if (elev[i] <= BIL_NODATA/2) continue;  // nodata IGN ≈ -99999
      const fix = v => (v <= BIL_NODATA/2 ? elev[i] : v);
      const a=fix(elev[(r-1)*w+(c-1)]), b=fix(elev[(r-1)*w+c]), cc=fix(elev[(r-1)*w+(c+1)]);
      const d=fix(elev[r*w+(c-1)]),                               f=fix(elev[r*w+(c+1)]);
      const g=fix(elev[(r+1)*w+(c-1)]), hh=fix(elev[(r+1)*w+c]), ii=fix(elev[(r+1)*w+(c+1)]);
      const dzdx = ((cc + 2*f + ii) - (a + 2*d + g)) / (8*cellM);
      const dzdy = ((g + 2*hh + ii) - (a + 2*b + cc)) / (8*cellM);
      slope[i] = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy)) * 180 / Math.PI;
    }
  }
  return slope;
}

// Rendu canvas niveaux de gris
function renderTilePNG(slope,sMin,sMax){
  const canvas=document.createElement('canvas');
  canvas.width=canvas.height=TILE_PX;
  const ctx=canvas.getContext('2d');
  const id=ctx.createImageData(TILE_PX,TILE_PX);
  const px=id.data;
  const range=sMax-sMin||1;
  for(let i=0;i<TILE_PX*TILE_PX;i++){
    const v=slope[i];
    let g=0;
    if(!isNaN(v)&&v>=sMin) g=Math.min(255,Math.round((v-sMin)/range*255));
    px[i*4]=px[i*4+1]=px[i*4+2]=g; px[i*4+3]=255;
  }
  ctx.putImageData(id,0,0);
  return canvas;
}

// Canvas → PNG Uint8Array
async function canvasToPNG(canvas){
  if(typeof OffscreenCanvas!=='undefined'){
    const oc=new OffscreenCanvas(TILE_PX,TILE_PX);
    oc.getContext('2d').drawImage(canvas,0,0);
    const blob=await oc.convertToBlob({type:'image/png'});
    return new Uint8Array(await blob.arrayBuffer());
  }
  const b64=canvas.toDataURL('image/png').split(',')[1];
  const bin=atob(b64);
  const arr=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) arr[i]=bin.charCodeAt(i);
  return arr;
}

// ── PIPELINE ───────────────────────────────────────────────────────
$('btnEstran').addEventListener('click',async()=>{
  if(!ST.bbox) return;
  ST.t0=Date.now();
  ST.ac=new AbortController();
  $('btnEstran').disabled=true;
  $('btnAbort').disabled=false;
  setStatus('run');
  resetState();

  const bmve   = parseFloat($('bmveAlt').value)||-3;
  const pmve   = parseFloat($('pmveAlt').value)||5;
  const zoom   = parseInt($('tileZoom').value)||14;
  log(`▶ BMVE=${bmve}m  PMVE=${pmve}m  zoom=${zoom}`, 'info');

  try{
    // ── ÉTAPE 1 : MNT BIL → masque estran → polygone ─────────────
    await prog('Téléchargement MNT BIL (tuiles WGS84G)…', 2);
    const {grid, cols, rows, bbox: gridBBox} = await getMNT(ST.bbox, zoom);

    await prog('Construction masque estran…', 33);
    const mask = makeMaskEstran(grid, cols, rows, bmve, pmve);
    const nCells = mask.reduce((s,v) => s+v, 0);
    log(`Masque estran : ${nCells}/${cols*rows} cellules`, 'info');
    if(!nCells) throw new Error(`Aucune cellule entre ${bmve} m et ${pmve} m NGF.`);

    await prog('Vectorisation…', 36);
    const poly = maskToGeoJSON(mask, cols, rows, gridBBox);
    if(!poly) throw new Error('Vectorisation échouée — élargissez la zone ou ajustez les seuils.');

    ST.mask=mask; ST.cols=cols; ST.rows=rows; ST.poly=poly; ST.gridBBox=gridBBox;
    const ha = (turf.area(poly)/10000).toFixed(1);
    log(`Polygone estran : ${ha} ha`, 'ok');
    estranLyr = L.geoJSON(poly, {
      style:{color:'#00c8a0',weight:2,fillColor:'#00c8a0',fillOpacity:0.22}
    }).addTo(map);

    // ── ÉTAPE 2 : tuiles LIDAR → pentes Horn ──────────────────────
    await prog('Sélection tuiles depuis masque…', 40);
    const tilesXYZ = tilesFromMask(ST.mask, ST.cols, ST.rows, gridBBox, zoom);
    log(`${tilesXYZ.length} tuile(s) intersectant l'estran`,'ok');
    if(!tilesXYZ.length) throw new Error('Aucune tuile sélectionnée.');
    if(tilesXYZ.length>2000) log(`⚠ ${tilesXYZ.length} tuiles — peut être long.`,'warn');
    ST.tiles=tilesXYZ;

    ST.tileSlopes=new Map();
    bilCache.clear();

    const total=tilesXYZ.length;
    let done=0,errs=0;

    for(let i=0;i<total;i+=CONCUR){
      if(ST.ac.signal.aborted) throw new Error('Annulé');
      const batch=tilesXYZ.slice(i,i+CONCUR);
      const results = await Promise.allSettled(batch.map(async ({z, x, y}) => {
        const wgsL = Math.max(WGS84G_LMIN, Math.min(WGS84G_LMAX, z-1));
        const {col, row} = pm2wgs84(x, y, z, wgsL);
        const elev = await fetchBILcached(col, row, wgsL);
        const cellM = tileResWGS84(row, wgsL);
        const slope = hornSlope(elev, TILE_PX, TILE_PX, cellM);
        return {z, x, y, slope};
      }));
      for(let j=0;j<batch.length;j++){
        done++;
        if(results[j].status==='fulfilled'){
          const{z,x,y,slope}=results[j].value;
          ST.tileSlopes.set(`${z}/${x}/${y}`,slope);
        }else{
          errs++;
          const{z,x,y}=batch[j];
          log(`✗ ${z}/${x}/${y} : ${results[j].reason?.message}`,'warn');
        }
      }
      await prog(`Pentes ${done}/${total}${errs?` (${errs} err)`:''}`,42+53*(done/total));
    }

    if(ST.tileSlopes.size===0) throw new Error(`Aucune pente calculée (${errs} erreurs).`);

    // Stats et init curseurs
    let pmin=Infinity,pmax=-Infinity;
    for(const slope of ST.tileSlopes.values())
      for(const v of slope) if(!isNaN(v)){pmin=Math.min(pmin,v);pmax=Math.max(pmax,v);}
    log(`Pentes : [${pmin.toFixed(1)}°, ${pmax.toFixed(1)}°] sur ${ST.tileSlopes.size} tuile(s)`,'ok');

    $('sMin').min=$('sMax').min=pmin.toFixed(1);
    $('sMin').max=$('sMax').max=pmax.toFixed(1);
    $('sMin').value=pmin.toFixed(1);
    $('sMax').value=pmax.toFixed(1);
    updateSliderLabels();

    await prog('✓ Terminé',100);
    setStatus('done');
    uiEnable(true);
    renderVisu();
    log('✓ Pentes calculées. Ajustez les curseurs puis exportez.','ok');

  }catch(e){
    if(e.message==='Annulé'){log('Annulé.','warn');setStatus('idle');await prog('Annulé',0);}
    else{log('ERREUR : '+e.message,'err');setStatus('err');await prog('Erreur',0);}
  }finally{
    $('btnEstran').disabled=false;
    $('btnAbort').disabled=true;
    ST.ac=null;
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ÉTAPE 3 : VISUALISEUR NIVEAUX DE GRIS + CURSEURS
// ═══════════════════════════════════════════════════════════════════

function updateSliderLabels(){
  $('lblSMin').textContent=parseFloat($('sMin').value).toFixed(1)+'°';
  $('lblSMax').textContent=parseFloat($('sMax').value).toFixed(1)+'°';
}
$('sMin').addEventListener('input',()=>{
  if(parseFloat($('sMin').value)>parseFloat($('sMax').value))
    $('sMax').value=$('sMin').value;
  updateSliderLabels();renderVisu();
});
$('sMax').addEventListener('input',()=>{
  if(parseFloat($('sMax').value)<parseFloat($('sMin').value))
    $('sMin').value=$('sMax').value;
  updateSliderLabels();renderVisu();
});

function renderVisu(){
  if(!ST.tileSlopes||ST.tileSlopes.size===0) return;
  const sMin=parseFloat($('sMin').value);
  const sMax=parseFloat($('sMax').value);

  // Emprise des tuiles PM
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity,z0=14;
  for(const k of ST.tileSlopes.keys()){
    const[z,x,y]=k.split('/').map(Number);
    z0=z; x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y);
  }
  const cols=x1-x0+1, rows=y1-y0+1;
  const W=cols*TILE_PX, H=rows*TILE_PX;

  // Canvas interne pleine résolution
  const canvas=$('visuCanvas');
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#111'; ctx.fillRect(0,0,W,H);

  // Convertisseur lon/lat → pixel dans ce canvas
  const nPM=1<<z0;
  const lon2px=lon=>((lon+180)/360*nPM - x0)*TILE_PX;
  const lat2px=lat=>((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*nPM - y0)*TILE_PX;

  // Dessiner les tuiles pente
  for(const[k,slope] of ST.tileSlopes){
    const[z,x,y]=k.split('/').map(Number);
    const tc=renderTilePNG(slope,sMin,sMax);
    ctx.drawImage(tc,(x-x0)*TILE_PX,(y-y0)*TILE_PX);
  }

  // Masquer les pixels hors polygone estran (remplir l'extérieur en noir)
  if(ST.poly){
    ctx.save();
    // Créer un path du polygone estran
    const addRing=coords=>{
      ctx.moveTo(lon2px(coords[0][0]),lat2px(coords[0][1]));
      for(let i=1;i<coords.length;i++) ctx.lineTo(lon2px(coords[i][0]),lat2px(coords[i][1]));
      ctx.closePath();
    };
    // Remplir tout le canvas en noir, puis "découper" l'estran en transparent
    ctx.globalCompositeOperation='destination-in';
    ctx.beginPath();
    const geo=ST.poly.geometry;
    if(geo.type==='Polygon') addRing(geo.coordinates[0]);
    else geo.coordinates.forEach(p=>addRing(p[0]));
    ctx.fillStyle='rgba(0,0,0,1)';
    ctx.fill('evenodd');
    ctx.restore();

    // Fond noir sous le canvas (les zones transparentes apparaîtront noires)
    // → on va recréer l'image avec fond noir + dessin masqué
    const final=document.createElement('canvas');
    final.width=W; final.height=H;
    const fctx=final.getContext('2d');
    fctx.fillStyle='#111'; fctx.fillRect(0,0,W,H);
    fctx.drawImage(canvas,0,0);

    // Contour estran
    fctx.strokeStyle='#00c8a0'; fctx.lineWidth=2; fctx.setLineDash([6,3]);
    fctx.beginPath();
    if(geo.type==='Polygon') addRingCtx(fctx,geo.coordinates[0],lon2px,lat2px);
    else geo.coordinates.forEach(p=>addRingCtx(fctx,p[0],lon2px,lat2px));
    fctx.stroke(); fctx.setLineDash([]);

    canvas.width=W; canvas.height=H;
    canvas.getContext('2d').drawImage(final,0,0);
  }

  // Afficher l'overlay et réinitialiser le zoom
  $('visuSection').style.display='block';
  $('visuOverlay').style.display='flex';
  setTimeout(()=>window.visuResetZoom&&window.visuResetZoom(),50);
}

function addRingCtx(ctx,coords,lon2px,lat2px){
  ctx.moveTo(lon2px(coords[0][0]),lat2px(coords[0][1]));
  for(let i=1;i<coords.length;i++) ctx.lineTo(lon2px(coords[i][0]),lat2px(coords[i][1]));
  ctx.closePath();
}


// ── ZOOM / PAN du visualiseur ─────────────────────────────────────
(()=>{
  let scale=1, panX=0, panY=0;
  let panning=false, px0=0, py0=0, ox0=0, oy0=0;

  function applyTransform(){
    $('visuCanvas').style.transform=`translate(${panX}px,${panY}px) scale(${scale})`;
    $('visuZoomLbl').textContent=`zoom ${Math.round(scale*100)}%`;
  }

  function resetZoom(){
    const vp=$('visuViewport');
    const cv=$('visuCanvas');
    if(!cv.width||!cv.height){scale=1;panX=panY=0;applyTransform();return;}
    const scaleX=vp.clientWidth/cv.width;
    const scaleY=vp.clientHeight/cv.height;
    scale=Math.min(scaleX,scaleY,1); // jamais > 100% au départ
    panX=(vp.clientWidth -cv.width *scale)/2;
    panY=(vp.clientHeight-cv.height*scale)/2;
    applyTransform();
  }
  window.visuResetZoom=resetZoom; // appelé après renderVisu

  $('btnVisuReset').addEventListener('click',resetZoom);

  // Molette → zoom centré sur le curseur
  $('visuViewport').addEventListener('wheel',e=>{
    e.preventDefault();
    const rect=$('visuViewport').getBoundingClientRect();
    const mx=e.clientX-rect.left, my=e.clientY-rect.top;
    const factor=e.deltaY<0?1.2:1/1.2;
    const newScale=Math.max(0.1,Math.min(20,scale*factor));
    panX=mx-(mx-panX)*(newScale/scale);
    panY=my-(my-panY)*(newScale/scale);
    scale=newScale;
    applyTransform();
  },{passive:false});

  // Glisser
  $('visuViewport').addEventListener('mousedown',e=>{
    panning=true; px0=e.clientX; py0=e.clientY; ox0=panX; oy0=panY;
    $('visuViewport').style.cursor='grabbing';
  });
  window.addEventListener('mousemove',e=>{
    if(!panning) return;
    panX=ox0+(e.clientX-px0); panY=oy0+(e.clientY-py0);
    applyTransform();
  });
  window.addEventListener('mouseup',()=>{
    panning=false; $('visuViewport').style.cursor='grab';
  });

  // Touch pinch + pan
  let touches0=null, scale0=1, panX0=0, panY0=0;
  $('visuViewport').addEventListener('touchstart',e=>{
    if(e.touches.length===1){
      panning=true; px0=e.touches[0].clientX; py0=e.touches[0].clientY; ox0=panX; oy0=panY;
    } else if(e.touches.length===2){
      panning=false;
      touches0=[[e.touches[0].clientX,e.touches[0].clientY],[e.touches[1].clientX,e.touches[1].clientY]];
      scale0=scale; panX0=panX; panY0=panY;
    }
  },{passive:true});
  $('visuViewport').addEventListener('touchmove',e=>{
    e.preventDefault();
    if(e.touches.length===1&&panning){
      panX=ox0+(e.touches[0].clientX-px0); panY=oy0+(e.touches[0].clientY-py0);
      applyTransform();
    } else if(e.touches.length===2&&touches0){
      const d0=Math.hypot(touches0[1][0]-touches0[0][0],touches0[1][1]-touches0[0][1]);
      const d1=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
      scale=Math.max(0.1,Math.min(20,scale0*d1/d0));
      const rect=$('visuViewport').getBoundingClientRect();
      const cx=(e.touches[0].clientX+e.touches[1].clientX)/2-rect.left;
      const cy=(e.touches[0].clientY+e.touches[1].clientY)/2-rect.top;
      panX=cx-(cx-panX0)*(scale/scale0); panY=cy-(cy-panY0)*(scale/scale0);
      applyTransform();
    }
  },{passive:false});
  $('visuViewport').addEventListener('touchend',()=>{touches0=null;panning=false;});
})();

$('btnExport').addEventListener('click',async()=>{
  if(!ST.tileSlopes||ST.tileSlopes.size===0){log('Aucune pente disponible.','warn');return;}
  ST.t0=Date.now();
  ST.ac=new AbortController();
  $('btnExport').disabled=true;
  $('btnAbort').disabled=false;
  setStatus('run');

  const sMin=parseFloat($('sMin').value);
  const sMax=parseFloat($('sMax').value);
  const zoom=parseInt($('tileZoom').value)||14;
  log(`▶ Étape 4 — Export MBTiles sMin=${sMin.toFixed(1)}° sMax=${sMax.toFixed(1)}°`,'info');

  try{
    await prog('Chargement sql.js…',2);
    log('sql.js : chargement SQLite WASM…','info');
    const SQL=await initSqlJs({
      locateFile:f=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/${f}`
    });
    const db=new SQL.Database();
    db.run('CREATE TABLE metadata(name TEXT,value TEXT)');
    db.run('CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row))');
    db.run('CREATE UNIQUE INDEX tidx ON tiles(zoom_level,tile_column,tile_row)');
    for(const[k,v]of[
      ['name','LIDAR Pente — Estran'],['type','baselayer'],['version','1'],
      ['description',`Pente LIDAR IGN — estran — seuils [${sMin.toFixed(1)}°, ${sMax.toFixed(1)}°]`],
      ['format','png'],['minzoom',String(zoom)],['maxzoom',String(zoom)],
    ]) db.run('INSERT INTO metadata VALUES(?,?)',[k,v]);

    const ins=db.prepare('INSERT OR REPLACE INTO tiles VALUES(?,?,?,?)');
    const total=ST.tileSlopes.size;
    let done=0,inserted=0,errs=0;

    for(const[k,slope] of ST.tileSlopes){
      if(ST.ac.signal.aborted) throw new Error('Annulé');
      const[z,x,y]=k.split('/').map(Number);
      const tmsY=(1<<z)-1-y;
      try{
        const tc=renderTilePNG(slope,sMin,sMax);
        const png=await canvasToPNG(tc);
        ins.run([z,x,tmsY,Array.from(png)]);
        inserted++;
      }catch(e){errs++;log(`✗ SQL ${k}: ${e.message}`,'err');}
      done++;
      await prog(`Export ${done}/${total}`,5+90*(done/total));
    }

    ins.free();
    if(inserted===0){db.close();throw new Error('Aucune tuile insérée.');}
    log(`SQLite : ${inserted}/${total} tuiles — export…`,'ok');
    await prog('Export SQLite…',97);
    const raw=db.export();const data=raw.slice();db.close();

    ST.mbt=data;
    const sz=data.byteLength>1048576
      ?`${(data.byteLength/1048576).toFixed(2)} Mo`
      :`${(data.byteLength/1024).toFixed(0)} Ko`;
    log(`MBTiles : ${sz}`,'ok');

    // Téléchargement
    const fname=`lidar_pente_z${zoom}_s${sMin.toFixed(0)}-${sMax.toFixed(0)}.mbtiles`;
    const blob=new Blob([data],{type:'application/x-sqlite3'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;a.download=fname;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),30000);

    await prog('✓ Terminé',100);setStatus('done');
    $('mbtSize').textContent=sz;$('mbtName').textContent=fname;
    dlEl.classList.add('visible');
    log(`⬇ ${fname} — ${sz}`,'ok');
    log("✓ Terminé. Cliquez sur le bouton si le téléchargement n'a pas démarré.",'ok');

  }catch(e){
    if(e.message==='Annulé'){log('Annulé.','warn');setStatus('idle');await prog('Annulé',0);}
    else{log('ERREUR : '+e.message,'err');setStatus('err');await prog('Erreur',0);}
  }finally{
    $('btnExport').disabled=false;
    $('btnAbort').disabled=true;
    ST.ac=null;
  }
});

$('btnDownload').addEventListener('click',()=>{
  if(!ST.mbt){log('Aucun MBTiles disponible.','warn');return;}
  const zoom=parseInt($('tileZoom').value)||14;
  const sMin=parseFloat($('sMin').value);
  const sMax=parseFloat($('sMax').value);
  const blob=new Blob([ST.mbt],{type:'application/x-sqlite3'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download=`lidar_pente_z${zoom}_s${sMin.toFixed(0)}-${sMax.toFixed(0)}.mbtiles`;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),30000);
});

$('btnAbort').addEventListener('click',()=>{if(ST.ac){ST.ac.abort();log('Annulation…','warn');}});

log('LIDAR_PENTE v3.0 prêt. Dessinez un rectangle sur la carte.','ok');
