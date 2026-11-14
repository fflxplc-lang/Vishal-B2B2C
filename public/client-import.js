/* =====================================================================
   CLIENT-WISE IMPORT — FROM THE CLIENT'S OWN PORTFOLIO TAB (changes 14-11-2026)

   Beside + Add investment: pick the platform (the same platform list as
   Setup › Platform Import Mapping), upload the client's investment report
   (Excel or PDF), and see what was read before anything is saved.

     Select platform → upload → read → map the client → preview & correct
     → confirm → the rest of BOSS follows.

   Nothing here is a second importer. The file is read by the same reader
   the Platform Import Mapping upload uses (maReadFile: every known platform
   layout, then the column synonyms, PDF through pdf.js), saved the same way
   (maCreateUpload: a new version for this client + platform + category,
   nothing earlier overwritten), compared the same way (icRecord) and
   written through to the stores every screen reads (maSyncCrm →
   platformHoldings / platformSips: the client's Portfolio, CMS, RMS and its
   review report, the dashboards, MIS and the reports).

   What this adds is what an upload for one client needs:
     · the client is checked, not assumed — the report's PAN, client ID,
       mobile or name has to point at this client, or somebody says which
       client it is before anything is imported;
     · a preview where every row can be corrected or left out;
     · each row compared with what this client already holds on that
       platform: new, updated (old → new), already on file (left out),
       entered by hand (left out unless ticked — a hand correction is not
       overwritten without somebody choosing to), twice in the file, or
       somebody else's;
     · the same file twice is refused;
     · a history on the client's page, and a report of what was imported,
       what was not and why, and what BOSS holds that the report did not
       mention.
   ===================================================================== */

let cwi = null;
const CWI_TITLE = 'Client-Wise Import';
const CWI_HOLD_COLS = [['security_name', 'Scheme / product', 't'], ['asset_class', 'Asset class', 't'], ['identifier', 'Folio / account', 't'],
  ['isin', 'ISIN', 't'], ['quantity', 'Units', 'n'], ['current_price', 'NAV / price', 'n'], ['invested', 'Invested', 'n'],
  ['current_value', 'Current value', 'n'], ['start_date', 'Invested on', 't']];
const CWI_SIP_COLS = [['security_name', 'Scheme', 't'], ['identifier', 'Folio / account', 't'], ['isin', 'ISIN', 't'],
  ['sip_amount', 'SIP amount', 'n'], ['frequency', 'Frequency', 't'], ['sip_day', 'SIP day', 't'], ['start_date', 'Start', 't'],
  ['end_date', 'End', 't'], ['status', 'Status', 't']];
const CWI_STATUS = {
  'new': ['ok', 'New'], changed: ['info', 'Updates'], same: ['muted', 'Already on file'], manual: ['warn', 'Entered by hand'],
  dup: ['muted', 'Twice in file'], other: ['muted', 'Another client'], invalid: ['danger', 'Incomplete']};

function cwiButton(clientId){
  if(typeof maCanUpload !== 'function' || !maCanUpload()) return '';
  return `<button class="btn sm" id="cwiOpenBtn" onclick="cwiOpen('${esc(clientId)}')"
    title="Upload this client's investment report (Excel or PDF) for one platform — see what was read before it is saved">⬆ Client-Wise Import</button>`;
}
function cwiCols(){ return cwi && cwi.kind === 'sip' ? CWI_SIP_COLS : CWI_HOLD_COLS; }
function cwiPlatform(){ return maPlatforms().find(p=>p.id === (cwi && cwi.platformId)) || null; }
function cwiClient(id){ return (DB.clients || []).find(c=>c && c.id === id && !c.deletedAt) || null; }
function cwiDigits(v){ return String(v == null ? '' : v).replace(/\D/g, '').slice(-10); }
function cwiNum(v){
  if(v === null || v === undefined || v === '') return null;
  if(typeof v === 'number') return isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return isFinite(n) ? n : null;
}

