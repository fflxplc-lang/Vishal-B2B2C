/* =====================================================================
   WEBSITE FQ RESULTS — every "Know Your FQ Score" test taken on the
   firm's website, kept and readable in full.

   The website posts each completed test to POST /api/public/website-lead
   (server.js). A visitor who asks to talk (consent: true) becomes a lead,
   as before; one who does not is kept as a result on its own. Either way
   the whole result — score, points, band, life stage, section by section,
   and every question with the answer chosen — is a row of the
   websiteFqResults store, linked to the lead where there is one.

   Forms › Website FQ Results lists them; any row, and a website lead's
   "More Details →", opens the whole result. Leads that came in from the
   website before results were kept separately are listed too, from the
   test stored on the lead.
   ===================================================================== */

function wfqRows(){
  const rows = (Array.isArray(DB.websiteFqResults) ? DB.websiteFqResults : []).filter(r=>r && !r.deletedAt);
  const linked = new Set(rows.map(r=>r.leadId).filter(Boolean));
  // Website leads from before results were kept on their own: their test is on the lead.
  (DB.leads || []).forEach(l=>{
    if(!l || l.deletedAt || !l.fqTest || linked.has(l.id)) return;
    const t = l.fqTest;
    rows.push({id: 'lead:' + l.id, legacy: true, receivedAt: t.receivedAt || l.createdAt, completedAt: t.completedAt,
      name: [l.firstName, l.lastName].filter(Boolean).join(' '), mobile: l.mobile || '', email: l.email || '', city: t.city || l.city || '',
      occupation: t.occupation || l.occupation || '', referralName: t.referralName || l.referralName || '',
      consentToConnect: t.consentToConnect !== false, score: t.score, band: t.band, stage: t.stage, stageLabel: t.stageLabel,
      points: t.points, maxPoints: t.maxPoints, fqTest: t, leadId: l.id, assignedTo: l.assignedTo || ''});
  });
  return rows.sort((a, b)=>String(b.completedAt || b.receivedAt || '').localeCompare(String(a.completedAt || a.receivedAt || '')));
}
function wfqRow(id){ return wfqRows().find(r=>r.id===id) || null; }
function wfqLead(r){ return r && r.leadId ? (DB.leads || []).find(l=>l.id===r.leadId) || (DB.clients || []).find(c=>c.id===r.leadId || c.convertedFromLeadId===r.leadId) || null : null; }
function wfqColor(band){ return typeof fqBandColor === 'function' ? fqBandColor(band) : 'var(--navy)'; }
function wfqScore(r){ return (r.score === null || r.score === undefined || r.score === '') ? '—' : String(Math.round(Number(r.score))); }
function wfqPoints(r){ return r.points !== null && r.points !== undefined && r.maxPoints ? r.points + ' of ' + r.maxPoints + ' points' : ''; }
function wfqWho(r){ return r.name || (r.mobile ? '+91 ' + r.mobile : 'Anonymous visitor'); }

