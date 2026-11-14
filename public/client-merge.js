/* =====================================================================
   MERGE CLIENTS — ONE PERSON, ONE PROFILE

   The same investor ends up in BOSS twice: once typed in by an RM with
   their PAN and mobile, and again from a platform report that spells the
   name in full and carries no PAN ("DEXTER PETER FONSECA" and "Dexter
   Peter Nicholas Fonseca"). Nothing about the two records says they are
   one person, so nothing in BOSS can join them by itself. A person can.

   What a merge does, in this order, so that a failure part-way leaves
   nothing lost:

     1. Writes the merge record first — a full copy of every record being
        merged away and of the master as it stood — in clientMerges. That
        record is never rewritten, so whatever happens next, the original
        data is still on file.
     2. Points every record that names a merged-away client at the master:
        transactions, holdings, SIPs, allocations, goals, tasks, meetings,
        calls, documents, form links, multi-asset rows… Every store, not a
        list of them, because a client id is a random string that means
        that client and nothing else. Logs (the audit trail, import
        history, what each import did) are left as they were written —
        they are history, and an import's undo must never be able to
        delete the master in place of the record it created.
     3. Fills the master: a field the master leaves empty takes the other
        record's value, lists (nominees, family, documents, notes) are
        joined, and where both hold different values the person merging
        picks one. The value not picked is still in the merge record.
     4. Removes the merged-away records and writes an audit line on the
        master and on each of them.

   And it is remembered. The master carries mergedFrom: the id, name,
   PAN, mobile and email of every record merged into it. The import
   index (impClientIndex) reads those as names and PANs the master is
   also known by, so the next platform report that says "Dexter Peter
   Nicholas Fonseca" lands on the master instead of making the duplicate
   again — and a row, an export or a link that still carries the old id
   is pointed at the master.
   ===================================================================== */

const CM_LOG_KEY = 'clientMerges';
/* History, not data about a client. Rewritten, these would claim the
   master did what the merged record did, and an import's undo would
   delete the master in place of the record that import created. */
const CM_SKIP_STORES = new Set([
  CM_LOG_KEY, 'clients', 'auditLog', 'settingsAudit', 'importHistory', 'importUndo', 'exportHistory',
  'backupHistory', 'errorLog', 'automationExecutionLog', 'apiReqLog', 'apiSyncRuns',
  'config', 'settings', 'team', 'hrAttendance', 'hrLeave', 'hrConfig', 'hrSourceMaps', 'hrRegularizations',
  'hrCompOff', 'hrIncentives', 'hrAppraisals',
]);
/* Kept from the master whatever the others hold: who the record is, where
   it is in its journey, and when it was made. */
const CM_MASTER_KEYS = new Set(['id', 'mergedFrom', 'aka', 'blueprintHistory', 'createdBy', 'createdAt',
  'deletedAt', 'deletedBy', 'updatedAt', 'updatedBy']);

/* ---- who may, and what the system remembers ---------------------- */

/* Merging changes one client and removes others, so it takes both. */
function cmCanMerge(){
  return typeof can === 'function' && can('CMS', 'edit') && can('CMS', 'delete');
}
function cmLog(){ return Array.isArray(DB[CM_LOG_KEY]) ? DB[CM_LOG_KEY] : (DB[CM_LOG_KEY] = []); }
function cmLiveClients(){ return (DB.clients || []).filter(c=>c && !c.deletedAt); }

/* Every id that has been merged away, and the live client it now is.
   Chains are followed: a master later merged into another client hands
   its whole history on, so the old ids land on the newest master. */
function cmRedirects(){
  const out = {};
  cmLiveClients().forEach(c=>(c.mergedFrom || []).forEach(m=>{ if(m && m.id && m.id !== c.id) out[m.id] = c.id; }));
  return out;
}
function cmMergedInto(id){
  if(!id) return '';
  const live = (DB.clients || []).find(c=>c && c.id === id && !c.deletedAt);
  if(live) return '';
  return cmRedirects()[id] || '';
}
/* The names, PANs, mobiles and emails a client is also known by. */
function cmAliases(c){
  const a = {names: [], pans: [], mobiles: [], emails: []};
  /* The master's own earlier name, PAN, mobile or email, where the merge
     kept another record's value in its place. */
  const k = (c && c.aka) || {};
  ['names', 'pans', 'mobiles', 'emails'].forEach(f=>{ if(Array.isArray(k[f])) a[f].push(...k[f].filter(Boolean)); });
  (c && c.mergedFrom || []).forEach(m=>{
    if(!m) return;
    if(m.name) a.names.push(m.name);
    if(m.pan) a.pans.push(m.pan);
    if(m.mobile) a.mobiles.push(m.mobile);
    if(m.email) a.emails.push(m.email);
  });
  return a;
}
function cmNamesOf(c){ return [c && c.cmsName].concat(cmAliases(c).names).filter(Boolean); }
function cmPansOf(c){ return [c && c.pan].concat(cmAliases(c).pans).filter(Boolean); }
function cmMobilesOf(c){
  return [c && c.mobile].concat(cmAliases(c).mobiles)
    .map(m=>String(m || '').replace(/\D/g, '').slice(-10)).filter(m=>m.length === 10);
}

/* ---- telling two records are one person -------------------------- */