function cwiOpen(clientId){
  if(!maCanUpload()){ alert('You do not have permission to change portfolio data.'); return; }
  const c = cwiClient(clientId);
  if(!c){ alert('That client is no longer on file.'); return; }
  const plats = maPlatforms();
  cwi = {clientId, targetId: clientId, step: 'pick', platformId: (cwi && cwi.clientId === clientId && cwi.platformId) || (plats[0] || {}).id || '',
    kind: 'aum', snap: '', file: null, read: null, rows: [], groups: [], confirm: false, busy: false, err: ''};
  cwiDraw();
}
function cwiDraw(){
  if(!cwi) return;
  const c = cwiClient(cwi.clientId);
  const body = cwi.step === 'pick' ? cwiPickHtml(c) : cwi.step === 'preview' ? cwiPreviewHtml() : cwiDoneHtml();
  const foot = cwi.step === 'pick'
    ? `<button class="btn" onclick="cwiClose()">Cancel</button>
       <button class="btn primary" id="cwiReadBtn" onclick="cwiRead()" ${cwi.busy ? 'disabled' : ''}>${cwi.busy ? 'Reading…' : 'Read the file'}</button>`
    : cwi.step === 'preview'
    ? `<button class="btn" onclick="cwi.step='pick'; cwi.err=''; cwiDraw()" ${cwi.busy ? 'disabled' : ''}>← Back</button>
       <button class="btn primary" id="cwiImportBtn" onclick="cwiImport()" ${cwi.busy || !cwiCanImport().ok ? 'disabled' : ''}>${cwi.busy ? 'Importing…' : 'Confirm import (' + cwiPicked().length + ')'}</button>`
    : `<button class="btn" onclick="cwiReport(cwi.historyId)">⬇ Download report</button>
       <button class="btn primary" onclick="cwiClose()">Done</button>`;
  openModal(CWI_TITLE, body, foot, {wide: true});
}
function cwiClose(){ const was = cwi && cwi.step === 'done'; cwi = null; closeModal(); if(was) render(); }

/* ---- 1. platform, kind, file ---------------------------------------- */
function cwiPickHtml(c){
  const plats = maPlatforms();
  const byProd = MA_PRODUCTS.map(p=>[p, plats.filter(x=>x.product === p)]).filter(([, l])=>l.length);
  return `
    <div class="small-note" style="margin-top:0">For <b>${esc(c ? c.cmsName : '')}</b>${c && c.pan ? ' · PAN ' + esc(c.pan) : ''}.
      Choose the platform the report is from, then the file. Nothing is saved until you have seen what was read and confirmed it.</div>
    <div class="form-grid" style="margin-top:10px">
      <div class="field"><label>Platform <span class="req">*</span></label>
        <select id="cwiPlatform" onchange="cwi.platformId=this.value">${byProd.map(([p, l])=>`<optgroup label="${esc(MA_PRODUCT_LABEL[p] || p)}">${
          l.map(x=>`<option value="${esc(x.id)}" ${x.id === cwi.platformId ? 'selected' : ''}>${esc(x.name)} — ${esc(x.product)}</option>`).join('')}</optgroup>`).join('')}</select>
        <div class="small-note" style="margin:4px 0 0">The platforms of Setup › Platform Import Mapping. A new one is added there.</div></div>
      <div class="field"><label>Report <span class="req">*</span></label>
        <select id="cwiKind" onchange="cwi.kind=this.value">
          <option value="aum" ${cwi.kind === 'aum' ? 'selected' : ''}>Holdings / current investments (AUM)</option>
          <option value="sip" ${cwi.kind === 'sip' ? 'selected' : ''}>SIP registrations</option></select></div>
      <div class="field"><label>File (Excel or PDF) <span class="req">*</span></label>
        <input type="file" id="cwiFile" accept=".xlsx,.xls,.csv,.pdf" onchange="cwi.file=this.files[0]||null; cwi.err=''">
        ${cwi.file ? `<div class="small-note" style="margin:4px 0 0">Chosen: ${esc(cwi.file.name)}</div>` : ''}</div>
      <div class="field"><label>Data as of <span class="small-note">(optional)</span></label>
        <input type="date" id="cwiSnap" value="${esc(cwi.snap)}" onchange="cwi.snap=this.value">
        <div class="small-note" style="margin:4px 0 0">Blank: the date in the file, or today.</div></div>
      <div class="field"><label>File password <span class="small-note">(locked files only)</span></label>
        <input type="password" id="cwiPassword" autocomplete="off" placeholder="Optional">
        <div class="small-note" style="margin:4px 0 0">Used to open the file in this browser; never sent or stored.</div></div>
    </div>
    ${cwi.err ? `<div class="fx-note warn" id="cwiErr" style="margin-top:10px">${esc(cwi.err)}</div>` : ''}`;
}

