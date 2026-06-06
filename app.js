/* ═══════════════════════════════════════════════════════════════
   LIDAR_PENTE v3.2.0
   Détection d'irrégularités topographiques sur l'estran
   ───────────────────────────────────────────────────────────────
   Étape 1 : Rectangle → MNT RGE Alti → masque estran [BMVE, PMVE]
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
const IGN_ALTI  = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_WMTS  = 'https://data.geopf.fr/wmts';
const ALTI_RES  = 'ign_rge_alti_wld';
const MNT_LAYER = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MNT_FMT   = 'image/x-bil;bits=32';
const MNT_TMS   = 'WGS84G';
const TILE_PX   = 256;
const BATCH     = 40;
const DELAY_MS  = 230;
const CONCUR    = 3;
const MIN_AREA  = 1000;   // m² min pour garder un polygone
const SIMP_TOL  = 0.00004;

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
//  MNT RGE Alti → masque [BMVE, PMVE] → polygone → carte
// ═══════════════════════════════════════════════════════════════════

// ── MNT RGE Alti (API REST) ────────────────────────────────────────
async function getMNT(bbox,res){
  const latM=(bbox.minLat+bbox.maxLat)/2;
  const dLon=res/(111320*Math.cos(latM*Math.PI/180));
  const dLat=res/111320;
  const MAXD=80;
  const cols=Math.min(MAXD,Math.max(2,Math.round((bbox.maxLon-bbox.minLon)/dLon)+1));
  const rows=Math.min(MAXD,Math.max(2,Math.round((bbox.maxLat-bbox.minLat)/dLat)+1));
  const sLon=(bbox.maxLon-bbox.minLon)/(cols-1);
  const sLat=(bbox.maxLat-bbox.minLat)/(rows-1);
  const total=cols*rows;
  const nReq=Math.ceil(total/BATCH);
  log(`Grille MNT ${cols}×${rows} pts — ${nReq} requêtes alti`,'info');
  await prog(`Altimétrie 0/${total} pts`,5);
  const grid=new Float32Array(total).fill(NaN);
  let fetched=0;
  for(let i=0;i<total;i+=BATCH){
    if(ST.ac.signal.aborted) throw new Error('Annulé');
    const sz=Math.min(BATCH,total-i);
    const lons=[],lats=[];
    for(let j=0;j<sz;j++){
      const idx=i+j, c=idx%cols, r=Math.floor(idx/cols);
      lons.push(bbox.minLon+c*sLon);
      lats.push(bbox.maxLat-r*sLat);
    }
    const url=IGN_ALTI+'?'+new URLSearchParams({
      lon:lons.map(v=>v.toFixed(6)).join('|'),
      lat:lats.map(v=>v.toFixed(6)).join('|'),
      resource:ALTI_RES,delimiter:'|',indent:'false',measures:'false',zonly:'false'
    });
    try{
      const d=await (await apiFetch(url)).json();
      (d.elevations||[]).forEach((e,j)=>{
        const z=e.z;
        grid[i+j]=(z==null||z<=-1000)?NaN:Number(z);
      });
    }catch(e){
      if(e.message==='Annulé') throw e;
      log(`Req ${Math.ceil(i/BATCH)+1}/${nReq} échouée : ${e.message}`,'warn');
    }
    fetched+=sz;
    await prog(`Altimétrie ${fetched}/${total} pts`,5+25*(fetched/total));
    if(i+BATCH<total) await new Promise(r=>setTimeout(r,DELAY_MS));
  }
  let vmin=Infinity,vmax=-Infinity,nv=0;
  for(const v of grid) if(!isNaN(v)){if(v<vmin)vmin=v;if(v>vmax)vmax=v;nv++;}
  log(`MNT : ${nv}/${total} pts valides — alt. ${vmin.toFixed(2)} / ${vmax.toFixed(2)} m NGF`,'ok');
  return{grid,cols,rows};
}

// ── Masque estran ──────────────────────────────────────────────────
function makeMaskEstran(grid,cols,rows,bmve,pmve){
  const m=new Uint8Array(cols*rows);
  for(let i=0;i<grid.length;i++){
    const v=grid[i];
    if(!isNaN(v)&&v>=bmve&&v<=pmve) m[i]=1;
  }
  // NaN entourés de valeurs ≤ bmve → mer ouverte → inclure
  for(let r=0;r<rows;r++){
    for(let c=0;c<cols;c++){
      const i=r*cols+c;
      if(!isNaN(grid[i])) continue;
      const nb=[];
      if(c>0)      nb.push(grid[i-1]);
      if(c<cols-1) nb.push(grid[i+1]);
      if(r>0)      nb.push(grid[i-cols]);
      if(r<rows-1) nb.push(grid[i+cols]);
      const valid=nb.filter(x=>!isNaN(x));
      if(valid.length>0&&valid.every(x=>x<=bmve)) m[i]=1;
    }
  }
  return m;
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

// Convertit tuile XYZ PM → tuile WGS84G au même niveau
function pm2wgs84(x,y,z,L){
  const n=1<<z;
  const lon=(x+0.5)/n*360-180;
  const lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+0.5)/n)))*180/Math.PI;
  return ll2wgs84(lon,lat,L);
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
function hornSlope(elev,w,h,cellM){
  const NODATA=-9000; // BIL IGN : nodata ≈ -99999
  const slope=new Float32Array(w*h).fill(NaN);
  for(let r=1;r<h-1;r++){
    for(let c=1;c<w-1;c++){
      const i=r*w+c;
      if(elev[i]<NODATA) continue;
      const fix=v=>(v<NODATA?elev[i]:v);
      const a=fix(elev[(r-1)*w+(c-1)]),b=fix(elev[(r-1)*w+c]),cc=fix(elev[(r-1)*w+(c+1)]);
      const d=fix(elev[r*w+(c-1)]),                             f=fix(elev[r*w+(c+1)]);
      const g=fix(elev[(r+1)*w+(c-1)]),hh=fix(elev[(r+1)*w+c]),ii=fix(elev[(r+1)*w+(c+1)]);
      const dzdx=((cc+2*f+ii)-(a+2*d+g))/(8*cellM);
      const dzdy=((g+2*hh+ii)-(a+2*b+cc))/(8*cellM);
      slope[i]=Math.atan(Math.sqrt(dzdx*dzdx+dzdy*dzdy))*180/Math.PI;
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
  const res    = parseInt($('mntRes').value)||5;
  const zoom   = parseInt($('tileZoom').value)||14;
  log(`▶ BMVE=${bmve}m  PMVE=${pmve}m  résol=${res}m  zoom=${zoom}`,'info');

  try{
    // ── ÉTAPE 1 : MNT → masque estran → polygone ──────────────────
    await prog('Téléchargement altimétrie RGE Alti…',2);
    const{grid,cols,rows}=await getMNT(ST.bbox,res);

    await prog('Construction masque estran…',33);
    const mask=makeMaskEstran(grid,cols,rows,bmve,pmve);
    const nCells=mask.reduce((s,v)=>s+v,0);
    log(`Masque estran : ${nCells}/${cols*rows} cellules`,'info');
    if(!nCells) throw new Error(`Aucune cellule entre ${bmve} m et ${pmve} m NGF.`);

    await prog('Vectorisation…',36);
    const poly=maskToGeoJSON(mask,cols,rows,ST.bbox);
    if(!poly) throw new Error('Vectorisation échouée — élargissez la zone ou ajustez les seuils.');

    ST.mask=mask; ST.cols=cols; ST.rows=rows; ST.poly=poly;
    const ha=(turf.area(poly)/10000).toFixed(1);
    log(`Polygone estran : ${ha} ha`,'ok');
    estranLyr=L.geoJSON(poly,{
      style:{color:'#00c8a0',weight:2,fillColor:'#00c8a0',fillOpacity:0.22}
    }).addTo(map);

    // ── ÉTAPE 2 : tuiles LIDAR → pentes Horn ──────────────────────
    await prog('Sélection tuiles depuis masque…',40);
    const tilesXYZ=tilesFromMask(ST.mask,ST.cols,ST.rows,ST.bbox,zoom);
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
      const results=await Promise.allSettled(batch.map(async({z,x,y})=>{
        const{col,row}=pm2wgs84(x,y,z,z);
        const elev=await fetchBILcached(col,row,z);
        const cellM=tileResWGS84(row,z);
        const slope=hornSlope(elev,TILE_PX,TILE_PX,cellM);
        return{z,x,y,slope};
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

  // Trouver l'emprise de toutes les tuiles pour composer l'image
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity,z0=0;
  for(const k of ST.tileSlopes.keys()){
    const[z,x,y]=k.split('/').map(Number);
    z0=z;x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
  }
  const cols=x1-x0+1,rows=y1-y0+1;
  const W=cols*TILE_PX,H=rows*TILE_PX;

  const canvas=$('visuCanvas');
  canvas.width=W;canvas.height=H;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#111';ctx.fillRect(0,0,W,H);

  for(const[k,slope] of ST.tileSlopes){
    const[z,x,y]=k.split('/').map(Number);
    const tc=renderTilePNG(slope,sMin,sMax);
    ctx.drawImage(tc,(x-x0)*TILE_PX,(y-y0)*TILE_PX);
  }

  // Superposer le polygone estran
  if(ST.poly){
    const nPM=1<<z0;
    const lon2px=lon=>((lon+180)/360*nPM-x0)*TILE_PX;
    const lat2px=lat=>((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*nPM-y0)*TILE_PX;
    ctx.strokeStyle='#00c8a0';ctx.lineWidth=2;ctx.setLineDash([6,3]);
    const drawRing=coords=>{
      ctx.beginPath();
      coords.forEach(([ln,lt],i)=>{
        const px=lon2px(ln),py=lat2px(lt);
        i===0?ctx.moveTo(px,py):ctx.lineTo(px,py);
      });
      ctx.stroke();
    };
    const geo=ST.poly.geometry;
    if(geo.type==='Polygon') drawRing(geo.coordinates[0]);
    else geo.coordinates.forEach(p=>drawRing(p[0]));
    ctx.setLineDash([]);
  }

  $('visuSection').style.display='block';
}


// ═══════════════════════════════════════════════════════════════════
//  ÉTAPE 4 : EXPORT MBTILES
// ═══════════════════════════════════════════════════════════════════

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
