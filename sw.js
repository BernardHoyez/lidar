/* LIDAR_PENTE sw v3.1.0 — brise-caches */
const CACHE='lidar-pente-v3.1.0';
const PRE=['./', './index.html','./app.js','./manifest.json','./icon192.png','./icon512.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(['data.geopf.fr','cdnjs.cloudflare.com'].some(h=>u.hostname.includes(h))){
    e.respondWith(fetch(e.request));return;
  }
  e.respondWith(
    fetch(e.request).then(r=>{
      if(r&&r.status===200) caches.open(CACHE).then(c=>c.put(e.request,r.clone()));
      return r;
    }).catch(()=>caches.match(e.request))
  );
});
self.addEventListener('message',e=>{if(e.data?.action==='skipWaiting') self.skipWaiting();});