async function cwiRead(){
  if(!cwi || cwi.busy) return;
  const sel = id => document.getElementById(id);
  if(sel('cwiPlatform')) cwi.platformId = sel('cwiPlatform').value;
  if(sel('cwiKind')) cwi.kind = sel('cwiKind').value;
  if(sel('cwiFile') && sel('cwiFile').files && sel('cwiFile').files[0]) cwi.file = sel('cwiFile').files[0];
  const password = (sel('cwiPassword') || {}).value || '';
  const p = cwiPlatform();
  if(!p){ cwi.err = 'Choose the platform the report is from.'; cwiDraw(); return; }
  if(!cwi.file){ cwi.err = 'Choose the client’s report (Excel or PDF).'; cwiDraw(); return; }
  cwi.busy = true; cwi.err = ''; cwiDraw();
  try {
    const r = await maReadFile(cwi.file, cwi.kind, password, false);
    if(r.layout === 'nj_group' || r.layout === 'branch_summary') throw new Error((r.notes || []).join('; ') || 'This is a summary report, not one client’s investments.');
    if(r.detailsOnly) throw new Error('This file carries client details only, not investments. Upload it from Setup › Platform Import Mapping to fill in client records.');
    if(!r.rows.length) throw new Error((r.notes || []).join('; ') || 'Nothing could be read from this file.');
    r.rows.forEach(h=>{ if(h.security_name === MA_UNNAMED_HOLDING) h.security_name = p.name + ' ' + (p.product === 'MF' ? 'Mutual Funds' : p.product); });
    cwi.read = r;
    cwi.sha = await maSha256(r.buffer);
    cwiMap();
    cwi.step = 'preview';
  } catch(e){
    cwi.err = (e && e.message) || String(e);
  } finally {
    cwi.busy = false;
    cwiDraw();
  }
}