const CM_HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'shri', 'sri', 'smt', 'kumari', 'km', 'late', 'master', 'prof', 'md']);
function cmNameTokens(name){
  return String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(t=>t && !CM_HONORIFICS.has(t));
}
function cmEdit1(a, b){
  if(a === b) return true;
  if(Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while(i < a.length && j < b.length){
    if(a[i] === b[j]){ i++; j++; continue; }
    if(++diff > 1) return false;
    if(a.length > b.length) i++; else if(b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}
/* "A" matches "Amit"; "Fonseca" matches "Fonseka"; nothing else bends. */
function cmTokenMatch(a, b){
  if(a === b) return true;
  if(a.length === 1 || b.length === 1) return a[0] === b[0];
  return a.length >= 4 && b.length >= 4 && cmEdit1(a, b);
}
/* How far one name sits inside the other: 1 when every word of the
   shorter name is in the longer one. A middle name more or less, an
   initial for a first name, a letter mistyped — all still 1. */
function cmNameScore(a, b){
  const A = cmNameTokens(a), B = cmNameTokens(b);
  if(!A.length || !B.length) return {score: 0, why: ''};
  const [S, L] = A.length <= B.length ? [A, B] : [B, A];
  const used = new Set();
  let hit = 0;
  S.forEach(t=>{
    const k = L.findIndex((u, i)=>!used.has(i) && cmTokenMatch(t, u));
    if(k >= 0){ used.add(k); hit++; }
  });
  const contain = hit / S.length;
  const firstSame = cmTokenMatch(A[0], B[0]);
  if(contain === 1 && S.length >= 2) return {score: S.length === L.length ? 70 : 60,
    why: S.length === L.length ? 'same name' : 'one name contains the other'};
  if(contain === 1 && S.length === 1 && L.length === 1) return {score: 30, why: 'same single name'};
  if(contain >= 0.66 && firstSame && S.length >= 3) return {score: 35, why: 'similar name'};
  return {score: 0, why: ''};
}
function cmDigits(v){ const d = String(v || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; }
function cmPan(v){ const p = String(v || '').toUpperCase().replace(/[\s\-]/g, ''); return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p) ? p : ''; }
function cmEmail(v){ const e = String(v || '').trim().toLowerCase(); return /@/.test(e) ? e : ''; }
function cmDob(v){ return String(v || '').slice(0, 10); }

/* Two records, scored. null means they are certainly different people:
   two different PANs are two different taxpayers. */
function cmPairScore(a, b){
  const reasons = [];
  let score = 0;
  const pa = cmPansOf(a).map(cmPan).filter(Boolean), pb = cmPansOf(b).map(cmPan).filter(Boolean);
  if(pa.length && pb.length){
    if(pa.some(p=>pb.indexOf(p) >= 0)){ score += 100; reasons.push('same PAN'); }
    else return null;
  }
  let best = {score: 0, why: ''};
  cmNamesOf(a).forEach(x=>cmNamesOf(b).forEach(y=>{ const s = cmNameScore(x, y); if(s.score > best.score) best = s; }));
  if(best.score){ score += best.score; reasons.push(best.why); }
  const ma = cmMobilesOf(a), mb = cmMobilesOf(b);
  if(ma.length && mb.length){
    if(ma.some(m=>mb.indexOf(m) >= 0)){ score += 45; reasons.push('same mobile'); }
    else { score -= 25; reasons.push('different mobiles'); }
  }
  const ea = [a.email].concat(cmAliases(a).emails).map(cmEmail).filter(Boolean);
  const eb = [b.email].concat(cmAliases(b).emails).map(cmEmail).filter(Boolean);
  if(ea.length && eb.length){
    if(ea.some(e=>eb.indexOf(e) >= 0)){ score += 45; reasons.push('same email'); }
    else score -= 10;
  }
  const da = cmDob(a.dob), db = cmDob(b.dob);
  if(da && db){
    if(da === db){ score += 25; reasons.push('same date of birth'); }
    else { score -= 40; reasons.push('different dates of birth'); }
  }
  /* A name alone is not enough unless it is close; a shared mobile or
     email alone is not enough either (a family shares a phone). */
  const strongName = best.score >= 60;
  const contact = reasons.indexOf('same mobile') >= 0 || reasons.indexOf('same email') >= 0;
  const pan = reasons.indexOf('same PAN') >= 0;
  if(!(pan || (strongName && score >= 60) || (best.score >= 30 && contact && score >= 75))) return null;
  return {score, reasons};
}
function cmPairKey(a, b){ return a < b ? a + '|' + b : b + '|' + a; }
function cmDismissed(){
  const s = new Set();
  cmLog().forEach(e=>{ if(e && e.kind === 'notDuplicate' && Array.isArray(e.ids))
    for(let i = 0; i < e.ids.length; i++) for(let j = i + 1; j < e.ids.length; j++) s.add(cmPairKey(e.ids[i], e.ids[j])); });
  return s;
}
/* Every likely pair in the book. Not every pair of 2,500 clients is
   compared — only records that share a PAN, a mobile, an email or a word
   of their name — which is what keeps this to a moment. */
function cmFindPairs(clients){
  clients = clients || cmLiveClients();
  const buckets = new Map();
  const put = (k, i)=>{ if(!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(i); };
  clients.forEach((c, i)=>{
    cmPansOf(c).map(cmPan).filter(Boolean).forEach(p=>put('p:' + p, i));
    cmMobilesOf(c).forEach(m=>put('m:' + m, i));
    [c.email].concat(cmAliases(c).emails).map(cmEmail).filter(Boolean).forEach(e=>put('e:' + e, i));
    /* A name is filed under every pair of its words, not every word: a
       strong name match needs two words in common, and "Kumar" alone would
       put half the book in one heap. An initial with a surname ("A Kumar")
       is filed under the letter and the last word. */
    cmNamesOf(c).forEach(n=>{
      const w = cmNameTokens(n);
      const long = Array.from(new Set(w.filter(t=>t.length >= 3))).sort();
      if(long.length === 1 && w.length === 1) put('n:' + long[0], i);
      for(let x = 0; x < long.length; x++) for(let y = x + 1; y < long.length; y++) put('n:' + long[x] + '|' + long[y], i);
      if(w.length >= 2) put('i:' + w[0][0] + '|' + w[w.length - 1], i);
    });
  });
  const dismissed = cmDismissed();
  const seen = new Set(), pairs = [];
  buckets.forEach((list, key)=>{
    /* A word shared by hundreds of clients (Kumar, Singh) says nothing;
       the other words of those names still bring the real pairs together. */
    if(list.length < 2 || (key[0] !== 'p' && list.length > 150)) return;
    for(let x = 0; x < list.length; x++) for(let y = x + 1; y < list.length; y++){
      const a = clients[list[x]], b = clients[list[y]];
      /* One record saved twice under one id is not two people to merge —
         it is shown, and tidied, on its own (cmSameIdCopies). */
      if(a.id === b.id) continue;
      const k = cmPairKey(a.id, b.id);
      if(seen.has(k)) continue;
      seen.add(k);
      if(dismissed.has(k)) continue;
      const s = cmPairScore(a, b);
      if(s) pairs.push({a: a.id, b: b.id, score: s.score, reasons: s.reasons});
    }
  });
  return pairs.sort((p, q)=>q.score - p.score);
}
/* Pairs joined into groups: if A is B and B is C, the three are shown together. */
function cmFindGroups(clients){
  const pairs = cmFindPairs(clients);
  const parent = {};
  const find = x=>{ while(parent[x] && parent[x] !== x) x = parent[x]; return x; };
  pairs.forEach(p=>{ parent[p.a] = parent[p.a] || p.a; parent[p.b] = parent[p.b] || p.b; const ra = find(p.a), rb = find(p.b); if(ra !== rb) parent[rb] = ra; });
  const groups = {};
  pairs.forEach(p=>{
    const r = find(p.a);
    const g = groups[r] = groups[r] || {ids: new Set(), score: 0, reasons: new Set()};
    g.ids.add(p.a); g.ids.add(p.b);
    g.score = Math.max(g.score, p.score);
    p.reasons.forEach(x=>g.reasons.add(x));
  });
  /* Common names chain: Rahul Sharma to Rahul K Sharma to Rahul Kumar
     Sharma… A group that has grown past a handful is not one person, so
     it is shown as the pairs it was built from. */
  const out = [];
  Object.entries(groups).forEach(([root, g])=>{
    if(g.ids.size <= 5) out.push({ids: Array.from(g.ids), score: g.score, reasons: Array.from(g.reasons)});
    else pairs.filter(p=>find(p.a) === root).forEach(p=>out.push({ids: [p.a, p.b], score: p.score, reasons: p.reasons}));
  });
  return out.sort((a, b)=>b.score - a.score);
}
function cmDuplicatesOf(id){
  const c = cmLiveClients().find(x=>x.id === id);
  if(!c) return [];
  const dismissed = cmDismissed();
  return cmLiveClients().filter(o=>o.id !== id && !dismissed.has(cmPairKey(id, o.id)))
    .map(o=>({c: o, s: cmPairScore(c, o)})).filter(x=>x.s).sort((p, q)=>q.s.score - p.s.score);
}

/* ---- the merge itself --------------------------------------------- */

function cmCopy(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function cmEmpty(v){
  if(v === undefined || v === null) return true;
  if(typeof v === 'string') return v.trim() === '';
  if(Array.isArray(v)) return v.length === 0;
  if(typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}
function cmSame(a, b){
  if(typeof a === 'string' || typeof b === 'string')
    return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase();
  return JSON.stringify(a) === JSON.stringify(b);
}
function cmPlain(v){ return v && typeof v === 'object' && !Array.isArray(v); }
/* Two lists as one, nobody twice: by id where the items have one. */
function cmJoinLists(a, b){
  const out = (a || []).slice();
  const keys = new Set(out.map(x=>cmPlain(x) && x.id ? 'id:' + x.id : 'v:' + JSON.stringify(x)));
  (b || []).forEach(x=>{
    const k = cmPlain(x) && x.id ? 'id:' + x.id : 'v:' + JSON.stringify(x);
    if(!keys.has(k)){ keys.add(k); out.push(cmCopy(x)); }
  });
  return out;
}
/* An object inside a record (an address block, a set of flags): what the
   master has stays; what only the other has is added. */
function cmFillObject(m, o){
  const out = cmCopy(m) || {};
  Object.keys(o || {}).forEach(k=>{
    if(cmEmpty(out[k])) out[k] = cmCopy(o[k]);
    else if(Array.isArray(out[k]) && Array.isArray(o[k])) out[k] = cmJoinLists(out[k], o[k]);
    else if(cmPlain(out[k]) && cmPlain(o[k])) out[k] = cmFillObject(out[k], o[k]);
  });
  return out;
}
function cmStateKey(){ return (typeof RECORD_STATE_FIELD !== 'undefined' && RECORD_STATE_FIELD.CMS) || 'cmsStage'; }
function cmHuman(k){ return String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c=>c.toUpperCase()); }
function cmFieldLabels(){
  const out = {};
  try { (typeof cmsFieldsFlatVisible === 'function' ? cmsFieldsFlatVisible() : []).forEach(f=>{ if(f && f.k && f.l) out[f.k] = f.l; }); } catch(e){}
  if(!out.cmsName) out.cmsName = 'Client Name';
  return out;
}
/* What a merge of these records would do, worked out without writing
   anything: the fields that disagree, the fields filled from the others,
   and the master as it would be. choices: {field: id of the record whose
   value wins}. */
function cmPlan(masterId, ids, choices){
  choices = choices || {};
  const all = ids.map(id=>cmLiveClients().find(c=>c.id === id)).filter(Boolean);
  const master = all.find(c=>c.id === masterId);
  if(!master || all.length < 2) return null;
  const others = all.filter(c=>c.id !== masterId);
  const labels = cmFieldLabels();
  const stateKey = cmStateKey();
  const out = cmCopy(master);
  const conflicts = [], filled = [];
  const keys = new Set();
  all.forEach(c=>Object.keys(c).forEach(k=>keys.add(k)));
  keys.forEach(k=>{
    if(CM_MASTER_KEYS.has(k) || k === stateKey) return;
    const vals = all.map(c=>({id: c.id, v: c[k]})).filter(x=>!cmEmpty(x.v));
    if(!vals.length) return;
    const mv = master[k];
    if(vals.every(x=>Array.isArray(x.v))){
      let joined = Array.isArray(mv) ? cmCopy(mv) : [];
      others.forEach(o=>{ if(Array.isArray(o[k])) joined = cmJoinLists(joined, o[k]); });
      if(joined.length !== (Array.isArray(mv) ? mv.length : 0)) filled.push({k, label: labels[k] || cmHuman(k), from: 'joined'});
      out[k] = joined;
      return;
    }
    if(vals.every(x=>cmPlain(x.v))){
      let obj = cmPlain(mv) ? cmCopy(mv) : {};
      others.forEach(o=>{ if(cmPlain(o[k])) obj = cmFillObject(obj, o[k]); });
      out[k] = obj;
      return;
    }
    const distinct = [];
    vals.forEach(x=>{ if(!distinct.some(d=>cmSame(d.v, x.v))) distinct.push(x); });
    if(distinct.length > 1 && labels[k]){
      const pick = choices[k] && vals.find(x=>x.id === choices[k]) ? choices[k]
        : (!cmEmpty(mv) ? masterId : vals[0].id);
      conflicts.push({k, label: labels[k], options: vals, pick});
      out[k] = cmCopy(all.find(c=>c.id === pick)[k]);
      return;
    }
    if(cmEmpty(mv)){
      out[k] = cmCopy(vals[0].v);
      filled.push({k, label: labels[k] || cmHuman(k), from: vals[0].id});
    }
  });
  /* Who the master is also known as, from now on: every record merged in,
     and everything those records had already absorbed. */
  const at = new Date().toISOString();
  let mergedFrom = (master.mergedFrom || []).slice();
  others.forEach(o=>{
    mergedFrom = mergedFrom.concat(o.mergedFrom || []);
    mergedFrom.push({id: o.id, name: o.cmsName || '', pan: cmPan(o.pan) || '', mobile: cmDigits(o.mobile) || '',
      email: cmEmail(o.email) || '', at, by: currentUser});
  });
  /* Where the master takes another record's name, PAN, mobile or email,
     what it was called before is still a name it is known by. */
  const aka = cmCopy(master.aka) || {};
  others.forEach(o=>{ const oa = o.aka || {}; Object.keys(oa).forEach(f=>{ aka[f] = (aka[f] || []).concat(oa[f] || []); }); });
  [['cmsName', 'names'], ['pan', 'pans'], ['mobile', 'mobiles'], ['email', 'emails']].forEach(([k, f])=>{
    if(!cmEmpty(master[k]) && !cmSame(master[k], out[k])) aka[f] = (aka[f] || []).concat([master[k]]);
  });
  Object.keys(aka).forEach(f=>{ aka[f] = aka[f].filter((v, i, arr)=>v && arr.findIndex(x=>cmSame(x, v)) === i); if(!aka[f].length) delete aka[f]; });
  if(Object.keys(aka).length) out.aka = aka; else delete out.aka;
  out.mergedFrom = mergedFrom.filter((m, i, arr)=>m && m.id !== master.id && arr.findIndex(x=>x.id === m.id) === i);
  const created = all.map(c=>c.createdAt).filter(Boolean).sort()[0];
  if(created) out.createdAt = created;
  out.updatedAt = at; out.updatedBy = currentUser;
  return {master, others, all, out, conflicts, filled};
}

/* Replace every merged-away id with the master's, anywhere inside a value.
   Returns the same object when nothing in it changed, so a store with no
   reference to these clients is not written. */
function cmReplace(v, map){
  if(typeof v === 'string') return Object.prototype.hasOwnProperty.call(map, v) ? map[v] : v;
  if(Array.isArray(v)){
    let changed = false;
    const out = v.map(x=>{ const y = cmReplace(x, map); if(y !== x) changed = true; return y; });
    return changed ? out : v;
  }
  if(cmPlain(v)){
    let changed = false;
    const out = {};
    Object.keys(v).forEach(k=>{
      const nk = Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k;
      const nv = cmReplace(v[k], map);
      if(nk !== k || nv !== v[k]) changed = true;
      if(nk !== k && out[nk] !== undefined){
        out[nk] = Array.isArray(out[nk]) && Array.isArray(nv) ? out[nk].concat(nv)
          : cmPlain(out[nk]) && cmPlain(nv) ? Object.assign({}, nv, out[nk]) : out[nk];
      } else out[nk] = nv;
    });
    return changed ? out : v;
  }
  return v;
}
function cmStoreLabel(key){
  if(typeof maIsRowsKey === 'function' && maIsRowsKey(key)) return 'Multi-asset holdings and SIPs';
  return (typeof RESET_LABELS !== 'undefined' && RESET_LABELS[key]) || ({
    clients: 'Other clients (referred by)', notifications: 'Notifications', queries: 'Tickets', queryReplies: 'Ticket replies',
    workActivities: 'Work activities', callEntries: 'Call logs'})[key] || key;
}
/* Which stores hold records of these clients, and how many records each. */
function cmLinked(map, keepIds){
  const out = [];
  Object.keys(DB).forEach(key=>{
    if(CM_SKIP_STORES.has(key) || /^_/.test(key)) return;
    const v = DB[key];
    if(!Array.isArray(v)) return;
    let n = 0;
    v.forEach(r=>{ if(cmReplace(r, map) !== r) n++; });
    if(n) out.push({key, label: cmStoreLabel(key), n});
  });
  const refs = cmLiveClients().filter(c=>keepIds.indexOf(c.id) < 0 && cmReplace(c, map) !== c).length;
  if(refs) out.push({key: 'clients', label: cmStoreLabel('clients'), n: refs});
  return out;
}

async function cmMerge(masterId, ids, choices){
  if(!cmCanMerge()) throw new Error('You need Edit and Delete permission on CMS to merge clients.');
  if(typeof maLoadRows === 'function') await maLoadRows();          // every multi-asset row is in hand before it is rewritten
  const plan = cmPlan(masterId, ids, choices);
  if(!plan) throw new Error('Pick at least two clients that are still on file.');
  const otherIds = plan.others.map(o=>o.id);
  const map = {};
  otherIds.forEach(id=>{ map[id] = masterId; });
  /* Ids merged into the records going away now point at the master too. */
  plan.others.forEach(o=>(o.mergedFrom || []).forEach(m=>{ if(m && m.id) map[m.id] = masterId; }));
  const linked = cmLinked(map, [masterId].concat(otherIds));

  const entry = {id: uid('MRG'), kind: 'merge', at: new Date().toISOString(), by: currentUser,
    masterId, masterName: plan.out.cmsName || '', mergedIds: otherIds, mergedNames: plan.others.map(o=>o.cmsName || ''),
    choices: plan.conflicts.reduce((m, c)=>{ m[c.k] = c.pick; return m; }, {}),
    moved: linked.reduce((m, l)=>{ m[l.key] = l.n; return m; }, {}),
    masterBefore: cmCopy(plan.master), records: plan.others.map(cmCopy)};
  if(typeof autoSuspend === 'function') autoSuspend();
  if(typeof auditSuspend === 'function') auditSuspend();
  try {
    /* 1 — the record of it, with every original, before anything moves. */
    DB[CM_LOG_KEY] = cmLog().concat([entry]);
    if(await save(CM_LOG_KEY) === false) throw new Error('The merge record could not be saved, so nothing was changed.');
    /* 2 — everything that names a merged-away client now names the master. */
    for(const l of linked){
      if(l.key === 'clients') continue;
      DB[l.key] = DB[l.key].map(r=>cmReplace(r, map));
      if(typeof maIsRowsKey === 'function' && maIsRowsKey(l.key)) await sset(l.key, DB[l.key]);
      else await save(l.key);
    }
    /* 3 and 4 — the master filled in, the others gone, in one write. */
    DB.clients = (DB.clients || []).filter(c=>otherIds.indexOf(c.id) < 0)
      .map(c=>c.id === masterId ? plan.out : cmReplace(c, map));
    await save('clients');
    await logAudit('CMS', masterId, 'Clients Merged', [
      {field: 'Merged into this client', oldValue: plan.others.map(o=>(o.cmsName || '') + ' (' + o.id + ')').join(', '), newValue: masterId}]
      .concat(plan.conflicts.filter(c=>c.pick !== masterId).map(c=>({field: c.label, oldValue: plan.master[c.k] == null ? '' : plan.master[c.k], newValue: plan.out[c.k]})))
      .concat(plan.filled.filter(f=>f.from !== 'joined').map(f=>({field: f.label, oldValue: '', newValue: plan.out[f.k]}))));
    for(const o of plan.others)
      await logAudit('CMS', o.id, 'Merged Into ' + masterId, [{field: 'Master client', oldValue: o.id, newValue: masterId + ' — ' + (plan.out.cmsName || '')}]);
  } finally {
    if(typeof auditSuspend === 'function') await auditResume();
    if(typeof autoResume === 'function') autoResume();
  }
  if(typeof maInvalidate === 'function') maInvalidate();
  return {entry, linked, plan};
}
async function cmNotDuplicates(ids){
  DB[CM_LOG_KEY] = cmLog().concat([{id: uid('MRG'), kind: 'notDuplicate', ids: ids.slice().sort(), at: new Date().toISOString(), by: currentUser}]);
  await save(CM_LOG_KEY);
}

/* A row from an import or a restore that still carries an old id. */
function cmRedirectRow(row){
  const map = cmRedirects();
  return Object.keys(map).length ? cmReplace(row, map) : row;
}

/* =====================================================================
   THE SCREENS
   ===================================================================== */
let cmState = null;            // the merge dialog: {ids, masterId, choices, q}

function cmRecordCells(c){
  return [esc(c.cmsName || '—') + `<div class="small-note" style="margin:2px 0 0">${esc(c.id)}</div>`,
    esc(c.pan ? bossMaskSafe(c.pan) : '—'), esc(c.mobile || '—'), esc(c.email || '—'),
    esc(c.rmName ? teamName(c.rmName) : '—'), esc(c.branch || '—'), c.createdAt ? fmtDate(c.createdAt) : '—'];
}
/* The record with the most on it is the natural master. */
function cmBestMaster(ids){
  const filled = c=>Object.keys(c).filter(k=>!cmEmpty(c[k])).length + (cmPan(c.pan) ? 20 : 0) + (c.mobile ? 5 : 0);
  const recs = ids.map(id=>cmLiveClients().find(c=>c.id === id)).filter(Boolean);
  recs.sort((a, b)=>filled(b) - filled(a) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  return recs[0] ? recs[0].id : ids[0];
}

function openClientMerge(ids){
  if(!cmCanMerge()){ alert('Merging clients needs Edit and Delete permission on CMS.'); return; }
  ids = Array.from(new Set((ids || []).filter(id=>cmLiveClients().some(c=>c.id === id))));
  cmState = {ids, masterId: cmBestMaster(ids), choices: {}, q: ''};
  renderClientMerge();
}
function cmAdd(id){ if(cmState && cmState.ids.indexOf(id) < 0){ cmState.ids.push(id); cmState.q = ''; if(cmState.ids.length === 2) cmState.masterId = cmBestMaster(cmState.ids); } renderClientMerge(); }
function cmDrop(id){
  if(!cmState) return;
  cmState.ids = cmState.ids.filter(x=>x !== id);
  if(cmState.masterId === id) cmState.masterId = cmBestMaster(cmState.ids);
  renderClientMerge();
}
function cmSearchHits(){
  const q = String(cmState.q || '').trim().toLowerCase();
  const sel = new Set(cmState.ids);
  if(!q){
    /* Nothing typed: the likely duplicates of the clients already picked. */
    const seen = new Set(), out = [];
    cmState.ids.forEach(id=>cmDuplicatesOf(id).forEach(x=>{ if(!sel.has(x.c.id) && !seen.has(x.c.id)){ seen.add(x.c.id); out.push({c: x.c, why: x.s.reasons.join(', ')}); } }));
    return out.slice(0, 8);
  }
  const digits = q.replace(/\D/g, '');
  return cmLiveClients().filter(c=>!sel.has(c.id) && (
      String(c.cmsName || '').toLowerCase().indexOf(q) >= 0 || String(c.id).toLowerCase().indexOf(q) >= 0
      || String(c.pan || '').toLowerCase() === q || (digits.length >= 4 && String(c.mobile || '').indexOf(digits) >= 0)))
    .slice(0, 8).map(c=>({c, why: ''}));
}
function renderClientMerge(){
  const st = cmState;
  if(!st) return;
  const recs = st.ids.map(id=>cmLiveClients().find(c=>c.id === id)).filter(Boolean);
  const plan = recs.length >= 2 ? cmPlan(st.masterId, st.ids, st.choices) : null;
  let linked = [];
  if(plan){
    const map = {};
    plan.others.forEach(o=>{ map[o.id] = st.masterId; (o.mergedFrom || []).forEach(m=>{ if(m && m.id) map[m.id] = st.masterId; }); });
    linked = cmLinked(map, st.ids);
  }
  const hits = cmSearchHits();
  const recRows = recs.map(c=>`<tr>
      <td><input type="radio" name="cmMaster" ${c.id === st.masterId ? 'checked' : ''} onchange="cmState.masterId='${c.id}'; cmState.choices={}; renderClientMerge()" aria-label="Keep ${esc(c.cmsName || c.id)} as the master"></td>
      ${cmRecordCells(c).map(x=>`<td>${x}</td>`).join('')}
      <td><button class="btn sm ghost" onclick="cmDrop('${c.id}')" title="Take this client out of the merge">✕</button></td></tr>`);
  const conflictRows = plan ? plan.conflicts.map(cf=>`<tr><td><b>${esc(cf.label)}</b></td><td>${cf.options.map(o=>{
      const rec = recs.find(r=>r.id === o.id);
      return `<label style="display:block;margin:2px 0"><input type="radio" name="cm_${esc(cf.k)}" ${cf.pick === o.id ? 'checked' : ''}
        onchange="cmState.choices['${esc(cf.k)}']='${o.id}'; renderClientMerge()"> ${esc(typeof o.v === 'object' ? JSON.stringify(o.v) : String(o.v))}
        <span class="small-note" style="margin:0">— ${esc(rec ? rec.id : o.id)}${o.id === st.masterId ? ', master' : ''}</span></label>`;
    }).join('')}</td></tr>`) : [];
  const master = recs.find(c=>c.id === st.masterId);
  const uniq = arr=>arr.filter((v, i)=>arr.findIndex(x=>cmSame(x, v)) === i);
  const aka = plan ? uniq(cmNamesOf(plan.out).filter(n=>!cmSame(n, plan.out.cmsName))) : [];
  const akaPans = plan ? uniq(cmPansOf(plan.out).map(cmPan).filter(p=>p && p !== cmPan(plan.out.pan))) : [];
  const body = `
    <p class="small-note" style="margin-top:0">The clients below are one person. The one you mark <b>Master</b> stays; the others are folded into it and removed.
      Every transaction, holding, SIP, allocation, task, meeting, document and form of theirs moves to the master, and a full copy of each record is kept in the merge history.</p>
    ${repTable([{t: 'Master'}, {t: 'Client'}, {t: 'PAN'}, {t: 'Mobile'}, {t: 'Email'}, {t: 'RM'}, {t: 'Branch'}, {t: 'Created'}, {t: ''}], recRows, 'Add the clients to merge below.')}
    <div style="margin:10px 0 4px"><input id="cmSearch" type="text" placeholder="Add a client: name, client ID, PAN or mobile" value="${esc(st.q)}"
      oninput="cmState.q=this.value; renderClientMerge()" style="width:100%;max-width:460px;border:1px solid var(--line);border-radius:6px;padding:7px 10px"></div>
    ${hits.length ? `<div class="small-note" style="margin:4px 0">${st.q ? 'Matches' : 'Likely the same person'}:</div>` + hits.map(h=>`<div style="display:flex;gap:8px;align-items:center;margin:3px 0">
        <button class="btn sm" onclick="cmAdd('${h.c.id}')">+ Add</button><span><b>${esc(h.c.cmsName || '—')}</b> · ${esc(h.c.id)}${h.c.mobile ? ' · ' + esc(h.c.mobile) : ''}${h.why ? ` <span class="small-note" style="margin:0">(${esc(h.why)})</span>` : ''}</span></div>`).join('')
      : (st.q ? '<div class="small-note">No other client matches that.</div>' : '')}
    ${plan ? `
      <h4 style="margin:16px 0 6px">Where the records disagree</h4>
      ${conflictRows.length ? `<p class="small-note" style="margin-top:0">Pick the value the master should keep. The other value is not thrown away — it stays in the merge history.</p>`
        + repTable([{t: 'Field'}, {t: 'Keep'}], conflictRows)
        : '<p class="small-note">Nothing — wherever both records have a value, it is the same value.</p>'}
      ${plan.filled.length ? `<h4 style="margin:16px 0 6px">Filled in on the master</h4><p class="small-note" style="margin-top:0">${plan.filled.map(f=>esc(f.label) + (f.from === 'joined' ? ' (joined)' : '')).join(' · ')}</p>` : ''}
      <h4 style="margin:16px 0 6px">Moves to the master</h4>
      ${linked.length ? `<p class="small-note" style="margin-top:0">${linked.map(l=>`${esc(l.label)}: <b>${l.n}</b>`).join(' · ')}</p>`
        : '<p class="small-note" style="margin-top:0">No other records name the clients being merged.</p>'}
      ${repNote('info', 'From now on', `Imports and uploads that name ${aka.length ? '<b>' + aka.map(esc).join('</b>, <b>') + '</b>' : 'these clients'}${akaPans.length ? ' or carry PAN ' + akaPans.map(p=>esc(bossMaskSafe(p))).join(', ') : ''}
        land on <b>${esc(plan.out.cmsName || master.id)}</b> instead of creating them again, and anything that still carries an old client ID is pointed at ${esc(master.id)}.`)}` : ''}`;
  const foot = `<button class="btn ghost" onclick="closeModal()">Cancel</button>
    <button class="btn primary" ${plan ? '' : 'disabled'} onclick="cmConfirm()">Merge ${recs.length >= 2 ? recs.length + ' clients' : ''}</button>`;
  openModal('Merge clients', body, foot, {wide: true});
  if(st.q){ const el = document.getElementById('cmSearch'); if(el){ el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch(e){} } }
}
async function cmConfirm(){
  const st = cmState;
  if(!st) return;
  const recs = st.ids.map(id=>cmLiveClients().find(c=>c.id === id)).filter(Boolean);
  const master = recs.find(c=>c.id === st.masterId);
  if(!master || recs.length < 2) return;
  const gone = recs.filter(c=>c.id !== st.masterId);
  if(!confirm('Merge ' + gone.map(c=>(c.cmsName || '') + ' (' + c.id + ')').join(', ') + ' into ' + (master.cmsName || '') + ' (' + master.id + ')?\n\n'
    + 'Their records move to ' + master.id + ' and they are removed from the client list. A full copy of each is kept in the merge history.')) return;
  try {
    const r = await cmMerge(st.masterId, st.ids, st.choices);
    cmState = null;
    if(typeof bulkSelection !== 'undefined' && bulkSelection.CMS) bulkSelection.CMS.clear();
    closeModal();
    const moved = r.linked.reduce((s, l)=>s + l.n, 0);
    if(typeof toast === 'function') toast(gone.length + ' client' + (gone.length === 1 ? '' : 's') + ' merged into ' + (r.plan.out.cmsName || master.id) + (moved ? '; ' + moved + ' linked record' + (moved === 1 ? '' : 's') + ' moved' : ''));
    navigate('cms', st.masterId);
  } catch(e){
    console.error('client merge', e);
    alert('The merge did not finish: ' + (e && e.message || e) + '\n\nThe merge history holds a copy of every record as it was before.');
  }
}

/* ---- the duplicates list and the merge history -------------------- */
let cmDupTab = 'dups', cmDupShown = 30;
/* Worked out once when the list opens (it reads the whole book), then only
   filtered while somebody types; a merge or a dismissal works it out again. */
let cmDupCache = null;
const cmDupFilter = {branch: '', rm: '', q: ''};
function openClientDuplicates(tab){
  if(!cmCanMerge()){ alert('Finding and merging duplicate clients needs Edit and Delete permission on CMS.'); return; }
  cmDupTab = tab || cmDupTab || 'dups';
  cmDupCache = null;
  renderClientDuplicates();
}
function cmDupGroups(){
  if(!cmDupCache) cmDupCache = {groups: cmFindGroups(), copies: cmSameIdCopies()};
  return cmDupCache;
}
function cmDupMatches(c){
  const f = cmDupFilter;
  if(f.branch && (c.branch || '') !== f.branch) return false;
  if(f.rm && (c.rmName || '') !== f.rm) return false;
  const q = String(f.q || '').trim().toLowerCase();
  if(!q) return true;
  const digits = q.replace(/\D/g, '');
  return [c.cmsName, c.id, c.pan, c.email, c.uccNo].some(v=>String(v || '').toLowerCase().indexOf(q) >= 0)
    || (digits.length >= 4 && String(c.mobile || '').replace(/\D/g, '').indexOf(digits) >= 0);
}
function cmDupFiltersHtml(){
  const live = cmLiveClients();
  const branches = Array.from(new Set(live.map(c=>c.branch).filter(Boolean))).sort();
  const rms = Array.from(new Set(live.map(c=>c.rmName).filter(Boolean))).map(id=>({id, name: teamName(id)})).sort((a, b)=>a.name.localeCompare(b.name));
  const sel = (id, cur, opts, all) => `<select id="${id}" onchange="cmDupFilter.${id === 'cmDupBranch' ? 'branch' : 'rm'}=this.value; cmDupShown=30; renderClientDuplicates()"
      style="border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12.5px">
      <option value="">${all}</option>${opts.map(o=>`<option value="${esc(o.v)}" ${o.v === cur ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}</select>`;
  return `<div class="row" style="gap:8px;flex-wrap:wrap;margin:0 0 10px">
    ${sel('cmDupBranch', cmDupFilter.branch, branches.map(b=>({v: b, l: b})), 'All branches')}
    ${sel('cmDupRm', cmDupFilter.rm, rms.map(r=>({v: r.id, l: r.name})), 'All RMs')}
    <input id="cmDupQ" type="text" value="${esc(cmDupFilter.q)}" placeholder="Client: name, ID, PAN or mobile"
      oninput="cmDupFilter.q=this.value; cmDupShown=30; renderClientDuplicates()"
      style="flex:1;min-width:200px;border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12.5px">
    ${cmDupFilter.branch || cmDupFilter.rm || cmDupFilter.q ? `<button class="btn sm ghost" onclick="cmDupFilter.branch='';cmDupFilter.rm='';cmDupFilter.q='';renderClientDuplicates()">Clear filters</button>` : ''}
  </div>`;
}
/* The same client record stored twice under one id — every field equal or
   nearly so. Not two people: one record, written twice. */
function cmSameIdCopies(){
  const byId = new Map();
  (DB.clients || []).forEach(c=>{ if(c && c.id && !c.deletedAt){ if(!byId.has(c.id)) byId.set(c.id, []); byId.get(c.id).push(c); } });
  return Array.from(byId.values()).filter(l=>l.length > 1);
}
/* Keep the first copy of each, fill in from the others whatever only they
   have, and keep the extra copies whole in the merge history. */
async function cmTidyCopies(){
  if(!cmCanMerge()){ alert('Tidying client records needs Edit and Delete permission on CMS.'); return; }
  const sets = cmSameIdCopies();
  if(!sets.length) return;
  const extra = sets.reduce((n, l)=>n + l.length - 1, 0);
  if(!confirm(sets.length + ' client record' + (sets.length === 1 ? ' is' : 's are') + ' stored more than once under the same ID (' + extra + ' extra cop' + (extra === 1 ? 'y' : 'ies') + ').\n\n'
    + 'Keep one of each, fill in anything only the other copy has, and remove the extra copies? Each removed copy is kept whole in the merge history.')) return;
  const at = new Date().toISOString();
  const keep = new Map();
  sets.forEach(l=>{
    let out = cmCopy(l[0]);
    l.slice(1).forEach(o=>{ out = cmFillObject(out, o); });
    keep.set(l[0].id, {out, extras: l.slice(1).map(cmCopy)});
  });
  const seen = new Set();
  if(typeof autoSuspend === 'function') autoSuspend();
  if(typeof auditSuspend === 'function') auditSuspend();
  try {
    DB[CM_LOG_KEY] = cmLog().concat(Array.from(keep.entries()).map(([id, k])=>({id: uid('MRG'), kind: 'sameIdTidy', at, by: currentUser,
      masterId: id, masterName: k.out.cmsName || '', records: k.extras})));
    if(await save(CM_LOG_KEY) === false) throw new Error('The record of it could not be saved, so nothing was changed.');
    DB.clients = (DB.clients || []).filter(c=>{
      if(!c || !keep.has(c.id) || c.deletedAt) return true;
      if(seen.has(c.id)) return false;
      seen.add(c.id); return true;
    }).map(c=>(c && keep.has(c.id) && !c.deletedAt) ? keep.get(c.id).out : c);
    await save('clients');
    for(const [id, k] of keep) await logAudit('CMS', id, 'Duplicate Copy Removed', [{field: 'Copies of this record', oldValue: String(k.extras.length + 1), newValue: '1'}]);
  } finally {
    if(typeof auditSuspend === 'function') await auditResume();
    if(typeof autoResume === 'function') autoResume();
  }
  cmDupCache = null;
  renderClientDuplicates();
}
function renderClientDuplicates(){
  const tabs = `<div class="row" style="gap:6px;margin-bottom:10px">
    <button class="btn sm ${cmDupTab === 'dups' ? 'primary' : ''}" onclick="cmDupTab='dups'; renderClientDuplicates()">Possible duplicates</button>
    <button class="btn sm ${cmDupTab === 'history' ? 'primary' : ''}" onclick="cmDupTab='history'; renderClientDuplicates()">Merge history</button></div>`;
  let body;
  if(cmDupTab === 'history'){
    const rows = cmLog().filter(e=>e && e.kind === 'merge').slice().reverse().map(e=>`<tr>
      <td>${fmtDate(e.at)}</td>
      <td>${cmLiveClients().some(c=>c.id === e.masterId) ? `<a href="javascript:void(0)" class="cell-link" onclick="closeModal(); navigate('cms','${e.masterId}')">${esc(e.masterName || e.masterId)}</a>` : esc(e.masterName || e.masterId)}
        <div class="small-note" style="margin:2px 0 0">${esc(e.masterId)}</div></td>
      <td>${(e.mergedIds || []).map((id, i)=>esc((e.mergedNames || [])[i] || '') + ` <span class="small-note" style="margin:0">${esc(id)}</span>`).join('<br>')}</td>
      <td>${Object.values(e.moved || {}).reduce((s, n)=>s + n, 0)}</td>
      <td>${esc(teamName(e.by))}</td></tr>`);
    body = tabs + repTable([{t: 'Date'}, {t: 'Master client'}, {t: 'Merged into it (original IDs)'}, {t: 'Records moved'}, {t: 'Merged by'}], rows, 'No clients have been merged yet.');
  } else {
    const all = cmDupGroups();
    const byId = new Map(cmLiveClients().map(c=>[c.id, c]));
    const filtering = !!(cmDupFilter.branch || cmDupFilter.rm || String(cmDupFilter.q).trim());
    const groups = all.groups.filter(g=>!filtering || g.ids.some(id=>byId.has(id) && cmDupMatches(byId.get(id))));
    const copies = all.copies.filter(l=>!filtering || cmDupMatches(l[0]));
    const cards = groups.slice(0, cmDupShown).map(g=>{
      const recs = g.ids.map(id=>byId.get(id)).filter(Boolean);
      const level = g.score >= 100 ? '<span class="badge danger">Very likely</span>' : '<span class="badge warn">Possible</span>';
      return `<div class="card" style="padding:10px 12px;margin-bottom:10px">
        <div class="between" style="margin-bottom:6px"><div>${level} <span class="small-note" style="margin:0">${g.reasons.map(esc).join(' · ')}</span></div>
          <div class="row" style="gap:6px"><button class="btn sm" onclick="cmDismiss('${g.ids.join(',')}')">Not the same person</button>
          <button class="btn sm primary" onclick="openClientMerge('${g.ids.join(',')}'.split(','))">Review &amp; merge</button></div></div>
        ${repTable([{t: 'Client'}, {t: 'PAN'}, {t: 'Mobile'}, {t: 'Email'}, {t: 'RM'}, {t: 'Branch'}, {t: 'Created'}],
          recs.map(c=>'<tr>' + cmRecordCells(c).map(x=>`<td>${x}</td>`).join('') + '</tr>'))}</div>`;
    });
    const copiesNote = copies.length ? repNote('warn', copies.length + ' client record' + (copies.length === 1 ? '' : 's') + ' stored twice under the same ID',
        'These are not two people: the same record was saved more than once, so every field matches. '
        + copies.slice(0, 8).map(l=>'<b>' + esc(l[0].cmsName || l[0].id) + '</b> (' + esc(l[0].id) + ', ' + l.length + ' copies)').join(', ')
        + (copies.length > 8 ? ' and ' + (copies.length - 8) + ' more' : '') + '.'
        + `<div style="margin-top:8px"><button class="btn sm primary" onclick="cmTidyCopies()">Tidy up — keep one copy of each</button></div>`) : '';
    body = tabs + `<p class="small-note" style="margin-top:0">Clients that look like the same person, worked out from name, PAN, mobile, email and date of birth.
        A missing field counts neither way; a middle name more or less, an initial or a one-letter spelling difference still matches. Two different PANs are never the same person.</p>`
      + cmDupFiltersHtml() + copiesNote
      + (groups.length ? `<p><b>${groups.length}</b> group${groups.length === 1 ? '' : 's'} to review${filtering ? ' with these filters (of ' + all.groups.length + ')' : ''}.</p>` + cards.join('')
        + (groups.length > cmDupShown ? `<button class="btn" onclick="cmDupShown+=30; renderClientDuplicates()">Show more</button>` : '')
        : `<div class="empty">${filtering ? 'No likely duplicates match these filters.' : 'No likely duplicates in the client book.'}</div>`);
  }
  openModal('Duplicate clients', body, `<button class="btn ghost" onclick="closeModal()">Close</button>`, {wide: true});
}
async function cmDismiss(idList){
  await cmNotDuplicates(String(idList).split(','));
  cmDupCache = null;
  renderClientDuplicates();
}
/* On the client's own page: who this client is also known as. */
function cmMergedFromHtml(c){
  const m = (c && c.mergedFrom) || [];
  if(!m.length) return '';
  return `<div class="small-note" style="margin:8px 0 0">Merged from ${m.map(x=>`<b>${esc(x.name || x.id)}</b> (${esc(x.id)}${x.at ? ', ' + fmtDate(x.at) : ''})`).join(', ')}.
    Imports under ${m.length === 1 ? 'that name' : 'those names'} land on this client.</div>`;
}
