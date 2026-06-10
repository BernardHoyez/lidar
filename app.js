/* ═══════════════════════════════════════════════════════════════
   LIDAR_ESTRAN v2.2.0
   Ombrage LiDAR HD IGN masqué à l'estran
   ─────────────────────────────────────────────────────────────
   1. Rectangle utilisateur
   2. MNT BIL (WGS84G) → masque altitude ≤ seuil haut (PMVE)
   3. Téléchargement tuiles ombrage PNG (PM) → canvas
   4. Application du masque → affichage zones estran seulement
   5. Curseur de contraste
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── CONSTANTES ─────────────────────────────────────────────────────
const IGN_WMTS     = 'https://data.geopf.fr/wmts';
const MNT_LAYER    = 'ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES';
const MNT_FMT      = 'image/x-bil;bits=32';
const MNT_TMS      = 'WGS84G';
const WGS84G_L     = 14;      // ~5 m/px — résolution suffisante pour capter les faibles altitudes
const BIL_NODATA   = -99999;
const SHADOW_LAYER = 'IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW';
const SHADOW_FMT   = 'image/png';
const SHADOW_TMS   = 'PM';
const TILE_PX      = 256;
const CONCUR       = 4;
const MIN_AREA     = 500;
const SIMP_TOL     = 0.00003;

// ── STATE ──────────────────────────────────────────────────────────
const ST = {
  bbox     : null,
  ac       : null,
  grid     : null,   // Float32Array MNT
  gridCols : 0, gridRows : 0,
  gridBBox : null,
  t0       : Date.now()
};

// ── DOM ────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function ts(){
  const s=Math.floor((Date.now()-ST.t0)/1000);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function log(msg,lv='info'){
  const d=document.createElement('div');
  d.className='log-line '+lv;
  d.innerHTML=`<span class="ts">${ts()}</span><span class="msg">${msg}</span>`;
  $('logArea').appendChild(d);
  $('logArea').scrollTop=$('logArea').scrollHeight;
}
function prog(label,pct){
  $('progressLabel').textContent=label;
  $('progressPct').textContent=Math.round(pct)+'%';
  $('progressFill').style.width=Math.min(100,pct)+'%';
  return new Promise(r=>setTimeout(r,4));
}
function setStatus(s){
  const CL={idle:'chip-idle',run:'chip-running',done:'chip-done',err:'chip-error'};
  const LB={idle:'Prêt',run:'En cours…',done:'Terminé ✓',err:'Erreur'};
  $('globalStatus').className='status-chip '+(CL[s]||'chip-idle');
  $('globalStatus').innerHTML=`<span class="dot"></span>${LB[s]||s}`;
}

// ── CARTE ──────────────────────────────────────────────────────────
const map=L.map('map',{center:[50.5,1.6],zoom:12});
L.tileLayer(
  IGN_WMTS+'?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'+
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

// Overlay canvas pour l'ombrage masqué
let overlayLayer=null;
// Couche contour estran
let contourLyr=null;
let estranLyr=null;

map.on(L.Draw.Event.CREATED,e=>{
  drawn.clearLayers(); drawn.addLayer(e.layer);
  const b=e.layer.getBounds();
  ST.bbox={minLon:b.getWest(),minLat:b.getSouth(),maxLon:b.getEast(),maxLat:b.getNorth()};
  ST.grid=null;
  clearOverlay();
  updateCoords();
  log(`Zone : [${ST.bbox.minLon.toFixed(4)}, ${ST.bbox.minLat.toFixed(4)}] → [${ST.bbox.maxLon.toFixed(4)}, ${ST.bbox.maxLat.toFixed(4)}]`,'ok');
  $('btnCalc').disabled=false;
  $('btnClear').disabled=false;
  $('btnValidate').disabled=true;
  $('step2').classList.remove('inactive');
  $('step3').classList.add('inactive');
  prog('Zone définie — cliquez Calculer',0); setStatus('idle');
});
map.on(L.Draw.Event.DELETED,()=>{
  ST.bbox=ST.grid=null; clearOverlay(); updateCoords();
  $('btnCalc').disabled=true; $('btnClear').disabled=true;
  $('btnValidate').disabled=true;
  $('step2').classList.add('inactive'); $('step3').classList.add('inactive');
});

const mapInfo=$('mapInfo');
map.on('mousemove',e=>{mapInfo.style.display='block';mapInfo.textContent=`${e.latlng.lng.toFixed(5)}°E  ${e.latlng.lat.toFixed(5)}°N`;});
map.on('mouseout',()=>{mapInfo.style.display='none';});

function clearOverlay(){
  if(overlayLayer){map.removeLayer(overlayLayer);overlayLayer=null;}
  if(contourLyr){map.removeLayer(contourLyr);contourLyr=null;}
  if(estranLyr){map.removeLayer(estranLyr);estranLyr=null;}
  $('step3').classList.add('inactive');
}
function updateCoords(){
  const b=ST.bbox;
  $('cLonMin').textContent=b?b.minLon.toFixed(4):'—';
  $('cLonMax').textContent=b?b.maxLon.toFixed(4):'—';
  $('cLatMin').textContent=b?b.minLat.toFixed(4):'—';
  $('cLatMax').textContent=b?b.maxLat.toFixed(4):'—';
}

// ── WMTS BIL (MNT) ─────────────────────────────────────────────────
const wgs84Cols=L=>1<<(L+1);
const wgs84Rows=L=>1<<L;
function ll2wgs84(lon,lat,L){
  const nC=wgs84Cols(L),nR=wgs84Rows(L);
  return{col:Math.max(0,Math.min(nC-1,Math.floor((lon+180)/360*nC))),
         row:Math.max(0,Math.min(nR-1,Math.floor((90-lat)/180*nR)))};
}
function wgs84TileBBox(col,row,L){
  const nC=wgs84Cols(L),nR=wgs84Rows(L);
  return{minLon:col/nC*360-180,maxLon:(col+1)/nC*360-180,
         maxLat:90-row/nR*180,minLat:90-(row+1)/nR*180};
}
function tileResM(row,L){return 180/wgs84Rows(L)/TILE_PX*111320;}

async function fetchBIL(col,row,L){
  const url=IGN_WMTS+'?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile'
    +`&LAYER=${MNT_LAYER}&STYLE=normal`
    +`&FORMAT=${encodeURIComponent(MNT_FMT)}`
    +`&TILEMATRIXSET=${MNT_TMS}`
    +`&TILEMATRIX=${L}&TILEROW=${row}&TILECOL=${col}`;
  const resp=await fetch(url,{signal:ST.ac.signal});
  if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf=await resp.arrayBuffer();
  if(buf.byteLength<TILE_PX*TILE_PX*4) throw new Error(`BIL trop court (${buf.byteLength}b)`);
  return new Float32Array(buf,0,TILE_PX*TILE_PX);
}

async function downloadMNT(bbox, L){
  L = L || WGS84G_L;
  const {col:col0,row:row0}=ll2wgs84(bbox.minLon,bbox.maxLat,L);
  const {col:col1,row:row1}=ll2wgs84(bbox.maxLon,bbox.minLat,L);
  const tC=col1-col0+1,tR=row1-row0+1,nT=tC*tR;
  const gC=tC*TILE_PX,gR=tR*TILE_PX;
  const tl=wgs84TileBBox(col0,row0,L),br=wgs84TileBBox(col1,row1,L);
  const gBBox={minLon:tl.minLon,maxLon:br.maxLon,minLat:br.minLat,maxLat:tl.maxLat};
  const resM=tileResM(row0,L).toFixed(0);
  log(`MNT : ${tC}×${tR} tuiles L=${L} → ${gC}×${gR} px (~${resM} m/px)`,'info');
  await prog(`MNT 0/${nT} tuiles`,5);
  const grid=new Float32Array(gC*gR).fill(NaN);
  const tiles=[];
  for(let tc=col0;tc<=col1;tc++) for(let tr=row0;tr<=row1;tr++) tiles.push({tc,tr});
  let done=0,errs=0;
  for(let i=0;i<tiles.length;i+=CONCUR){
    if(ST.ac.signal.aborted) throw new Error('Annulé');
    const batch=tiles.slice(i,i+CONCUR);
    const res=await Promise.allSettled(batch.map(({tc,tr})=>fetchBIL(tc,tr,L)));
    for(let j=0;j<batch.length;j++){
      const{tc,tr}=batch[j];
      if(res[j].status==='fulfilled'){
        const bil=res[j].value;
        const ox=(tc-col0)*TILE_PX,oy=(tr-row0)*TILE_PX;
        for(let py=0;py<TILE_PX;py++) for(let px=0;px<TILE_PX;px++){
          const v=bil[py*TILE_PX+px];
          grid[(oy+py)*gC+(ox+px)] = (v < -1000 || v > 9000) ? NaN : v;
        }
      } else {errs++;log(`✗ MNT ${batch[j].tc}/${batch[j].tr}: ${res[j].reason?.message}`,'warn');}
      done++;
    }
    await prog(`MNT ${done}/${nT}${errs?` (${errs} err)`:''}`,5+25*(done/nT));
  }
  // Pixels hors bbox exacte → marqués comme "mer profonde" (valeur très négative)
  // pour que le flood-fill BFS puisse partir des bords et entrer dans la bbox
  const dLon=gBBox.maxLon-gBBox.minLon,dLat=gBBox.maxLat-gBBox.minLat;
  for(let py=0;py<gR;py++) for(let px=0;px<gC;px++){
    const lon=gBBox.minLon+(px+0.5)/gC*dLon;
    const lat=gBBox.maxLat-(py+0.5)/gR*dLat;
    if(lon<bbox.minLon||lon>bbox.maxLon||lat<bbox.minLat||lat>bbox.maxLat)
      grid[py*gC+px]=-500; // mer artificielle — hors zone sélectionnée
  }
  let mn=Infinity,mx=-Infinity,nv=0;
  const vals=[];
  for(const v of grid) if(!isNaN(v)&&v>-499){if(v<mn)mn=v;if(v>mx)mx=v;nv++;vals.push(v);}
  vals.sort((a,b)=>a-b);
  const p10=vals[Math.floor(vals.length*0.10)]?.toFixed(1)??'—';
  const p50=vals[Math.floor(vals.length*0.50)]?.toFixed(1)??'—';
  const p90=vals[Math.floor(vals.length*0.90)]?.toFixed(1)??'—';
  log(`MNT OK : min=${mn.toFixed(1)} p10=${p10} p50=${p50} p90=${p90} max=${mx.toFixed(1)} m NGF — ${nv} px valides dans la zone`,'ok');
  return{grid,cols:gC,rows:gR,bbox:gBBox};
}

// ── MASQUE ESTRAN (flood-fill depuis la mer) ───────────────────────
function buildMask(grid, cols, rows, bmve, pmve){
  // Stratégie : tout pixel ≤ PMVE connexe à l'extérieur de la grille = estran.
  // La BMVE sert uniquement à l'affichage (transparence) dans buildOverlay,
  // pas comme seuil de masque — car les valeurs subtidale < BMVE sont rares
  // dans le MNT et bloqueraient la connexité.
  // Les pixels hors-bbox (-500) garantissent la connexion depuis les bords.

  const state = new Uint8Array(cols*rows);
  for(let i=0; i<grid.length; i++){
    const v = grid[i];
    state[i] = (!isNaN(v) && v <= pmve) ? 2 : 1; // 2=candidat estran, 1=bloquant
  }

  // BFS depuis les bords
  const mask = new Uint8Array(cols*rows);
  const q = [];
  const push = i => { if(!mask[i] && state[i]===2){ mask[i]=1; q.push(i); } };
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
  return mask;
}

// ── WMTS OMBRAGE (PNG en PM) ────────────────────────────────────────
// Les tuiles ombrage sont en PM (XYZ standard Leaflet)
function lon2x(lon,z){return Math.floor((lon+180)/360*(1<<z));}
function lat2y(lat,z){return Math.floor((1-Math.log(Math.tan(lat*Math.PI/180)+1/Math.cos(lat*Math.PI/180))/Math.PI)/2*(1<<z));}
function pmTileBBox(x,y,z){
  const n=1<<z;
  const minLon=x/n*360-180,maxLon=(x+1)/n*360-180;
  const maxLat=Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180/Math.PI;
  const minLat=Math.atan(Math.sinh(Math.PI*(1-2*(y+1)/n)))*180/Math.PI;
  return{minLon,maxLon,minLat,maxLat};
}

async function fetchShadowTile(x,y,z){
  const url=IGN_WMTS+'?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile'
    +`&LAYER=${SHADOW_LAYER}&STYLE=normal&FORMAT=${encodeURIComponent(SHADOW_FMT)}`
    +`&TILEMATRIXSET=${SHADOW_TMS}&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`;
  const resp=await fetch(url,{signal:ST.ac.signal});
  if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob=await resp.blob();
  return createImageBitmap(blob);
}

// ── ASSEMBLAGE OMBRAGE + MASQUE → ImageOverlay ─────────────────────
async function buildOverlay(bbox, mask, maskCols, maskRows, maskBBox, zoom, contrast, bmve, pmve){
  // Tuiles PM couvrant la bbox
  const x0=lon2x(bbox.minLon,zoom),x1=lon2x(bbox.maxLon,zoom);
  const y0=lat2y(bbox.maxLat,zoom),y1=lat2y(bbox.minLat,zoom);
  const tC=x1-x0+1,tR=y1-y0+1,nT=tC*tR;

  // BBox réelle de l'assemblage (tuiles entières)
  const tl=pmTileBBox(x0,y0,zoom),br=pmTileBBox(x1,y1,zoom);
  const sBBox={minLon:tl.minLon,maxLon:br.maxLon,minLat:br.minLat,maxLat:tl.maxLat};

  const W=tC*TILE_PX,H=tR*TILE_PX;
  const canvas=document.createElement('canvas');
  canvas.width=W; canvas.height=H;
  const ctx=canvas.getContext('2d');

  log(`Ombrage : ${tC}×${tR} tuiles PM zoom ${zoom}…`,'info');
  await prog(`Ombrage 0/${nT} tuiles`,33);

  const tiles=[];
  for(let tx=x0;tx<=x1;tx++) for(let ty=y0;ty<=y1;ty++) tiles.push({tx,ty});
  let done=0,errs=0;
  for(let i=0;i<tiles.length;i+=CONCUR){
    if(ST.ac.signal.aborted) throw new Error('Annulé');
    const batch=tiles.slice(i,i+CONCUR);
    const res=await Promise.allSettled(batch.map(({tx,ty})=>fetchShadowTile(tx,ty,zoom)));
    for(let j=0;j<batch.length;j++){
      if(res[j].status==='fulfilled'){
        const{tx,ty}=batch[j];
        ctx.drawImage(res[j].value,(tx-x0)*TILE_PX,(ty-y0)*TILE_PX);
      } else {errs++;log(`✗ Shadow ${batch[j].tx}/${batch[j].ty}: ${res[j].reason?.message}`,'warn');}
      done++;
    }
    await prog(`Ombrage ${done}/${nT}${errs?` (${errs} err)`:''}`,33+30*(done/nT));
  }
  log(`Ombrage assemblé — ${errs} erreur(s)`,'ok');

  // Appliquer contraste
  if(contrast!==1.0){
    const id=ctx.getImageData(0,0,W,H);
    const d=id.data;
    for(let i=0;i<d.length;i+=4){
      d[i]  =Math.min(255,((d[i]  -128)*contrast+128));
      d[i+1]=Math.min(255,((d[i+1]-128)*contrast+128));
      d[i+2]=Math.min(255,((d[i+2]-128)*contrast+128));
    }
    ctx.putImageData(id,0,0);
  }

  // Appliquer le masque estran : rendre transparent hors masque
  await prog('Application du masque estran…',65);
  const id=ctx.getImageData(0,0,W,H);
  const px=id.data;

  // Pour chaque pixel du canvas ombrage, calculer sa lon/lat
  // puis tester dans le masque MNT (bilinéaire simplifié = plus proche voisin)
  const sLon=sBBox.maxLon-sBBox.minLon;
  const sLat=sBBox.maxLat-sBBox.minLat;
  const mLon=maskBBox.maxLon-maskBBox.minLon;
  const mLat=maskBBox.maxLat-maskBBox.minLat;

  for(let py=0;py<H;py++){
    for(let px2=0;px2<W;px2++){
      const lon=sBBox.minLon+(px2+0.5)/W*sLon;
      const lat=sBBox.maxLat-(py+0.5)/H*sLat;
      // Hors bbox utilisateur → transparent
      if(lon<bbox.minLon||lon>bbox.maxLon||lat<bbox.minLat||lat>bbox.maxLat){
        px[(py*W+px2)*4+3]=0; continue;
      }
      // Coordonnées dans la grille masque
      const mc=Math.floor((lon-maskBBox.minLon)/mLon*maskCols);
      const mr=Math.floor((maskBBox.maxLat-lat)/mLat*maskRows);
      if(mc<0||mc>=maskCols||mr<0||mr>=maskRows||!mask[mr*maskCols+mc]){
        px[(py*W+px2)*4+3]=0; // hors estran → transparent
      }
    }
  }
  ctx.putImageData(id,0,0);

  return{canvas,bbox:sBBox};
}

// ── VECTEUR CONTOUR ────────────────────────────────────────────────
function maskToGeoJSON(mask,cols,rows,bbox){
  const cW=(bbox.maxLon-bbox.minLon)/cols;
  const cH=(bbox.maxLat-bbox.minLat)/rows;
  const p2w=([px,py])=>[bbox.minLon+px*cW,bbox.maxLat-py*cH];
  const segs=[];
  for(let r=0;r<rows-1;r++) for(let c=0;c<cols-1;c++){
    const tl=mask[r*cols+c],tr=mask[r*cols+c+1];
    const bl=mask[(r+1)*cols+c],br=mask[(r+1)*cols+c+1];
    const idx=(tl<<3)|(tr<<2)|(br<<1)|bl;
    if(!idx||idx===15) continue;
    const T=[c+.5,r],B=[c+.5,r+1],Lo=[c,r+.5],R=[c+1,r+.5];
    const T_={1:[[Lo,B]],2:[[B,R]],3:[[Lo,R]],4:[[T,R]],5:[[T,R],[B,Lo]],
              6:[[T,B]],7:[[T,Lo]],8:[[T,Lo]],9:[[T,B]],10:[[T,Lo],[B,R]],
              11:[[T,R]],12:[[Lo,R]],13:[[B,R]],14:[[Lo,B]]};
    for(const s of(T_[idx]||[])) segs.push([p2w(s[0]),p2w(s[1])]);
  }
  if(!segs.length) return null;
  const EPS=1e-9;
  const eq=([ax,ay],[bx,by])=>Math.abs(ax-bx)<EPS&&Math.abs(ay-by)<EPS;
  const used=new Uint8Array(segs.length);
  const rings=[];
  for(let s=0;s<segs.length;s++){
    if(used[s]) continue; used[s]=1;
    const ring=[segs[s][0],segs[s][1]];
    let go=true;
    while(go){go=false;const tail=ring[ring.length-1];
      for(let j=0;j<segs.length;j++){if(used[j]) continue;
        if(eq(segs[j][0],tail)){ring.push(segs[j][1]);used[j]=1;go=true;break;}
        if(eq(segs[j][1],tail)){ring.push(segs[j][0]);used[j]=1;go=true;break;}
      }
    }
    if(ring.length>=4) rings.push(ring);
  }
  if(!rings.length) return null;
  const closed=rings.map(r=>{const rr=[...r];if(!eq(rr[0],rr[rr.length-1]))rr.push(rr[0]);return rr;}).filter(r=>r.length>=4);
  if(!closed.length) return null;
  const gj=closed.length===1?turf.polygon([closed[0]]):turf.multiPolygon(closed.map(r=>[r]));
  let simp;try{simp=turf.simplify(gj,{tolerance:SIMP_TOL,highQuality:false});}catch{simp=gj;}
  const drop=g=>{const t=g.geometry.type;
    if(t==='Polygon') return turf.area(g)>=MIN_AREA?g:null;
    if(t==='MultiPolygon'){const ok=g.geometry.coordinates.filter(c=>turf.area(turf.polygon(c))>=MIN_AREA);if(!ok.length) return null;return ok.length===1?turf.polygon(ok[0]):turf.multiPolygon(ok);}
    return g;};
  return drop(simp);
}

// ── PIPELINE PRINCIPAL ─────────────────────────────────────────────
async function compute(){
  if(!ST.bbox){log('Dessinez d\'abord un rectangle.','warn');return;}
  ST.t0=Date.now();
  ST.ac=new AbortController();
  $('btnCalc').disabled=true;
  $('btnAbort').disabled=false;
  $('btnValidate').disabled=true;
  clearOverlay();
  setStatus('run');

  const bmve     = $('bmveAlt').value!=='' ? parseFloat($('bmveAlt').value) : -3;
  const pmve     = $('pmveAlt').value!=='' ? parseFloat($('pmveAlt').value) : 4.5;
  const zoom     = parseInt($('shadowZoom').value)||16;
  const contrast = parseFloat($('contrast').value)||1.0;
  if(isNaN(bmve)||isNaN(pmve)){log('Valeurs invalides.','warn');return;}
  if(bmve>=pmve){log(`BMVE (${bmve}) doit être < PMVE (${pmve}).`,'warn');return;}
  log(`▶ BMVE=${bmve} m  PMVE=${pmve} m  zoom=${zoom}  contraste=×${contrast.toFixed(1)}`,'info');

  try{
    // 1. MNT — même zoom que l'ombrage, clamped à [6,14]
    const mntLevel = Math.max(6, Math.min(14, zoom));
    if(!ST.grid || ST.lastMntLevel !== mntLevel){
      await prog('Téléchargement MNT BIL…',2);
      const{grid,cols,rows,bbox:gb}=await downloadMNT(ST.bbox, mntLevel);
      ST.grid=grid; ST.gridCols=cols; ST.gridRows=rows; ST.gridBBox=gb;
      ST.lastMntLevel = mntLevel;
    } else {
      log('MNT en cache — recalcul masque direct','info');
    }

    // 2. Masque
    await prog('Masque estran…',31);
    log('Calcul du masque…','info');
    const mask=buildMask(ST.grid,ST.gridCols,ST.gridRows,bmve,pmve);
    const nCells=mask.reduce((s,v)=>s+v,0);
    log(`Masque : ${nCells} cellules dans [${bmve}, ${pmve}] m`,'info');
    if(!nCells){
      let mn=Infinity,mx=-Infinity;
      for(const v of ST.grid) if(!isNaN(v)&&v>-499){if(v<mn)mn=v;if(v>mx)mx=v;}
      throw new Error(`Aucun pixel dans [${bmve}, ${pmve}] m NGF. Zone disponible : [${mn.toFixed(1)}, ${mx.toFixed(1)}] m.`);
    }

    // 3. Contour vecteur
    await prog('Contour estran…',32);
    const poly=maskToGeoJSON(mask,ST.gridCols,ST.gridRows,ST.gridBBox);
    if(poly){
      const ha=(turf.area(poly)/10000).toFixed(1);
      log(`Contour estran : ${ha} ha`,'ok');
      contourLyr=L.geoJSON(poly,{style:{color:'#ff3333',weight:2,fill:false}}).addTo(map);
    }

    // 4. Tuiles ombrage + masque → canvas
    await prog('Ombrage LiDAR HD…',33);
    const{canvas,bbox:sBBox}=await buildOverlay(ST.bbox,mask,ST.gridCols,ST.gridRows,ST.gridBBox,zoom,contrast,bmve,pmve);

    // 5. Affichage ImageOverlay Leaflet
    await prog('Affichage…',97);
    const dataURL=canvas.toDataURL('image/png');
    const bounds=[[sBBox.minLat,sBBox.minLon],[sBBox.maxLat,sBBox.maxLon]];
    overlayLayer=L.imageOverlay(dataURL,bounds,{opacity:1}).addTo(map);
    map.fitBounds(bounds,{padding:[20,20]});

    ST.poly=poly;
    await prog('✓ Terminé',100);
    setStatus('done');
    $('btnValidate').disabled=!poly;
    $('step3').classList.remove('inactive');
    log('✓ Ombrage estran affiché. Ajustez PMVE ou contraste si besoin.','ok');

  }catch(e){
    if(e.name==='AbortError'||e.message==='Annulé'){
      log('Annulé.','warn');setStatus('idle');await prog('Annulé',0);
    }else{
      log('ERREUR : '+e.message,'err');console.error('[LIDAR]',e);
      setStatus('err');await prog('Erreur',0);
    }
  }finally{
    $('btnCalc').disabled=false;
    $('btnAbort').disabled=true;
    ST.ac=null;
  }
}

// Validation : contour vert fixe
function validateEstran(){
  if(!ST.poly) return;
  if(contourLyr){map.removeLayer(contourLyr);contourLyr=null;}
  estranLyr=L.geoJSON(ST.poly,{style:{color:'#00aa44',weight:2,fillColor:'#00cc55',fillOpacity:0.25}}).addTo(map);
  $('btnValidate').disabled=true;
  log('✓ Contour estran validé (vert).','ok');
  prog('Estran validé',100);setStatus('done');
}

// ── DÉCLENCHEURS ───────────────────────────────────────────────────
$('btnCalc').addEventListener('click',compute);
$('btnValidate').addEventListener('click',validateEstran);
$('btnAbort').addEventListener('click',()=>{if(ST.ac){ST.ac.abort();log('Annulation…','warn');}});
$('btnClear').addEventListener('click',()=>{
  drawn.clearLayers();ST.bbox=ST.grid=ST.poly=null;
  clearOverlay();updateCoords();
  $('btnCalc').disabled=true;$('btnClear').disabled=true;$('btnValidate').disabled=true;
  $('step2').classList.add('inactive');$('step3').classList.add('inactive');
  prog('En attente',0);setStatus('idle');log('Zone effacée.','warn');
});

// Recalcul auto sur PMVE (debounce 700ms) — sans re-télécharger le MNT
let recalcT=null;
function scheduleRecalc(){
  if(!ST.grid) return;
  clearTimeout(recalcT);
  recalcT=setTimeout(compute,700);
}
$('pmveAlt').addEventListener('input',scheduleRecalc);
$('bmveAlt').addEventListener('input',scheduleRecalc);

// Recalcul contraste immédiat (slider)
$('contrast').addEventListener('input',()=>{
  $('contrastVal').textContent='×'+parseFloat($('contrast').value).toFixed(1);
  if(ST.grid) scheduleRecalc();
});

log('LIDAR_ESTRAN v2.2 — Dessinez un rectangle sur la carte.','ok');
