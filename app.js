const DB_NAME = "watchHuntDB";
const DB_VERSION = 1;
const STORE = "kv";

const DEFAULT_STATE = {
  queue: [],
  history: [],
  favorites: [],
  wishlist: [],
  bannedModels: [],
  settings: {
    budgetTarget: 100,
    budgetMax: 120,
    resultCount: 20,
    exploitationRatio: 60,
    explorationRatio: 40
  }
};

let state = structuredClone(DEFAULT_STATE);
let db;
let drag = null;

function uid(prefix="id"){
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
}
function nowISO(){ return new Date().toISOString(); }
function money(v){
  if(v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `${Math.round(n)} €` : String(v);
}
function escapeHtml(s=""){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function normalizeUrl(u=""){ try { return new URL(u).href; } catch { return String(u).trim(); } }
function modelKey(w){ return [w.brand,w.model,w.reference].filter(Boolean).join(" ").trim().toLowerCase(); }

async function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{
      const d=req.result;
      if(!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function saveState(){
  localStorage.setItem("watchHuntFallback", JSON.stringify(state));
  if(!db) return;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,"readwrite");
    tx.objectStore(STORE).put(state,"state");
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
async function loadState(){
  try{
    db=await openDB();
    const loaded=await new Promise((resolve)=>{
      const tx=db.transaction(STORE,"readonly");
      const req=tx.objectStore(STORE).get("state");
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>resolve(null);
    });
    if(loaded) state=mergeDefaults(loaded);
    else {
      const fb=localStorage.getItem("watchHuntFallback");
      if(fb) state=mergeDefaults(JSON.parse(fb));
    }
  }catch(e){
    const fb=localStorage.getItem("watchHuntFallback");
    if(fb) state=mergeDefaults(JSON.parse(fb));
  }
}
function mergeDefaults(s){
  return {
    ...structuredClone(DEFAULT_STATE),
    ...s,
    settings:{...DEFAULT_STATE.settings,...(s.settings||{})},
    queue:Array.isArray(s.queue)?s.queue:[],
    history:Array.isArray(s.history)?s.history:[],
    favorites:Array.isArray(s.favorites)?s.favorites:[],
    wishlist:Array.isArray(s.wishlist)?s.wishlist:[],
    bannedModels:Array.isArray(s.bannedModels)?s.bannedModels:[]
  };
}

function currentWatch(){ return state.queue[0] || null; }
function isFavorite(id){ return state.favorites.includes(id); }
function isWishlist(id){ return state.wishlist.includes(id); }
function findWatch(id){
  return [...state.queue,...state.history].find(w=>w.id===id);
}

function sanitizeWatch(raw){
  const w={
    id: raw.id || raw.listing_id || uid("watch"),
    brand: raw.brand || "",
    model: raw.model || raw.name || "Montre sans nom",
    reference: raw.reference || "",
    year: raw.year || raw.period || "",
    movement: raw.movement || "",
    diameter: raw.diameter || "",
    style: raw.style || "",
    price: raw.price ?? "",
    currency: raw.currency || "EUR",
    platform: raw.platform || raw.source || "",
    url: normalizeUrl(raw.url || raw.link || ""),
    image: raw.image || raw.image_url || raw.photo || "",
    images: Array.isArray(raw.images) ? raw.images : [],
    estimated_market_value: raw.estimated_market_value || raw.market_value || "",
    interest_reason: raw.interest_reason || raw.reason || "",
    risk: raw.risk || "",
    condition: raw.condition || "",
    seller_notes: raw.seller_notes || "",
    discovery_type: raw.discovery_type || raw.segment || "",
    importedAt: nowISO(),
    status: "queued"
  };
  if(!w.image && w.images.length) w.image=w.images[0];
  return w;
}

function isDuplicate(w){
  const all=[...state.queue,...state.history];
  return all.some(x => {
    if(w.url && x.url && normalizeUrl(w.url)===normalizeUrl(x.url)) return true;
    if(w.id && x.id && w.id===x.id) return true;
    return false;
  });
}

async function importFeed(text){
  let cleaned=text.trim();
  cleaned=cleaned.replace(/^```(?:json|text)?/i,"").replace(/```$/,"").trim();
  const marker="WATCH_FEED_V1";
  if(cleaned.startsWith(marker)) cleaned=cleaned.slice(marker.length).trim();

  let payload;
  try{ payload=JSON.parse(cleaned); }
  catch(e){
    const start=Math.min(...["[","{"].map(ch=>{const i=cleaned.indexOf(ch); return i<0?Infinity:i;}));
    if(!Number.isFinite(start)) throw new Error("JSON introuvable");
    payload=JSON.parse(cleaned.slice(start));
  }

  const arr=Array.isArray(payload) ? payload : (payload.watches || payload.results || payload.items || []);
  if(!Array.isArray(arr)) throw new Error("Format non reconnu");

  let added=0, duplicates=0, banned=0;
  for(const raw of arr){
    const w=sanitizeWatch(raw);
    if(state.bannedModels.includes(modelKey(w))){ banned++; continue; }
    if(isDuplicate(w)){ duplicates++; continue; }
    state.queue.push(w); added++;
  }
  await saveState();
  render();
  return {added,duplicates,banned};
}

async function swipe(action){
  const w=currentWatch();
  if(!w) return;

  state.queue.shift();
  w.status=action;
  w.swipedAt=nowISO();

  if(action==="liked"){
    w.preferenceSignal=1;
  }else if(action==="rejected"){
    w.preferenceSignal=-1;
  }else if(action==="wishlist"){
    w.preferenceSignal=2;
    if(!state.wishlist.includes(w.id)) state.wishlist.push(w.id);
  }
  state.history.unshift(w);
  await saveState();
  render();
}

async function toggleFavorite(id=currentWatch()?.id){
  if(!id) return;
  if(isFavorite(id)) state.favorites=state.favorites.filter(x=>x!==id);
  else state.favorites.unshift(id);
  await saveState();
  render();
}
async function toggleWishlist(id){
  if(!id) return;
  if(isWishlist(id)) state.wishlist=state.wishlist.filter(x=>x!==id);
  else state.wishlist.unshift(id);
  await saveState();
  render();
}
async function banModel(id){
  const w=findWatch(id);
  if(!w) return;
  const key=modelKey(w);
  if(key && !state.bannedModels.includes(key)) state.bannedModels.push(key);
  state.queue=state.queue.filter(x=>modelKey(x)!==key);
  await saveState();
  closeModal();
  render();
}

function aggregatePrefs(){
  const scores={brands:{},styles:{},movements:{},periods:{}};
  for(const w of state.history){
    const weight=w.preferenceSignal||0;
    if(!weight) continue;
    const pairs=[
      ["brands",w.brand],
      ["styles",w.style],
      ["movements",w.movement],
      ["periods",w.year]
    ];
    for(const [bucket,val] of pairs){
      const k=String(val||"").trim();
      if(!k) continue;
      scores[bucket][k]=(scores[bucket][k]||0)+weight;
    }
  }
  const sortBucket=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,12);
  return {
    brands:sortBucket(scores.brands),
    styles:sortBucket(scores.styles),
    movements:sortBucket(scores.movements),
    periods:sortBucket(scores.periods)
  };
}
function compactSeen(){
  return state.history.slice(0,250).map(w=>({
    id:w.id, brand:w.brand, model:w.model, reference:w.reference,
    url:w.url, status:w.status, favorite:isFavorite(w.id), wishlist:isWishlist(w.id)
  }));
}
function generatePrompt(){
  const prefs=aggregatePrefs();
  const favs=state.favorites.map(findWatch).filter(Boolean).slice(0,40);
  const wish=state.wishlist.map(findWatch).filter(Boolean).slice(0,40);

  return `Tu es mon conseiller horloger et mon moteur de chasse d'annonces.

OBJECTIF
Trouve ${state.settings.resultCount} nouvelles montres vintage intéressantes, originales, sous-cotées ou oubliées, avec des annonces actuellement disponibles. Budget cible : environ ${state.settings.budgetTarget} €, exceptionnellement jusqu'à ${state.settings.budgetMax} € uniquement si la pièce est particulièrement intéressante.

SOURCES À CHERCHER
Leboncoin, Vinted, eBay et autres places de marché pertinentes accessibles publiquement.

RÈGLE DE RECOMMANDATION
- ${state.settings.exploitationRatio}% des résultats : exploitation de mes goûts déjà appris.
- ${state.settings.explorationRatio}% : exploration volontaire de nouvelles marques, périodes, designs, mouvements ou familles encore peu testés.
- Ne te limite pas aux marques connues.
- Priorité aux annonces mal valorisées, aux références peu connues, aux cadrans/boîtiers originaux et aux mouvements intéressants.
- Évite les montres manifestement franken, cadrans repeints ou annonces douteuses sauf si tu le signales clairement.
- Ne repropose aucune annonce déjà vue.
- N'utilise pas uniquement le prix affiché : compare avec l'intérêt horloger, l'originalité, l'état et la valeur habituelle.

MES SIGNAUX DE GOÛT
${JSON.stringify(prefs,null,2)}

FAVORIS ACTUELS
${JSON.stringify(favs.map(w=>({brand:w.brand,model:w.model,reference:w.reference,price:w.price,platform:w.platform,url:w.url})),null,2)}

À ACHETER / SHORTLIST
${JSON.stringify(wish.map(w=>({brand:w.brand,model:w.model,reference:w.reference,price:w.price,platform:w.platform,url:w.url})),null,2)}

MODÈLES BANNIS
${JSON.stringify(state.bannedModels,null,2)}

ANNONCES DÉJÀ VUES
${JSON.stringify(compactSeen(),null,2)}

SORTIE OBLIGATOIRE
Réponds uniquement avec le marqueur WATCH_FEED_V1 puis un JSON valide, sans commentaire après.
Chaque objet doit idéalement contenir :
{
  "id": "identifiant stable si possible",
  "brand": "",
  "model": "",
  "reference": "",
  "year": "",
  "movement": "",
  "diameter": "",
  "style": "",
  "price": 0,
  "currency": "EUR",
  "platform": "",
  "url": "",
  "image": "URL directe de l'image principale si disponible",
  "images": [],
  "estimated_market_value": "",
  "interest_reason": "",
  "risk": "",
  "condition": "",
  "discovery_type": "exploitation ou exploration"
}

IMPORTANT
Les URL d'annonces doivent être réelles et vérifiées au moment de la recherche. Pour les images, utilise une URL directe lorsqu'elle est accessible ; sinon laisse "image" vide plutôt que d'inventer une URL.`;
}

function cardHTML(w, behind=false){
  const img=w.image ? `style="background-image:url('${escapeHtml(w.image)}')"` : "";
  return `<article class="watch-card ${behind?"behind":""}" data-id="${escapeHtml(w.id)}">
    <div class="watch-photo ${w.image?"":"no-image"}" ${img}>
      ${w.image?"":"⌚"}
      <div class="badge">${escapeHtml(w.platform || w.discovery_type || "Découverte")}</div>
      <div class="price-badge">${escapeHtml(money(w.price))}</div>
      ${isFavorite(w.id)?'<div class="favorite-badge">♥</div>':""}
    </div>
    <div class="card-body">
      <div class="card-title">${escapeHtml([w.brand,w.model].filter(Boolean).join(" "))}</div>
      <div class="card-sub">${escapeHtml([w.reference,w.year].filter(Boolean).join(" · ") || "Référence à confirmer")}</div>
      <div class="card-meta">
        ${w.movement?`<span class="meta-pill">${escapeHtml(w.movement)}</span>`:""}
        ${w.diameter?`<span class="meta-pill">${escapeHtml(w.diameter)}</span>`:""}
        ${w.style?`<span class="meta-pill">${escapeHtml(w.style)}</span>`:""}
      </div>
    </div>
  </article>`;
}

function listCard(w, mode){
  if(!w) return "";
  const img=w.image ? `style="background-image:url('${escapeHtml(w.image)}')"` : "";
  return `<div class="list-card">
    <div class="list-img" ${img}>${w.image?"":"⌚"}</div>
    <div class="list-content">
      <div class="list-title">${escapeHtml([w.brand,w.model].filter(Boolean).join(" "))}</div>
      <div class="list-sub">${escapeHtml([w.platform,w.reference,w.year].filter(Boolean).join(" · "))}</div>
      <div class="list-price">${escapeHtml(money(w.price))}</div>
      <div class="list-actions">
        <button class="mini-btn" data-detail="${escapeHtml(w.id)}">Détails</button>
        ${w.url?`<button class="mini-btn" data-open-url="${escapeHtml(w.url)}">Annonce</button>`:""}
        ${mode==="favorites"?`<button class="mini-btn red" data-remove-favorite="${escapeHtml(w.id)}">Retirer ♥</button>`:""}
        ${mode==="wishlist"?`<button class="mini-btn red" data-remove-wishlist="${escapeHtml(w.id)}">Retirer</button>`:""}
      </div>
    </div>
  </div>`;
}

function renderDiscover(){
  const empty=document.getElementById("emptyDiscover");
  const area=document.getElementById("cardArea");
  const stack=document.getElementById("cardStack");
  if(!state.queue.length){
    empty.classList.remove("hidden");
    area.classList.add("hidden");
    stack.innerHTML="";
    return;
  }
  empty.classList.add("hidden");
  area.classList.remove("hidden");
  const first=state.queue[0], second=state.queue[1];
  stack.innerHTML=(second?cardHTML(second,true):"")+cardHTML(first,false);
  setupDrag();
}
function renderLists(){
  const favs=state.favorites.map(findWatch).filter(Boolean);
  const wishes=state.wishlist.map(findWatch).filter(Boolean);
  const history=state.history;
  document.getElementById("favoritesList").innerHTML=favs.length?favs.map(w=>listCard(w,"favorites")).join(""):`<div class="empty-state"><h2>Aucun favori</h2><p>Appuie sur ♥ quand une carte mérite d'être conservée.</p></div>`;
  document.getElementById("wishlistList").innerHTML=wishes.length?wishes.map(w=>listCard(w,"wishlist")).join(""):`<div class="empty-state"><h2>Shortlist vide</h2><p>Swipe vers le haut pour ajouter une montre à acheter.</p></div>`;
  document.getElementById("historyList").innerHTML=history.length?history.map(w=>listCard(w,"history")).join(""):`<div class="empty-state"><h2>Aucun historique</h2></div>`;
  const liked=history.filter(w=>w.status==="liked").length;
  const rejected=history.filter(w=>w.status==="rejected").length;
  document.getElementById("statsGrid").innerHTML=[
    ["Vues",history.length],["Aimées",liked],["Rejetées",rejected],["Favoris",favs.length]
  ].map(([k,v])=>`<div class="stat"><strong>${v}</strong><span>${k}</span></div>`).join("");
}
function renderSettings(){
  document.getElementById("budgetTarget").value=state.settings.budgetTarget;
  document.getElementById("budgetMax").value=state.settings.budgetMax;
  document.getElementById("resultCount").value=state.settings.resultCount;
}
function render(){ renderDiscover(); renderLists(); renderSettings(); }

function setupDrag(){
  const card=[...document.querySelectorAll(".watch-card")].find(x=>!x.classList.contains("behind"));
  if(!card) return;
  let startX=0,startY=0,dx=0,dy=0,active=false;
  const start=e=>{
    const p=e.touches?e.touches[0]:e;
    startX=p.clientX;startY=p.clientY;active=true;
    card.style.transition="none";
  };
  const move=e=>{
    if(!active) return;
    const p=e.touches?e.touches[0]:e;
    dx=p.clientX-startX;dy=p.clientY-startY;
    card.style.transform=`translate(${dx}px,${dy}px) rotate(${dx/18}deg)`;
    card.style.opacity=Math.max(.55,1-Math.abs(dx)/500-Math.max(0,-dy)/600);
  };
  const end=async()=>{
    if(!active) return; active=false;
    card.style.transition="transform .22s ease, opacity .22s ease";
    if(dy<-95 && Math.abs(dy)>Math.abs(dx)*.8){
      card.style.transform="translateY(-120vh)";
      setTimeout(()=>swipe("wishlist"),180);
    } else if(dx>110){
      card.style.transform="translateX(120vw) rotate(18deg)";
      setTimeout(()=>swipe("liked"),180);
    } else if(dx<-110){
      card.style.transform="translateX(-120vw) rotate(-18deg)";
      setTimeout(()=>swipe("rejected"),180);
    } else {
      card.style.transform="";
      card.style.opacity="";
    }
  };
  card.addEventListener("touchstart",start,{passive:true});
  card.addEventListener("touchmove",move,{passive:true});
  card.addEventListener("touchend",end);
  card.addEventListener("mousedown",start);
  window.addEventListener("mousemove",move);
  window.addEventListener("mouseup",end,{once:true});
  card.addEventListener("click",e=>{
    if(Math.abs(dx)<8 && Math.abs(dy)<8) showDetail(card.dataset.id);
    dx=dy=0;
  });
}

function openModal(html){
  document.getElementById("modal").innerHTML=html;
  document.getElementById("modalBackdrop").classList.remove("hidden");
}
function closeModal(){ document.getElementById("modalBackdrop").classList.add("hidden"); }

function showPrompt(){
  const prompt=generatePrompt();
  openModal(`<h2>Prompt de chasse</h2>
    <p>Copie tout ce texte et colle-le dans ChatGPT.</p>
    <textarea id="promptText" readonly>${escapeHtml(prompt)}</textarea>
    <div class="modal-row">
      <button class="secondary" data-modal-close>Fermer</button>
      <button class="primary" id="copyPromptBtn">Copier</button>
    </div>`);
  document.getElementById("copyPromptBtn").onclick=async()=>{
    const ta=document.getElementById("promptText");
    try{ await navigator.clipboard.writeText(ta.value); }
    catch{ ta.select(); document.execCommand("copy"); }
    document.getElementById("copyPromptBtn").textContent="Copié ✓";
  };
}

function showImport(){
  openModal(`<h2>Importer une chasse</h2>
    <p>Colle ici la sortie WATCH_FEED_V1 fournie par ChatGPT.</p>
    <textarea id="importText" placeholder="WATCH_FEED_V1&#10;[ ... ]"></textarea>
    <div id="importStatus"></div>
    <div class="modal-row">
      <button class="secondary" data-modal-close>Annuler</button>
      <button class="primary" id="importBtn">Importer</button>
    </div>`);
  document.getElementById("importBtn").onclick=async()=>{
    const status=document.getElementById("importStatus");
    try{
      const r=await importFeed(document.getElementById("importText").value);
      status.innerHTML=`<p style="color:#63d19e">${r.added} ajoutée(s), ${r.duplicates} doublon(s), ${r.banned} modèle(s) banni(s).</p>`;
      setTimeout(closeModal,900);
    }catch(e){
      status.innerHTML=`<p style="color:#ff8a8a">Import impossible : ${escapeHtml(e.message)}</p>`;
    }
  };
}

function showDetail(id){
  const w=findWatch(id);
  if(!w) return;
  const img=w.image ? `style="background-image:url('${escapeHtml(w.image)}')"` : "";
  openModal(`
    <div class="detail-img" ${img}>${w.image?"":"⌚"}</div>
    <h2>${escapeHtml([w.brand,w.model].filter(Boolean).join(" "))}</h2>
    <p>${escapeHtml([w.reference,w.year,w.platform].filter(Boolean).join(" · "))}</p>
    <div class="detail-grid">
      <div class="detail-item"><span>Prix</span><strong>${escapeHtml(money(w.price))}</strong></div>
      <div class="detail-item"><span>Valeur estimée</span><strong>${escapeHtml(w.estimated_market_value||"—")}</strong></div>
      <div class="detail-item"><span>Mouvement</span><strong>${escapeHtml(w.movement||"—")}</strong></div>
      <div class="detail-item"><span>Diamètre</span><strong>${escapeHtml(w.diameter||"—")}</strong></div>
    </div>
    ${w.interest_reason?`<div class="reason-box"><strong>Pourquoi elle est intéressante</strong><br>${escapeHtml(w.interest_reason)}</div>`:""}
    ${w.risk?`<div class="reason-box"><strong>Risque / points à vérifier</strong><br>${escapeHtml(w.risk)}</div>`:""}
    <button class="secondary full" data-fav-detail="${escapeHtml(w.id)}">${isFavorite(w.id)?"Retirer des favoris ♥":"Ajouter aux favoris ♥"}</button>
    <button class="secondary full" data-wish-detail="${escapeHtml(w.id)}">${isWishlist(w.id)?"Retirer de « À acheter »":"Ajouter à « À acheter » ↑"}</button>
    ${w.url?`<button class="primary full" data-open-url="${escapeHtml(w.url)}">Ouvrir l’annonce</button>`:""}
    <button class="danger-btn full" data-ban-model="${escapeHtml(w.id)}">Ne plus proposer ce modèle</button>
    <button class="secondary full" data-modal-close>Fermer</button>
  `);
}

async function saveSettings(){
  state.settings.budgetTarget=Number(document.getElementById("budgetTarget").value)||100;
  state.settings.budgetMax=Number(document.getElementById("budgetMax").value)||120;
  state.settings.resultCount=Math.max(5,Math.min(100,Number(document.getElementById("resultCount").value)||20));
  await saveState();
  alert("Réglages enregistrés.");
}
function exportBackup(){
  const blob=new Blob([JSON.stringify({version:1,exportedAt:nowISO(),state},null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;
  a.download=`watch-hunt-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function importBackup(file){
  const txt=await file.text();
  const obj=JSON.parse(txt);
  state=mergeDefaults(obj.state||obj);
  await saveState();
  render();
  alert("Sauvegarde importée.");
}
async function resetApp(){
  if(!confirm("Effacer toutes les données locales de Watch Hunt ?")) return;
  state=structuredClone(DEFAULT_STATE);
  await saveState();
  render();
}

function switchView(view){
  const map={discover:"Découvrir",favorites:"Favoris",wishlist:"À acheter",library:"Historique",settings:"Réglages"};
  document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
  document.getElementById(`${view}View`).classList.add("active");
  document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  document.getElementById("pageTitle").textContent=map[view];
  document.getElementById("headerAction").style.visibility=view==="discover"?"visible":"hidden";
  window.scrollTo({top:0,behavior:"smooth"});
}

document.addEventListener("click",async e=>{
  const t=e.target.closest("button,[data-action],[data-view],[data-detail],[data-open-url],[data-remove-favorite],[data-remove-wishlist],[data-fav-detail],[data-wish-detail],[data-ban-model],[data-modal-close]");
  if(!t) return;

  if(t.dataset.view) return switchView(t.dataset.view);
  if(t.dataset.action==="open-prompt") return showPrompt();
  if(t.dataset.action==="open-import") return showImport();
  if(t.dataset.action==="toggle-favorite") return toggleFavorite();
  if(t.dataset.action==="save-settings") return saveSettings();
  if(t.dataset.action==="export-backup") return exportBackup();
  if(t.dataset.action==="reset-app") return resetApp();
  if(t.dataset.swipe==="left") return swipe("rejected");
  if(t.dataset.swipe==="right") return swipe("liked");
  if(t.dataset.swipe==="up") return swipe("wishlist");
  if(t.dataset.detail) return showDetail(t.dataset.detail);
  if(t.dataset.openUrl) return window.open(t.dataset.openUrl,"_blank","noopener");
  if(t.dataset.removeFavorite) return toggleFavorite(t.dataset.removeFavorite);
  if(t.dataset.removeWishlist) return toggleWishlist(t.dataset.removeWishlist);
  if(t.dataset.favDetail){ await toggleFavorite(t.dataset.favDetail); return showDetail(t.dataset.favDetail); }
  if(t.dataset.wishDetail){ await toggleWishlist(t.dataset.wishDetail); return showDetail(t.dataset.wishDetail); }
  if(t.dataset.banModel) return banModel(t.dataset.banModel);
  if(t.hasAttribute("data-modal-close")) return closeModal();
});
document.getElementById("headerAction").addEventListener("click",showImport);
document.getElementById("modalBackdrop").addEventListener("click",e=>{ if(e.target.id==="modalBackdrop") closeModal(); });
document.getElementById("backupFile").addEventListener("change",async e=>{
  if(e.target.files?.[0]){
    try{ await importBackup(e.target.files[0]); }
    catch(err){ alert("Sauvegarde invalide."); }
    e.target.value="";
  }
});

async function init(){
  await loadState();
  render();
  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }
}
init();
