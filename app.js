/* ═══════════════════════════════════════════════════════════════
   LIDAR_ESTRAN v1.0.0
   Caractérisation du contour de l'estran depuis le MNT LIDAR IGN
   Source : WMTS BIL WGS84G — ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ─────────────────────────────────────────────────────
const IGN_WMTS    = 'https://data.geopf.fr/wmts';
const MNT_LAYER   = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MNT_FMT     = 'image/x-bil;bits=32';
const MNT_TMS     = 'WGS84G';
const WGS84G_L    = 11;     // niveau fixe pour le masque (~75 m/px, ~4-9 tuiles)
const BIL_NODATA  = -99999;
const TILE_PX     = 256;
const CONCUR      = 3;
const MIN_AREA    = 500;    // m² min pour garder un polygone
const SIMP_TOL    = 0.00003;

// ── STATE ──────────────────────────────────────────────────────────
const ST = {
  bbox    : null,
  ac      : null,
  grid    : null,   // Float32Array MNT assemblé
  cols    : 0,
  rows    : 0,
  gridBBox: null,
  t0      : Date.now()
};

// ── DOM ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function ts(){
  const s = Math.floor((Date.now()-ST.t0)/1000);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function log(msg, lv='info'){
  const d = document.createElement('div');
  d.className = 'log-line '+lv;
  d.innerHTML = `<span class="ts">${ts()}</span><span class="msg">${msg}</span>`;
  $('logArea').appendChild(d);
  $('logArea').scrollTop = $('logArea').scrollHeight;
}
function prog(label, pct){
  $('progressLabel').textContent = label;
  $('progressPct').textContent   = Math.round(pct)+'%';
  $('progressFill').style.width  = Math.min(100,pct)+'%';
  return new Promise(r => setTimeout(r, 4));
}
function setStatus(s){
  const CL = {idle:'chip-idle', run:'chip-running', done:'chip-done', err:'chip-error'};
  const LB = {idle:'Prêt', run:'En cours…', done:'Terminé ✓', err:'Erreur'};
  $('globalStatus').className = 'status-chip '+(CL[s]||'chip-idle');
  $('globalStatus').innerHTML = `<span class="dot"></span>${LB[s]||s}`;
}

// ── CARTE LEAFLET ──────────────────────────────────────────────────
const map = L.map('map', {center:[50.5, 1.6], zoom:11});
L.tileLayer(
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'+
  '&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&STYLE=normal&FORMAT=image/png'+
  '&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}',
  {attribution:'© IGN', maxZoom:19}
).addTo(map);

const drawn   = new L.FeatureGroup().addTo(map);
let contourLyr = null;   // contour rouge (provisoire)
let estranLyr  = null;   // remplissage vert (validé)

map.addControl(new L.Control.Draw({
  draw:{rectangle:{shapeOptions:{color:'#00c8a0',weight:2}},
        polygon:false, polyline:false, circle:false, circlemarker:false, marker:false},
  edit:{featureGroup:drawn, remove:true}
}));

map.on(L.Draw.Event.CREATED, e => {
  drawn.clearLayers();
  drawn.addLayer(e.layer);
  const b = e.layer.getBounds();
  ST.bbox = {minLon:b.getWest(), minLat:b.getSouth(), maxLon:b.getEast(), maxLat:b.getNorth()};
  clearLayers();
  ST.grid = null; // forcer re-téléchargement MNT
  updateCoords();
  log(`Zone : [${ST.bbox.minLon.toFixed(4)}, ${ST.bbox.minLat.toFixed(4)}] → [${ST.bbox.maxLon.toFixed(4)}, ${ST.bbox.maxLat.toFixed(4)}]`, 'ok');
  $('btnCalc').disabled = false;
  $('btnClear').disabled = false;
  $('btnValidate').disabled = true;
  $('step2').classList.remove('inactive');
  prog('Zone définie — cliquez Calculer', 0);
  setStatus('idle');
});
map.on(L.Draw.Event.DELETED, () => {
  ST.bbox = null; ST.grid = null;
  clearLayers(); updateCoords();
  $('btnCalc').disabled = true;
  $('btnClear').disabled = true;
  $('btnValidate').disabled = true;
  $('step2').classList.add('inactive');
});

const mapInfo = $('mapInfo');
map.on('mousemove', e => {
  mapInfo.style.display='block';
  mapInfo.textContent=`${e.latlng.lng.toFixed(5)}°E  ${e.latlng.lat.toFixed(5)}°N`;
});
map.on('mouseout', () => { mapInfo.style.display='none'; });

function clearLayers(){
  if(contourLyr){ map.removeLayer(contourLyr); contourLyr=null; }
  if(estranLyr) { map.removeLayer(estranLyr);  estranLyr=null;  }
}
function updateCoords(){
  const b = ST.bbox;
  $('cLonMin').textContent = b ? b.minLon.toFixed(4) : '—';
  $('cLonMax').textContent = b ? b.maxLon.toFixed(4) : '—';
  $('cLatMin').textContent = b ? b.minLat.toFixed(4) : '—';
  $('cLatMax').textContent = b ? b.maxLat.toFixed(4) : '—';
}

// ── WMTS BIL ───────────────────────────────────────────────────────
const wgs84Cols = L => 1 << (L+1);
const wgs84Rows = L => 1 << L;

function ll2wgs84(lon, lat, L){
  const nC = wgs84Cols(L), nR = wgs84Rows(L);
  return {
    col: Math.max(0, Math.min(nC-1, Math.floor((lon+180)/360*nC))),
    row: Math.max(0, Math.min(nR-1, Math.floor((90-lat)/180*nR)))
  };
}
function wgs84TileBBox(col, row, L){
  const nC = wgs84Cols(L), nR = wgs84Rows(L);
  return {
    minLon: col/nC*360-180,     maxLon: (col+1)/nC*360-180,
    maxLat: 90-row/nR*180,      minLat: 90-(row+1)/nR*180
  };
}
function tileResM(row, L){
  return 180 / wgs84Rows(L) / TILE_PX * 111320;
}

async function fetchBIL(col, row, L){
  const url = IGN_WMTS
    +'?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile'
    +`&LAYER=${MNT_LAYER}&STYLE=normal`
    +`&FORMAT=${encodeURIComponent(MNT_FMT)}`
    +`&TILEMATRIXSET=${MNT_TMS}`
    +`&TILEMATRIX=${L}&TILEROW=${row}&TILECOL=${col}`;
  const resp = await fetch(url, {signal: ST.ac.signal});
  if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ct = resp.headers.get('content-type')||'';
  if(ct.includes('xml')||ct.includes('html')){
    const t = await resp.text();
    throw new Error('WMTS: '+t.slice(0,80));
  }
  const buf = await resp.arrayBuffer();
  if(buf.byteLength < TILE_PX*TILE_PX*4)
    throw new Error(`BIL trop court (${buf.byteLength}b)`);
  return new Float32Array(buf, 0, TILE_PX*TILE_PX);
}

// ── TÉLÉCHARGEMENT MNT ─────────────────────────────────────────────
async function downloadMNT(bbox){
  const L = WGS84G_L;
  const {col:col0, row:row0} = ll2wgs84(bbox.minLon, bbox.maxLat, L);
  const {col:col1, row:row1} = ll2wgs84(bbox.maxLon, bbox.minLat, L);
  const tC = col1-col0+1, tR = row1-row0+1, nT = tC*tR;
  const gC = tC*TILE_PX,  gR = tR*TILE_PX;
  const tl = wgs84TileBBox(col0, row0, L);
  const br = wgs84TileBBox(col1, row1, L);
  const gridBBox = {minLon:tl.minLon, maxLon:br.maxLon, minLat:br.minLat, maxLat:tl.maxLat};
  const resM = tileResM(row0, L).toFixed(0);

  log(`MNT : ${tC}×${tR} tuiles WGS84G L=${L} → ${gC}×${gR} px (~${resM} m/px)`, 'info');
  await prog(`MNT 0/${nT} tuiles`, 5);

  const grid = new Float32Array(gC*gR).fill(NaN);
  const tiles = [];
  for(let tc=col0; tc<=col1; tc++)
    for(let tr=row0; tr<=row1; tr++)
      tiles.push({tc, tr});

  let done=0, errs=0;
  for(let i=0; i<tiles.length; i+=CONCUR){
    if(ST.ac.signal.aborted) throw new Error('Annulé');
    const batch = tiles.slice(i, i+CONCUR);
    const res = await Promise.allSettled(batch.map(({tc,tr}) => fetchBIL(tc,tr,L)));
    for(let j=0; j<batch.length; j++){
      const {tc, tr} = batch[j];
      if(res[j].status==='fulfilled'){
        const bil = res[j].value;
        const ox = (tc-col0)*TILE_PX, oy = (tr-row0)*TILE_PX;
        for(let py=0; py<TILE_PX; py++)
          for(let px=0; px<TILE_PX; px++){
            const v = bil[py*TILE_PX+px];
            grid[(oy+py)*gC+(ox+px)] = v < BIL_NODATA/2 ? NaN : v;
          }
      } else { errs++; log(`✗ L${L}/${tc}/${tr}: ${res[j].reason?.message}`, 'warn'); }
      done++;
    }
    await prog(`MNT ${done}/${nT} tuiles${errs?` (${errs} err)`:''}`, 5+30*(done/nT));
  }

  let mn=Infinity, mx=-Infinity, nv=0;
  for(const v of grid) if(!isNaN(v)){ if(v<mn)mn=v; if(v>mx)mx=v; nv++; }
  log(`MNT OK : alt. [${mn.toFixed(1)}, ${mx.toFixed(1)}] m NGF — ${nv}/${gC*gR} px valides`, 'ok');

  return {grid, cols:gC, rows:gR, bbox:gridBBox};
}

// ── MASQUE ESTRAN (flood-fill depuis la mer) ───────────────────────
function buildMask(grid, cols, rows, bmve, pmve){
  // Classifier : 1=mer (<bmve ou NaN), 2=estran [bmve,pmve], 0=terre
  const state = new Uint8Array(cols*rows);
  for(let i=0; i<grid.length; i++){
    const v = grid[i];
    if(isNaN(v)||v<bmve)  state[i] = 1;
    else if(v<=pmve)      state[i] = 2;
  }

  // BFS depuis les bords pour identifier la mer connexe à l'extérieur
  const sea = new Uint8Array(cols*rows);
  const q = [];
  const push = i => { if(!sea[i]&&state[i]===1){ sea[i]=1; q.push(i); } };
  for(let c=0; c<cols; c++){ push(c); push((rows-1)*cols+c); }
  for(let r=0; r<rows; r++){ push(r*cols); push(r*cols+cols-1); }
  let qi=0;
  while(qi<q.length){
    const i=q[qi++], r=Math.floor(i/cols), c=i%cols;
    if(c>0)      push(i-1);
    if(c<cols-1) push(i+1);
    if(r>0)      push(i-cols);
    if(r<rows-1) push(i+cols);
  }

  // BFS depuis l'estran adjacent à la mer connexe
  const mask = new Uint8Array(cols*rows);
  const q2 = [];
  for(let i=0; i<cols*rows; i++){
    if(state[i]!==2) continue;
    const r=Math.floor(i/cols), c=i%cols;
    const nbrs=[];
    if(c>0) nbrs.push(i-1); if(c<cols-1) nbrs.push(i+1);
    if(r>0) nbrs.push(i-cols); if(r<rows-1) nbrs.push(i+cols);
    if(nbrs.some(j=>sea[j])){ mask[i]=1; q2.push(i); }
  }
  let q2i=0;
  while(q2i<q2.length){
    const i=q2[q2i++], r=Math.floor(i/cols), c=i%cols;
    const nbrs=[];
    if(c>0) nbrs.push(i-1); if(c<cols-1) nbrs.push(i+1);
    if(r>0) nbrs.push(i-cols); if(r<rows-1) nbrs.push(i+cols);
    for(const j of nbrs) if(!mask[j]&&state[j]===2){ mask[j]=1; q2.push(j); }
  }
  return mask;
}

// ── VECTORISATION MARCHING SQUARES ────────────────────────────────
function maskToGeoJSON(mask, cols, rows, bbox){
  const cW=(bbox.maxLon-bbox.minLon)/cols;
  const cH=(bbox.maxLat-bbox.minLat)/rows;
  const p2w=([px,py])=>[bbox.minLon+px*cW, bbox.maxLat-py*cH];
  const segs=[];
  for(let r=0;r<rows-1;r++) for(let c=0;c<cols-1;c++){
    const tl=mask[r*cols+c], tr=mask[r*cols+c+1];
    const bl=mask[(r+1)*cols+c], br=mask[(r+1)*cols+c+1];
    const idx=(tl<<3)|(tr<<2)|(br<<1)|bl;
    if(idx===0||idx===15) continue;
    const T=[c+.5,r],B=[c+.5,r+1],L=[c,r+.5],R=[c+1,r+.5];
    const T_={1:[[L,B]],2:[[B,R]],3:[[L,R]],4:[[T,R]],
              5:[[T,R],[B,L]],6:[[T,B]],7:[[T,L]],8:[[T,L]],
              9:[[T,B]],10:[[T,L],[B,R]],11:[[T,R]],
              12:[[L,R]],13:[[B,R]],14:[[L,B]]};
    for(const s of (T_[idx]||[])) segs.push([p2w(s[0]),p2w(s[1])]);
  }
  if(!segs.length) return null;

  // Assembler les segments en anneaux
  const EPS=1e-9;
  const eq=([ax,ay],[bx,by])=>Math.abs(ax-bx)<EPS&&Math.abs(ay-by)<EPS;
  const used=new Uint8Array(segs.length);
  const rings=[];
  for(let s=0;s<segs.length;s++){
    if(used[s]) continue; used[s]=1;
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
  if(!rings.length) return null;

  const closed = rings.map(r=>{
    const rr=[...r];
    if(!eq(rr[0],rr[rr.length-1])) rr.push(rr[0]);
    return rr;
  }).filter(r=>r.length>=4);
  if(!closed.length) return null;

  const gj = closed.length===1
    ? turf.polygon([closed[0]])
    : turf.multiPolygon(closed.map(r=>[r]));

  // Simplifier et éliminer les petits polygones
  let simp;
  try{ simp=turf.simplify(gj,{tolerance:SIMP_TOL,highQuality:false}); }
  catch{ simp=gj; }

  const dropSmall = g => {
    const t=g.geometry.type;
    if(t==='Polygon') return turf.area(g)>=MIN_AREA ? g : null;
    if(t==='MultiPolygon'){
      const ok=g.geometry.coordinates.filter(c=>turf.area(turf.polygon(c))>=MIN_AREA);
      if(!ok.length) return null;
      return ok.length===1 ? turf.polygon(ok[0]) : turf.multiPolygon(ok);
    }
    return g;
  };
  return dropSmall(simp);
}

// ── CALCUL CONTOUR ─────────────────────────────────────────────────
async function computeContour(){
  if(!ST.bbox){ log('Dessinez d\'abord un rectangle.','warn'); return; }

  ST.t0 = Date.now();
  ST.ac = new AbortController();
  $('btnCalc').disabled    = true;
  $('btnAbort').disabled   = false;
  $('btnValidate').disabled= true;
  clearLayers();
  setStatus('run');

  const bmve = parseFloat($('bmveAlt').value) || -3;
  const pmve = parseFloat($('pmveAlt').value) || 5;
  log(`▶ Calcul estran BMVE=${bmve} m  PMVE=${pmve} m`, 'info');

  try{
    // 1. MNT (télécharger seulement si pas déjà en cache)
    if(!ST.grid){
      await prog('Téléchargement MNT BIL…', 2);
      const {grid, cols, rows, bbox} = await downloadMNT(ST.bbox);
      ST.grid=grid; ST.cols=cols; ST.rows=rows; ST.gridBBox=bbox;
    } else {
      log('MNT déjà en cache — recalcul direct', 'info');
    }

    // 2. Masque
    await prog('Masque estran…', 38);
    log('Calcul du masque estran…', 'info');
    const mask = buildMask(ST.grid, ST.cols, ST.rows, bmve, pmve);
    const nCells = mask.reduce((s,v)=>s+v, 0);
    log(`Masque : ${nCells}/${ST.cols*ST.rows} cellules dans [${bmve}, ${pmve}] m`, 'info');
    if(!nCells) throw new Error(`Aucune cellule entre ${bmve} m et ${pmve} m NGF.`);

    // 3. Vectorisation
    await prog('Vectorisation…', 55);
    log('Vectorisation Marching Squares…', 'info');
    const poly = maskToGeoJSON(mask, ST.cols, ST.rows, ST.gridBBox);
    if(!poly) throw new Error('Vectorisation échouée — ajustez les seuils ou élargissez la zone.');

    const ha = (turf.area(poly)/10000).toFixed(1);
    log(`Estran : ${ha} ha`, 'ok');

    // 4. Affichage contour ROUGE
    contourLyr = L.geoJSON(poly, {
      style:{color:'#ff3333', weight:2, fill:false}
    }).addTo(map);
    map.fitBounds(contourLyr.getBounds(), {padding:[30,30]});

    ST.poly = poly;
    await prog('✓ Contour affiché', 100);
    setStatus('done');
    $('btnValidate').disabled = false;
    log('✓ Contour rouge affiché. Ajustez BMVE/PMVE ou validez.', 'ok');

  } catch(e){
    if(e.name==='AbortError'||e.message==='Annulé'){
      log('Annulé.','warn'); setStatus('idle'); await prog('Annulé',0);
    } else {
      log('ERREUR : '+e.message,'err');
      console.error('[LIDAR]', e);
      setStatus('err'); await prog('Erreur',0);
    }
  } finally {
    $('btnCalc').disabled  = false;
    $('btnAbort').disabled = true;
    ST.ac = null;
  }
}

// ── VALIDATION : contour vert + transparence ───────────────────────
function validateEstran(){
  if(!ST.poly){ log('Calculez d\'abord le contour.','warn'); return; }
  if(contourLyr){ map.removeLayer(contourLyr); contourLyr=null; }
  estranLyr = L.geoJSON(ST.poly, {
    style:{color:'#00aa44', weight:2, fillColor:'#00cc55', fillOpacity:0.35}
  }).addTo(map);
  log('✓ Estran validé — affiché en vert.', 'ok');
  $('btnValidate').disabled = true;
  setStatus('done');
  prog('Estran validé', 100);
}

// ── ÉVÉNEMENTS BOUTONS ─────────────────────────────────────────────
$('btnCalc').addEventListener('click', computeContour);
$('btnValidate').addEventListener('click', validateEstran);
$('btnAbort').addEventListener('click', ()=>{
  if(ST.ac){ ST.ac.abort(); log('Annulation…','warn'); }
});
$('btnClear').addEventListener('click', ()=>{
  drawn.clearLayers();
  ST.bbox=ST.grid=ST.poly=null;
  clearLayers(); updateCoords();
  $('btnCalc').disabled=true;
  $('btnClear').disabled=true;
  $('btnValidate').disabled=true;
  $('step2').classList.add('inactive');
  prog('En attente',0); setStatus('idle');
  log('Zone effacée.','warn');
});

// Recalcul automatique si BMVE/PMVE changent et MNT déjà chargé
$('bmveAlt').addEventListener('change', ()=>{ if(ST.grid) computeContour(); });
$('pmveAlt').addEventListener('change', ()=>{ if(ST.grid) computeContour(); });

log('LIDAR_ESTRAN v1.0 — Dessinez un rectangle sur la carte.', 'ok');