/* ---- 2. which client the report is for ------------------------------ */
function cwiMap(){
  const c = cwiClient(cwi.clientId);
  const rows = cwi.read.rows;
  const groups = new Map();
  rows.forEach((h, i)=>{
    const pan = maPanOf(h.pan) || maPanOf(h.client_id);
    const name = maTidy(h.client_name);
    const k = pan ? 'p:' + pan : name ? 'n:' + maKey(name) : h.client_id ? 'i:' + maKey(h.client_id) : 'x:';
    if(!groups.has(k)) groups.set(k, {key: k, pan: pan || '', name, clientIds: new Set(), mobiles: new Set(), rows: []});
    const g = groups.get(k);
    g.rows.push(i);
    if(!g.name && name) g.name = name;
    if(h.client_id && !maPanOf(h.client_id)) g.clientIds.add(String(h.client_id).trim());
    const mob = cwiDigits((h.cd && h.cd.mobile) || h.mobile);
    if(mob.length === 10) g.mobiles.add(mob);
  });
  const myNames = new Set([c.cmsName].concat(typeof cmNamesOf === 'function' ? cmNamesOf(c) : []).map(maKey).filter(Boolean));
  const myIds = new Set([c.id, c.uccNo, c.canIinNo, c.platformClientCode].filter(Boolean).map(x=>maKey(x)));
  const myMob = new Set([c.mobile, c.secondMobile].map(cwiDigits).filter(x=>x.length === 10));
  const myPan = maPanOf(c.pan);
  const live = (DB.clients || []).filter(x=>x && !x.deletedAt);
  const idx = typeof impClientIndex === 'function' ? impClientIndex(live) : null;
  cwi.groups = Array.from(groups.values()).map(g=>{
    let how = '', conflict = '';
    if(g.pan && myPan && g.pan === myPan) how = 'PAN ' + g.pan;
    else if(Array.from(g.clientIds).some(x=>myIds.has(maKey(x)))) how = 'client ID';
    else if(Array.from(g.mobiles).some(x=>myMob.has(x))) how = 'mobile number';
    else if(g.name && myNames.has(maKey(g.name))) how = 'name';
    if(how === 'name' && g.pan && myPan && g.pan !== myPan) { conflict = 'the report’s PAN ' + g.pan + ' is not this client’s (' + myPan + ')'; how = ''; }
    let other = null;
    if(idx && typeof impMatchClient === 'function'){
      const m = impMatchClient({pan: g.pan, name: g.name, mobile: Array.from(g.mobiles)[0] || ''}, live, idx);
      if(m.clientId && m.clientId !== c.id) other = m.client || cwiClient(m.clientId);
    }
    return {key: g.key, pan: g.pan, name: g.name || (g.pan ? '' : '(no name in the file)'), rows: g.rows, how, conflict, other,
      label: (g.name || 'Unnamed') + (g.pan ? ' · ' + g.pan : '') + ' — ' + g.rows.length + ' row' + (g.rows.length === 1 ? '' : 's')};
  });
  const sure = cwi.groups.filter(g=>g.how && !(g.other && g.how === 'name'));
  cwi.useGroups = new Set(sure.map(g=>g.key));
  cwi.targetId = c.id;
  cwi.confirm = false;
  cwi.needsChoice = !sure.length;
  if(cwi.needsChoice){
    /* Nothing in the report points at this client. One person in it: that
       person, once somebody confirms which client it is. Several: they say which. */
    if(cwi.groups.length === 1){
      cwi.useGroups = new Set([cwi.groups[0].key]);
      if(cwi.groups[0].other) cwi.targetId = '';   // another client fits better: nobody is assumed
    } else cwi.useGroups = new Set();
  }
  cwi.rows = rows.map((h, i)=>({i, h, v: Object.assign({}, h), sel: true, edited: false}));
  cwiClassify(true);
}
function cwiMappingHtml(){
  const c = cwiClient(cwi.clientId), t = cwiClient(cwi.targetId);
  const sure = cwi.groups.filter(g=>cwi.useGroups.has(g.key) && g.how);
  const others = cwi.groups.filter(g=>!cwi.useGroups.has(g.key));
  if(!cwi.needsChoice){
    return `<div class="fx-note ok" id="cwiMapNote" style="margin:0 0 10px">✓ The report is for <b>${esc(c.cmsName)}</b> — matched by ${esc(sure.map(g=>g.how).filter((v, i, a)=>a.indexOf(v) === i).join(', '))}.${
      others.length ? ' It also holds ' + others.length + ' other investor' + (others.length === 1 ? '' : 's') + ' (' + esc(others.map(g=>g.name || g.pan).join(', ')) + '); their rows are not imported here.' : ''}</div>`;
  }
  const candidates = [c].concat(cwi.groups.map(g=>g.other).filter(Boolean)).filter((x, i, a)=>x && a.findIndex(y=>y.id === x.id) === i);
  return `<div class="fx-note warn" id="cwiMapNote" style="margin:0 0 10px">
    <b>Which client is this report for?</b> Nothing in it — PAN, client ID, mobile or name — points clearly at ${esc(c.cmsName)}.
    ${cwi.groups.filter(g=>g.conflict).map(g=>'<div>' + esc(g.name) + ': ' + esc(g.conflict) + '.</div>').join('')}
    ${cwi.groups.filter(g=>g.other).map(g=>'<div>' + esc(g.name || g.pan) + ' matches another client: <b>' + esc(g.other.cmsName) + '</b> (' + esc(clientCode(g.other)) + ').</div>').join('')}
    <div class="form-grid" style="margin-top:8px">
      ${cwi.groups.length > 1 ? `<div class="field"><label>Investor in the report</label>
        <select id="cwiGroup" onchange="cwiPickGroup(this.value)"><option value="">— choose —</option>${cwi.groups.map(g=>`<option value="${esc(g.key)}" ${cwi.useGroups.has(g.key) ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Import it to</label>
        <select id="cwiTarget" onchange="cwiPickTarget(this.value)"><option value="">— choose the client —</option>${candidates.map(x=>`<option value="${esc(x.id)}" ${x.id === cwi.targetId ? 'selected' : ''}>${esc(x.cmsName)} (${esc(clientCode(x))})${x.id === c.id ? ' — this client' : ''}</option>`).join('')}</select></div>
    </div>
    <label class="row" style="gap:6px;margin-top:6px"><input type="checkbox" id="cwiConfirm" ${cwi.confirm ? 'checked' : ''} onchange="cwi.confirm=this.checked; cwiDraw()">
      I have checked the report: it is ${t ? '<b>' + esc(t.cmsName) + '</b>’s' : 'the chosen client’s'} investments.</label>
  </div>`;
}
function cwiPickGroup(k){ cwi.useGroups = new Set(k ? [k] : []); cwi.confirm = false; cwiClassify(true); cwiDraw(); }
function cwiPickTarget(id){ cwi.targetId = id; cwi.confirm = false; cwiClassify(true); cwiDraw(); }

/* ---- 3. each row against what the client already holds -------------- */
function cwiExisting(){
  const p = cwiPlatform(), t = cwiClient(cwi.targetId);
  if(!p || !t) return [];
  maInvalidate();
  const st = maState();
  return (cwi.kind === 'sip' ? st.sips : st.holdings).filter(r=>r._c.ck === 'c:' + t.id && r.product === p.product
    && (p.product === 'MF' || r.platform_key === maKey(p.name)));
}
function cwiIdentity(v){
  const p = cwiPlatform();
  return maHoldingIdentity({product: p.product, platform: p.name, identifier: v.identifier, isin: v.isin, security_name: v.security_name});
}
function cwiClassify(resetSelection){
  const existing = cwiExisting();
  const byId = new Map(existing.map(r=>[maHoldingIdentity(r), r]));
  const seen = new Set();
  const money = cwi.kind === 'sip' ? ['sip_amount'] : ['current_value', 'invested', 'quantity', 'current_price'];
  cwi.rows.forEach(row=>{
    const v = row.v, g = cwi.groups.find(x=>x.rows.includes(row.i));
    let status, note = '';
    const value = cwi.kind === 'sip' ? cwiNum(v.sip_amount) : cwiNum(v.current_value);
    if(!g || !cwi.useGroups.has(g.key)){ status = 'other'; note = g && (g.name || g.pan) ? 'belongs to ' + (g.name || g.pan) : 'not this client’s'; }
    else if(!maTidy(v.security_name)){ status = 'invalid'; note = 'no scheme or product name'; }
    else if(v.level !== 'details' && value === null && cwiNum(v.invested) === null && cwiNum(v.quantity) === null){ status = 'invalid'; note = cwi.kind === 'sip' ? 'no SIP amount' : 'no value, amount or units'; }
    else {
      const id = cwiIdentity(v);
      if(seen.has(id)){ status = 'dup'; note = 'the same investment appears earlier in the file'; }
      else {
        seen.add(id);
        const old = byId.get(id);
        if(!old) status = 'new';
        else {
          const diffs = money.concat(cwi.kind === 'sip' ? ['status', 'frequency'] : ['asset_class']).filter(f=>{
            const a = money.includes(f) ? cwiNum(old[f]) : maTidy(old[f]), b = money.includes(f) ? cwiNum(v[f]) : maTidy(v[f]);
            if(b === null || b === '') return false;
            return money.includes(f) ? (a === null || Math.abs(a - b) > 0.005) : maKey(a) !== maKey(b);
          });
          if(old._u && old._u.manual){ status = 'manual'; note = 'entered by hand on ' + fmtDate(old._u.at) + (diffs.length ? ' — the report differs' : ''); }
          else if(!diffs.length){ status = 'same'; note = 'already on file (v' + (old._u ? old._u.version : '') + ')'; }
          else { status = 'changed'; note = diffs.map(f=>f.replace(/_/g, ' ') + ' ' + (cwiFmt(old[f]) || '—') + ' → ' + cwiFmt(v[f])).join('; '); }
        }
      }
    }
    row.status = status; row.note = note;
    if(resetSelection || status === 'other' || status === 'invalid' || status === 'dup') row.sel = status === 'new' || status === 'changed';
  });
  const inFile = new Set(cwi.rows.filter(r=>r.status !== 'other' && r.status !== 'invalid').map(r=>cwiIdentity(r.v)));
  cwi.missing = existing.filter(r=>!inFile.has(maHoldingIdentity(r)));
  const p = cwiPlatform(), t = cwiClient(cwi.targetId);
  cwi.dupFile = (p && t) ? maUploads().find(u=>u.sha256 === cwi.sha && u.uploadType === 'client' && maKey(u.clientName) === maKey(t.cmsName)
    && maKey(u.platform) === maKey(p.name) && u.product === p.product && u.kind === cwi.kind) || null : null;
}
function cwiFmt(v){ const n = cwiNum(v); return n !== null && typeof v !== 'boolean' && String(v).trim() !== '' && /^[\d₹,.\s()-]+$/.test(String(v)) ? n.toLocaleString('en-IN', {maximumFractionDigits: 4}) : maTidy(v); }
function cwiPicked(){ return (cwi && cwi.rows || []).filter(r=>r.sel && !['other', 'invalid', 'dup'].includes(r.status)); }
function cwiCanImport(){
  if(!cwi || !cwi.rows.length) return {ok: false, why: 'Nothing was read.'};
  if(!cwiClient(cwi.targetId)) return {ok: false, why: 'Choose the client the report is for.'};
  if(cwi.needsChoice && (!cwi.useGroups.size || !cwi.confirm)) return {ok: false, why: 'Confirm which client the report is for.'};
  if(cwi.dupFile) return {ok: false, why: 'This exact file was already imported for this client.'};
  if(!cwiPicked().length) return {ok: false, why: 'No row is ticked for import.'};
  return {ok: true};
}
function cwiEdit(i, f, val){
  const row = cwi.rows.find(r=>r.i === i); if(!row) return;
  const col = cwiCols().find(c=>c[0] === f);
  row.v[f] = col && col[2] === 'n' ? cwiNum(val) : maTidy(val);
  row.edited = true;
  cwiClassify(false);
  cwiDraw();
}
function cwiToggle(i, on){ const row = cwi.rows.find(r=>r.i === i); if(row) row.sel = !!on; cwiDraw(); }
function cwiToggleAll(on){ cwi.rows.forEach(r=>{ if(!['other', 'invalid', 'dup'].includes(r.status)) r.sel = !!on; }); cwiDraw(); }

function cwiPreviewHtml(){
  const p = cwiPlatform(), r = cwi.read, cols = cwiCols();
  const count = s => cwi.rows.filter(x=>x.status === s).length;
  const can = cwiCanImport();
  const sum = cwi.kind === 'sip' ? cwiPicked().reduce((n, x)=>n + (cwiNum(x.v.sip_amount) || 0), 0)
    : cwiPicked().reduce((n, x)=>n + (cwiNum(x.v.current_value) || 0), 0);
  return `
    <div class="small-note" style="margin-top:0">${esc(cwi.file.name)} · ${esc(p.name)} — ${esc(p.product)} · ${cwi.kind === 'sip' ? 'SIP registrations' : 'holdings'} ·
      ${r.rows.length} row${r.rows.length === 1 ? '' : 's'} read${r.layout ? ' (read as a known ' + esc(p.name) + ' layout)' : ''}${(r.notes || []).length ? ' · ' + esc(r.notes.join('; ')) : ''}</div>
    ${cwiMappingHtml()}
    ${cwi.dupFile ? `<div class="fx-note warn" id="cwiDupFile" style="margin:0 0 10px">This exact file was already imported for this client on ${esc(fmtDate(cwi.dupFile.at))}
      (version ${cwi.dupFile.version}). Importing it again would add nothing.</div>` : ''}
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:8px" id="cwiCounts">${Object.keys(CWI_STATUS).filter(s=>count(s)).map(s=>
      `<span class="badge ${CWI_STATUS[s][0]}">${CWI_STATUS[s][1]}: ${count(s)}</span>`).join('')}
      ${cwi.missing.length ? `<span class="badge muted" title="Held for this client on this platform, and not in the report. They stay as they are.">On file, not in report: ${cwi.missing.length}</span>` : ''}</div>
    <div class="small-note" style="margin:0 0 6px">Correct anything that was read wrongly, untick what should not be imported. <b>Already on file</b> and
      <b>entered by hand</b> rows are left out unless ticked — ticking a hand-entered one replaces it with the report's figures.</div>
    <div class="table-wrap" style="max-height:46vh;overflow:auto"><table class="cwi-table" id="cwiTable">
      <thead><tr><th style="width:28px"><input type="checkbox" title="Tick all importable rows" onchange="cwiToggleAll(this.checked)"></th><th>Status</th>${cols.map(c=>`<th>${esc(c[1])}</th>`).join('')}<th>Note</th></tr></thead>
      <tbody>${cwi.rows.map(row=>{
        const locked = row.status === 'other' || row.status === 'dup' || row.status === 'invalid';
        const st = CWI_STATUS[row.status] || ['muted', row.status];
        return `<tr data-row="${row.i}" class="${row.sel ? '' : 'cwi-off'}">
          <td><input type="checkbox" ${row.sel ? 'checked' : ''} ${locked ? 'disabled' : ''} onchange="cwiToggle(${row.i}, this.checked)"></td>
          <td><span class="badge ${st[0]}">${esc(st[1])}</span>${row.edited ? ' <span class="small-note">edited</span>' : ''}</td>
          ${cols.map(c=>`<td><input class="cwi-in${c[2] === 'n' ? ' num' : ''}" id="cwi_${row.i}_${c[0]}" value="${esc(row.v[c[0]] === null || row.v[c[0]] === undefined ? '' : String(row.v[c[0]]))}"
            ${row.status === 'other' ? 'disabled' : ''} onchange="cwiEdit(${row.i}, '${c[0]}', this.value)"></td>`).join('')}
          <td class="small-note" style="min-width:160px">${esc(row.note || '')}</td></tr>`;
      }).join('')}</tbody></table></div>
    <div class="between" style="margin-top:8px">
      <span class="small-note" style="margin:0">${cwiPicked().length} row${cwiPicked().length === 1 ? '' : 's'} to import · ${cwi.kind === 'sip' ? 'SIP total ' : 'current value '}${money(sum)}</span>
      ${can.ok ? '' : `<span class="small-note" id="cwiWhyNot" style="margin:0;color:var(--warn)">${esc(can.why)}</span>`}</div>`;
}

/* ---- 4. import, and what happened ----------------------------------- */
async function cwiImport(){
  if(!cwi || cwi.busy) return;
  const can = cwiCanImport();
  if(!can.ok){ alert(can.why); return; }
  const p = cwiPlatform(), t = cwiClient(cwi.targetId);
  const picked = cwiPicked();
  cwi.busy = true; cwiDraw();
  const batchId = 'CWI-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    const rows = picked.map(x=>Object.assign({}, x.v, {client_name: t.cmsName, pan: maPanOf(t.pan) || x.v.pan || null, cid: t.id}));
    /* Blank details on the client's record are filled from the report;
       nothing filled in already is changed, and no client is created. */
    const cl = await maApplyClients(picked.map(x=>Object.assign({}, x.h, {client_name: t.cmsName})),
      {clientId: t.id, clientName: t.cmsName, create: false, overwrite: false, rm: '', platform: p.name, file: cwi.file.name});
    const edited = picked.filter(x=>x.edited).length, left = cwi.rows.length - picked.length;
    const notes = ['Client-Wise Import from the client’s page'].concat(edited ? [edited + ' row(s) corrected in the preview'] : [],
      left ? [left + ' row(s) not imported'] : [], cwi.read.notes || []);
    const created = await maCreateUpload({uploadType: 'client', clientName: t.cmsName, clientId: t.id, platform: p.name, product: p.product,
      kind: cwi.kind, batchId, snapshotDate: cwi.snap || null, file: cwi.file.name, fileType: cwi.file.type || '', format: cwi.read.format,
      size: cwi.file.size, sha256: cwi.sha, status: 'Processed', notes: notes.join('; '), rows, buffer: cwi.read.buffer});
    if(created.skipped) throw new Error(created.message);
    let compare = null;
    if(typeof icRecord === 'function'){
      try { compare = await icRecord({file: cwi.read.plainFile || cwi.file, kind: cwi.kind, platform: p.name, product: p.product,
        uploadType: 'client', clientName: t.cmsName, batchId}, cwi.read, created, 'ok', ''); } catch(e){ compare = null; }
    }
    await maSyncCrm({asOn: created.snapshotDate, batchId});
    const lines = cwi.rows.map(x=>({status: (CWI_STATUS[x.status] || [0, x.status])[1], imported: picked.includes(x) ? 'Yes' : 'No',
      reason: picked.includes(x) ? (x.status === 'manual' ? 'replaces the hand entry, as ticked' : '') : (x.sel ? '' : x.status === 'same' ? 'already on file' : x.status === 'manual' ? 'hand entry kept' : x.status === 'new' || x.status === 'changed' ? 'unticked in the preview' : '') || x.note,
      note: x.note, edited: x.edited ? 'Yes' : '', ...Object.fromEntries(cwiCols().map(c=>[c[0], x.v[c[0]] === undefined ? '' : x.v[c[0]]]))}));
    const missing = cwi.missing.map(r=>Object.fromEntries([['security_name', r.security_name], ['identifier', r.identifier || ''], ['isin', r.isin || ''],
      ['value', cwi.kind === 'sip' ? r.sip_amount : r.current_value], ['since', r._u ? fmtDate(r._u.at) : '']]));
    const count = s => cwi.rows.filter(x=>x.status === s).length;
    const entry = {id: uid('IMH'), module: 'Client-Wise Import', clientId: t.id, clientName: t.cmsName, platform: p.name, product: p.product,
      kind: cwi.kind, file: cwi.file.name, total: cwi.rows.length, imported: picked.length, failed: count('invalid'),
      skipped: cwi.rows.length - picked.length - count('invalid'), date: new Date().toISOString(), by: currentUser, batchId,
      uploadId: created.upload.id, version: created.version, snapshotDate: created.snapshotDate,
      counts: {new: picked.filter(x=>x.status === 'new').length, updated: picked.filter(x=>x.status === 'changed' || x.status === 'manual').length,
        alreadyOnFile: count('same'), handKept: cwi.rows.filter(x=>x.status === 'manual' && !picked.includes(x)).length,
        twiceInFile: count('dup'), otherClients: count('other'), incomplete: count('invalid'), notInReport: missing.length,
        detailsFilled: cl.updated || 0},
      compareId: compare && compare.id ? compare.id : ''};
    /* Every row, under a key of its own (as the import comparison keeps its
       lines), so the shared history stays small. */
    const detail = {lines, missing};
    DB[cwiReportKey(entry.id)] = detail;
    await sset(cwiReportKey(entry.id), detail);
    DB.importHistory = (DB.importHistory || []).concat([entry]);
    await save('importHistory');
    await logAudit('CMS', t.id, 'Client-Wise Import', [
      {field: p.name + ' · ' + p.product + ' · ' + MA_KIND_LABEL[cwi.kind], oldValue: '', newValue: cwi.file.name + ' (v' + created.version + ')'},
      {field: 'Rows', oldValue: '', newValue: picked.length + ' imported of ' + cwi.rows.length + ' read'}]);
    cwi.historyId = entry.id;
    cwi.step = 'done';
  } catch(e){
    alert('The import did not go through: ' + ((e && e.message) || e) + '\n\nNothing was changed.');
  } finally {
    if(cwi) cwi.busy = false;
    cwiDraw();
  }
}
function cwiDoneHtml(){
  const h = (DB.importHistory || []).find(x=>x.id === cwi.historyId);
  if(!h) return '';
  const c = h.counts || {};
  const line = (n, txt, tone) => n ? `<li><span class="badge ${tone}">${n}</span> ${esc(txt)}</li>` : '';
  return `<div class="fx-note ok" id="cwiDone" style="margin-top:0">Imported ${h.imported} row${h.imported === 1 ? '' : 's'} for <b>${esc(h.clientName)}</b> from ${esc(h.platform)} — ${esc(h.product)}
      (version ${h.version}, data as of ${esc(fmtDate(h.snapshotDate))}). The client's Portfolio, CMS, RMS and the review report, the dashboards, MIS and the reports now carry it.</div>
    <ul class="cwi-res" style="list-style:none;padding:0;margin:10px 0;display:grid;gap:6px">
      ${line(c.new, 'new investments added', 'ok')}${line(c.updated, 'existing investments updated to the report’s figures (earlier figures kept as an older version)', 'info')}
      ${line(c.alreadyOnFile, 'already on file — not imported again', 'muted')}${line(c.handKept, 'entered by hand — kept as entered', 'warn')}
      ${line(c.twiceInFile, 'appeared twice in the file — imported once', 'muted')}${line(c.otherClients, 'belong to another investor in the file — not imported', 'muted')}
      ${line(c.incomplete, 'incomplete (no name, or no value) — not imported', 'danger')}
      ${line(c.notInReport, 'held for this client on this platform but not in the report — kept as they are', 'muted')}
      ${line(c.detailsFilled ? 1 : 0, 'blank details on the client record filled in from the report', 'info')}</ul>
    <div class="small-note">The report below lists every row, what happened to it and why.</div>`;
}
const cwiReportKey = id => 'importReport.' + id;
async function cwiReport(id){
  const h0 = (DB.importHistory || []).find(x=>x.id === id);
  if(!h0){ alert('That import is no longer in the history.'); return; }
  const d = DB[cwiReportKey(id)] || (await sget(cwiReportKey(id), null)) || {};
  const h = Object.assign({}, h0, {lines: d.lines || [], missing: d.missing || []});
  const cols = h.kind === 'sip' ? CWI_SIP_COLS : CWI_HOLD_COLS;
  const c = h.counts || {};
  const sheets = [
    {name: 'Summary', rows: [['Client', h.clientName], ['Client ID', h.clientId], ['Platform', h.platform], ['Category', h.product],
      ['Report', MA_KIND_LABEL[h.kind] || h.kind], ['File', h.file], ['Imported on', fmtDate(h.date)], ['By', teamName(h.by)], ['Version', h.version],
      ['Data as of', h.snapshotDate || ''], ['Rows read', h.total], ['Imported', h.imported], ['Not imported', h.skipped], ['Failed (incomplete)', h.failed],
      ['New', c.new || 0], ['Updated', c.updated || 0], ['Already on file', c.alreadyOnFile || 0], ['Hand entries kept', c.handKept || 0],
      ['Twice in file', c.twiceInFile || 0], ['Other investors in the file', c.otherClients || 0], ['On file, not in the report', c.notInReport || 0]]},
    {name: 'Rows', rows: [['Status', 'Imported', 'Reason', 'Corrected'].concat(cols.map(x=>x[1])).concat(['Note'])]
      .concat((h.lines || []).map(l=>[l.status, l.imported, l.reason || '', l.edited || ''].concat(cols.map(x=>l[x[0]] === null || l[x[0]] === undefined ? '' : String(l[x[0]]))).concat([l.note || ''])))},
    {name: 'Not imported', rows: [['Status', 'Reason'].concat(cols.map(x=>x[1]))]
      .concat((h.lines || []).filter(l=>l.imported !== 'Yes').map(l=>[l.status, l.reason || l.note || ''].concat(cols.map(x=>l[x[0]] === null || l[x[0]] === undefined ? '' : String(l[x[0]])))))},
    {name: 'On file, not in report', rows: [['Investment', 'Folio / account', 'ISIN', h.kind === 'sip' ? 'SIP amount' : 'Current value', 'On file since']]
      .concat((h.missing || []).map(m=>[m.security_name || '', m.identifier || '', m.isin || '', m.value === undefined ? '' : String(m.value), m.since || '']))},
  ];
  downloadXlsx(sheets, 'Client_Wise_Import_' + String(h.clientName || '').replace(/[^\w]+/g, '_') + '_' + String(h.date || '').slice(0, 10) + '.xlsx');
}
/* The client's own import history, on the Portfolio tab. */
function cwiHistoryHtml(clientId){
  const list = (DB.importHistory || []).filter(h=>h && h.module === 'Client-Wise Import' && h.clientId === clientId)
    .sort((a, b)=>String(b.date).localeCompare(String(a.date)));
  if(!list.length) return '';
  return `<div class="card prof-card" id="cwiHistory">
    <div class="section-title" style="margin-top:0">⬆ Client-wise imports</div>
    <div class="table-wrap"><table><thead><tr><th>Imported on</th><th>Platform</th><th>Report</th><th>File</th><th>Imported</th><th>Not imported</th><th>Failed</th><th>By</th><th></th></tr></thead>
    <tbody>${list.slice(0, 50).map(h=>`<tr><td>${esc(fmtDate(h.date))}</td><td>${esc(h.platform)} — ${esc(h.product)}</td><td>${esc(MA_KIND_LABEL[h.kind] || h.kind)}</td>
      <td>${esc(h.file)}</td><td>${h.imported}</td><td>${h.skipped}</td><td>${h.failed}</td><td>${esc(teamName(h.by))}</td>
      <td><button class="btn sm ghost" onclick="cwiReport('${esc(h.id)}')">⬇ Report</button></td></tr>`).join('')}</tbody></table></div></div>`;
}