/* ---------- the list ---------- */
function wfqState(){ return window._wfq || (window._wfq = {q: '', consent: 'All', band: '', stage: '', period: 'All'}); }
function wfqFiltered(){
  const S = wfqState(), q = S.q.trim().toLowerCase();
  const since = S.period === '7' ? Date.now() - 7 * 864e5 : S.period === '30' ? Date.now() - 30 * 864e5 : 0;
  return wfqRows().filter(r=>{
    if(S.consent === 'Yes' && !r.consentToConnect) return false;
    if(S.consent === 'No' && r.consentToConnect) return false;
    if(S.band && r.band !== S.band) return false;
    if(S.stage && (r.stageLabel || r.stage) !== S.stage) return false;
    if(since && new Date(r.completedAt || r.receivedAt).getTime() < since) return false;
    if(q && ![r.name, r.mobile, r.email, r.city, r.occupation, r.referralName].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
}
function viewWebsiteFq(){
  if(typeof bossPartnerSide === 'function' && bossPartnerSide()) return `<div class="card"><div class="empty">Website FQ results are for the company team.</div></div>`;
  const S = wfqState(), all = wfqRows();
  const bands = Array.from(new Set(all.map(r=>r.band).filter(Boolean))).sort();
  const stages = Array.from(new Set(all.map(r=>r.stageLabel || r.stage).filter(Boolean))).sort();
  const month = all.filter(r=>String(r.completedAt || r.receivedAt || '').slice(0, 7) === new Date().toISOString().slice(0, 7)).length;
  const avg = all.length ? Math.round(all.reduce((n, r)=>n + (Number(r.score) || 0), 0) / all.length) : 0;
  const yes = all.filter(r=>r.consentToConnect).length;
  return moduleHeader({title: 'Website FQ Results',
      subtitle: 'Every “Know Your FQ Score” test taken on the website — whether or not the visitor asked to talk. Open any row for the whole result.',
      actions: [all.length && {label: 'Export CSV', icon: '↓', onclick: 'wfqExport()'}]})
    + `<div class="wfq-stats">
      <div class="card"><b>${all.length}</b><span>Results kept</span></div>
      <div class="card"><b>${month}</b><span>This month</span></div>
      <div class="card"><b>${yes}</b><span>Asked to talk (leads)</span></div>
      <div class="card"><b>${all.length - yes}</b><span>Did not ask to talk</span></div>
      <div class="card"><b>${avg}</b><span>Average score</span></div>
    </div>
    <div class="card" style="padding:12px 14px;margin-bottom:12px"><div class="row wfq-filters" style="gap:10px;flex-wrap:wrap;align-items:center">
      <input type="search" id="wfqSearch" placeholder="Search name, mobile, email or city" value="${esc(S.q)}" style="flex:1;min-width:220px" oninput="wfqSearch(this.value)">
      <select onchange="wfqSet('consent', this.value)">${[['All','Everyone'],['Yes','Asked to talk'],['No','Did not ask to talk']].map(([v, l])=>`<option value="${v}" ${S.consent===v?'selected':''}>${l}</option>`).join('')}</select>
      <select onchange="wfqSet('band', this.value)"><option value="">All categories</option>${bands.map(b=>`<option ${S.band===b?'selected':''}>${esc(b)}</option>`).join('')}</select>
      <select onchange="wfqSet('stage', this.value)"><option value="">All life stages</option>${stages.map(b=>`<option ${S.stage===b?'selected':''}>${esc(b)}</option>`).join('')}</select>
      <select onchange="wfqSet('period', this.value)">${[['All','Any time'],['7','Last 7 days'],['30','Last 30 days']].map(([v, l])=>`<option value="${v}" ${S.period===v?'selected':''}>${l}</option>`).join('')}</select>
    </div></div>
    <div id="wfqList">${wfqListHtml()}</div>`;
}
function wfqListHtml(){
  const rows = wfqFiltered();
  if(!wfqRows().length) return `<div class="card"><div class="empty">No website FQ results yet. Each test taken on the website lands here the moment it is finished.</div></div>`;
  if(!rows.length) return `<div class="card"><div class="empty">No result matches these filters.</div></div>`;
  return `<div class="card" style="padding:0"><div class="table-wrap"><table id="wfqTable">
    <thead><tr><th>Taken</th><th>Name</th><th>Contact</th><th>City</th><th class="num">Score</th><th>Category</th><th>Life stage</th><th>Asked to talk</th><th></th></tr></thead>
    <tbody>${rows.map(r=>{
      const lead = wfqLead(r);
      return `<tr class="row-clickable" onclick="wfqOpen('${esc(r.id)}')">
        <td>${esc(fmtDateTime ? fmtDateTime(r.completedAt || r.receivedAt) : fmtDate(r.completedAt || r.receivedAt))}</td>
        <td><b>${esc(wfqWho(r))}</b>${r.occupation ? `<div class="small-note" style="margin:0">${esc(r.occupation)}</div>` : ''}</td>
        <td>${esc(r.mobile || '—')}${r.email ? `<div class="small-note" style="margin:0">${esc(r.email)}</div>` : ''}</td>
        <td>${esc(r.city || '—')}</td>
        <td class="num"><b>${esc(wfqScore(r))}</b>${wfqPoints(r) ? `<div class="small-note" style="margin:0">${esc(wfqPoints(r))}</div>` : ''}</td>
        <td>${r.band ? `<span class="wfq-band" style="background:${esc(wfqColor(r.band))}">${esc(r.band)}</span>` : '—'}</td>
        <td>${esc(r.stageLabel || r.stage || '—')}</td>
        <td>${r.consentToConnect ? `<span class="badge ok">Yes</span>${lead ? ` <a href="javascript:void(0)" class="cell-link" onclick="event.stopPropagation(); wfqOpenLead('${esc(r.leadId)}')">Lead →</a>` : ''}`
          : `<span class="badge muted">No</span>${lead ? ` <a href="javascript:void(0)" class="cell-link" onclick="event.stopPropagation(); wfqOpenLead('${esc(r.leadId)}')">Existing lead →</a>` : ''}`}</td>
        <td><button class="btn sm" onclick="event.stopPropagation(); wfqOpen('${esc(r.id)}')">View result</button></td>
      </tr>`;
    }).join('')}</tbody></table></div></div>
    <div class="small-note">${rows.length} result${rows.length===1?'':'s'}</div>`;
}
function wfqSearch(v){ wfqState().q = v; const el = document.getElementById('wfqList'); if(el) el.innerHTML = wfqListHtml(); else render(); }
function wfqSet(k, v){ wfqState()[k] = v; render(); }
function wfqOpenLead(id){
  const o = document.getElementById('overlay');
  if(o && o.classList.contains('show')) closeModal();
  if((DB.leads || []).some(l=>l.id===id)) navigate('lms', id);
  else { const c = (DB.clients || []).find(x=>x.id===id || x.convertedFromLeadId===id); if(c) navigate('cms', c.id); }
}

/* ---------- the whole result ---------- */
function wfqResultHtml(r, t){
  t = t || r.fqTest || {};
  const lead = wfqLead(r);
  const sections = (t.sections || []).filter(s=>s && s.name && s.max);
  const pillars = Object.entries(t.pillars || {});
  const weak = sections.length && typeof fqWeakestSection === 'function' ? fqWeakestSection(sections) : null;
  const answers = t.answers || [];
  const byPillar = {};
  answers.forEach(a=>{ const k = a.pillar || 'Questions'; (byPillar[k] = byPillar[k] || []).push(a); });
  const pts = t.points !== null && t.points !== undefined && t.maxPoints ? t.points + ' of ' + t.maxPoints + ' points' : '';
  return `<div class="wfq-result">
    <div class="wfq-hero" style="--band:${esc(wfqColor(t.band))}">
      <div class="wfq-dial"><b>${esc(t.score === undefined ? '—' : String(Math.round(Number(t.score))))}</b><span>/ 100</span></div>
      <div class="wfq-hero-main">
        ${t.band ? `<span class="wfq-band lg" style="background:${esc(wfqColor(t.band))}">${esc(t.band)}</span>` : ''}
        <div class="wfq-hero-line">${esc([pts, t.stageLabel || '', 'taken ' + (fmtDateTime ? fmtDateTime(t.completedAt) : fmtDate(t.completedAt))].filter(Boolean).join(' · '))}</div>
        <div class="wfq-hero-line">${t.consentToConnect ? '✅ Asked to talk to the team' : '— Did not ask to be contacted'}${lead ? ` · <a href="javascript:void(0)" class="cell-link" onclick="wfqOpenLead('${esc(r.leadId)}')">Open ${(DB.leads||[]).some(l=>l.id===r.leadId) ? 'lead' : 'client'} →</a>` : ''}</div>
      </div>
    </div>
    <div class="prof-grid" style="margin:14px 0">
      ${[['Name', wfqWho(r)], ['Mobile', r.mobile || '—'], ['Email', r.email || '—'], ['City', t.city || r.city || '—'],
         ['Occupation', t.occupation || r.occupation || '—'], ['Referred by', t.referralName || r.referralName || '—']]
        .map(([k, v])=>`<div class="prof-field"><label>${k}</label><div>${esc(v)}</div></div>`).join('')}
    </div>
    ${sections.length ? `<div class="card" style="margin:0 0 12px"><div class="section-title" style="margin-top:0">Section by section</div>
      ${typeof fqaBarsHtml === 'function' ? fqaBarsHtml(sections) : ''}
      ${weak ? `<div class="small-note" style="margin-top:8px">Lowest: <b>${esc(weak.name)}</b>${typeof fqSectionNote === 'function' && fqSectionNote(weak.name, weak.score, weak.max) ? ' — ' + esc(fqSectionNote(weak.name, weak.score, weak.max)) : ''}. A good place to open the first conversation.</div>` : ''}</div>` : ''}
    ${pillars.length ? `<div class="card" style="margin:0 0 12px"><div class="section-title" style="margin-top:0">By pillar</div>
      <div class="wfq-pillars">${pillars.map(([k, v])=>`<div><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('')}</div></div>` : ''}
    <div class="card" style="margin:0"><div class="section-title" style="margin-top:0">Every answer (${answers.length})</div>
      ${answers.length ? Object.entries(byPillar).map(([p, list])=>`<div class="wfq-pillar-head">${esc(p)}</div>
        <table class="wfq-answers"><tbody>${list.map(a=>`<tr><td class="no">${esc(String(a.no))}</td>
          <td><div class="q">${esc(a.question || '')}</div><div class="a">${a.option ? `<span class="opt">${esc(a.option)}</span>` : ''}${esc(a.answer || '—')}</div></td>
          <td class="pts">${a.points !== null && a.points !== undefined ? esc(String(a.points)) + ' pt' + (Number(a.points)===1?'':'s') : ''}</td></tr>`).join('')}</tbody></table>`).join('')
        : '<div class="small-note">The website did not send the answers for this test.</div>'}
    </div>
  </div>`;
}
/* One result, in full. A visitor who took the test more than once (their
   lead keeps up to ten) can be stepped through attempt by attempt. */
function wfqOpen(id, attempt){
  const r = wfqRow(id);
  if(!r){ alert('That result is not there any more.'); return; }
  const lead = wfqLead(r);
  const history = lead && Array.isArray(lead.fqHistory) && lead.fqHistory.length > 1 ? lead.fqHistory.slice().reverse() : null;
  const i = Math.max(0, Math.min((history || [1]).length - 1, Number(attempt) || 0));
  const t = history ? history[i] : r.fqTest;
  const tabs = history ? `<div class="tabs" style="margin-bottom:12px">${history.map((h, k)=>`<button class="tab ${k===i?'active':''}" onclick="wfqOpen('${esc(id)}', ${k})">
      ${k===0 ? 'Latest' : 'Attempt ' + (history.length - k)} · ${esc(String(Math.round(Number(h.score))))}</button>`).join('')}</div>` : '';
  openModal('FQ Result — ' + esc(wfqWho(r)), tabs + wfqResultHtml(r, t),
    `<button class="btn" onclick="closeModal()">Close</button><button class="btn" onclick="wfqPrint('${esc(id)}', ${i})">Print / Save PDF</button>`
    + (lead ? `<button class="btn primary" onclick="wfqOpenLead('${esc(r.leadId)}')">Open ${(DB.leads||[]).some(l=>l.id===r.leadId) ? 'lead' : 'client'}</button>` : ''), {wide: true});
}
/* From a lead's "More Details →": its newest website result. */
function wfqOpenForRecord(recordId){
  const rows = wfqRows().filter(r=>r.leadId===recordId);
  if(!rows.length) return false;
  wfqOpen(rows[0].id);
  return true;
}
function wfqPrint(id, attempt){
  const r = wfqRow(id); if(!r) return;
  const lead = wfqLead(r);
  const history = lead && Array.isArray(lead.fqHistory) && lead.fqHistory.length > 1 ? lead.fqHistory.slice().reverse() : null;
  const t = history ? history[Number(attempt) || 0] : r.fqTest;
  const w = window.open('', '_blank');
  if(!w){ alert('Allow pop-ups for BOSS to print the result.'); return; }
  const css = Array.from(document.querySelectorAll('style')).map(s=>s.textContent).join('\n');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>FQ Result — ${esc(wfqWho(r))}</title><style>${css}
    body{background:#fff;padding:24px;max-width:900px;margin:0 auto}</style></head><body><h2>FQ Result — ${esc(wfqWho(r))}</h2>${wfqResultHtml(r, t)}</body></html>`);
  w.document.close(); w.focus();
  setTimeout(()=>{ try { w.print(); } catch(e){} }, 300);
}
function wfqExport(){
  const rows = wfqFiltered();
  const qs = Math.max(0, ...rows.map(r=>((r.fqTest || {}).answers || []).length));
  const head = ['Taken', 'Name', 'Mobile', 'Email', 'City', 'Occupation', 'Referred by', 'Score', 'Points', 'Max points', 'Category', 'Life stage', 'Asked to talk', 'Lead']
    .concat(Array.from({length: qs}, (_, i)=>'Q' + (i + 1)));
  const cell = v => { const s = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [head.map(cell).join(',')].concat(rows.map(r=>[r.completedAt || r.receivedAt, r.name, r.mobile, r.email, r.city, r.occupation, r.referralName,
    r.score, r.points, r.maxPoints, r.band, r.stageLabel || r.stage, r.consentToConnect ? 'Yes' : 'No', r.leadId]
    .concat(((r.fqTest || {}).answers || []).map(a=>(a.option ? a.option + ') ' : '') + (a.answer || ''))).map(cell).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], {type: 'text/csv'}));
  a.download = 'website-fq-results-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
}
