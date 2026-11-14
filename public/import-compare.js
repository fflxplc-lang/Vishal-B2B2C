/* =====================================================================
   PLATFORM-WISE IMPORT: WHAT THE FILE SAID AGAINST WHAT BOSS HOLDS

   After every platform upload (Setup › Platform Import Mapping › Upload
   files) the file is read again, line by line, on its own terms — not
   through the importer — and each line is matched to a holding or SIP that
   is actually in BOSS. The report is built from that matching, not from
   two totals:

     Imported          the line is in BOSS: matched to a saved row by its
                       ISIN / folio / client code / PAN and its names and
                       amounts. Each saved row answers for one line only.
     Kept unchanged    the line matches what BOSS already held from an
                       earlier upload of this platform (the importer keeps a
                       client whose figures did not change as it was).
     Combined          the line is the same holding as another line (same
                       client and scheme) and was added into that one.
     Duplicate         the line repeats an earlier line of the file word for
                       word. Reported on its own, whether or not it was kept.
     Skipped           not a record at all: a blank line, a title, the
                       heading row again, a Total / Sub-total line, a line
                       with no figures. Reported on its own — these are not
                       failures.
     Not imported      looks like a record, and nothing in BOSS matches it.
                       The genuine failures, each with the likeliest reason.

   On every imported line the fields the file and BOSS both hold are
   compared (value, invested, units, PAN, ISIN, names) and differences are
   listed; a line imported without a client match, an amount or a cost is
   listed as missing fields.

   The summary of each run is kept in importReports (in backups and the
   live layer); the line-by-line detail of each under importReport.<id>, so
   the history stays light however large the files are.
   ===================================================================== */

const IC_KEY = 'importReports';
const icDetailKey = id => 'importReport.' + id;
const IC_LINE_STATUS = {
  imported: {label: 'Imported', tone: 'ok'},
  kept: {label: 'Kept unchanged', tone: 'ok'},
  combined: {label: 'Combined', tone: 'info'},
  duplicate: {label: 'Duplicate', tone: 'warn'},
  skipped: {label: 'Skipped', tone: 'muted'},
  failed: {label: 'Not imported', tone: 'danger'},
  extra: {label: 'In BOSS, not in file', tone: 'info'},
};
function icReports(){ return Array.isArray(DB[IC_KEY]) ? DB[IC_KEY] : (DB[IC_KEY] = []); }

/* ---- reading the file again, independently ----------------------- */

const IC_TEXT_FIELDS = ['client_name', 'client_id', 'pan', 'security_name', 'isin', 'identifier'];
function icNum(v){
  if(v === null || v === undefined || v === '') return null;
  if(typeof v === 'number') return isFinite(v) ? v : null;
  const n = typeof MaExtract !== 'undefined' ? MaExtract.parseNumber(v) : Number(String(v).replace(/[,\s₹]/g, ''));
  return n === null || n === undefined || !isFinite(n) ? null : n;
}
function icText(v){ return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim(); }
function icCode(v){ return String(v === null || v === undefined ? '' : v).replace(/\s+/g, '').toUpperCase(); }
function icKey(v){ return typeof maKey === 'function' ? maKey(v) : icText(v).toLowerCase(); }
/* The heading row of a sheet: the first line where three or more cells are
   column names the importer knows. */
function icHeaderOf(rows, kind){
  const look = Math.min(rows.length, 40);
  for(let i = 0; i < look; i++){
    const map = {};
    (rows[i] || []).forEach((cell, c)=>{
      const f = icText(cell) ? MaExtract.matchField(icText(cell), kind) : null;
      if(f && !Object.values(map).includes(f)) map[c] = f;
    });
    const fields = Object.values(map);
    const hasAmount = fields.some(f=>['current_value', 'invested', 'quantity', 'sip_amount'].includes(f));
    const hasWho = fields.some(f=>['client_name', 'pan', 'client_id', 'security_name', 'isin'].includes(f));
    if(fields.length >= 3 && hasAmount && hasWho) return {at: i, map, names: (rows[i] || []).map(icText)};
  }
  return null;
}
function icRecordOf(row, map){
  const rec = {};
  Object.keys(map).forEach(c=>{ const v = row[c]; if(v !== undefined && v !== null && icText(v) !== '') rec[map[c]] = v; });
  return rec;
}
/* Why a line is not a record, or '' when it is one. */
function icSkipReason(row, header){
  const cells = (row || []).map(icText);
  if(!cells.some(Boolean)) return 'blank line';
  const names = header.names.filter(Boolean).map(x=>x.toLowerCase());
  if(names.length && cells.filter(x=>x && names.includes(x.toLowerCase())).length >= Math.min(3, names.length)) return 'the heading row again';
  const rec = icRecordOf(row, header.map);
  const whoText = [rec.client_name, rec.security_name].map(icText).join(' ');
  if(cells.some(x=>/^(grand\s*)?(sub\s*-?\s*)?total\b|^total\s*:|\btotal\s*(value|amount|aum)?\s*$/i.test(x)) && !rec.pan && !rec.isin) return 'a Total line';
  if(/^(total|grand total|sub ?total)$/i.test(icText(rec.client_name)) || /^(total|grand total|sub ?total)$/i.test(icText(rec.security_name))) return 'a Total line';
  if(!cells.some(x=>icNum(x) !== null && /\d/.test(x))) return 'no figures on the line';
  if(!whoText.trim() && !rec.pan && !rec.isin && !rec.client_id && !rec.identifier) return 'a line naming nobody and nothing';
  return '';
}
function icAmountField(kind){ return kind === 'sip' ? 'sip_amount' : 'current_value'; }
function icClose(a, b){ return a !== null && b !== null && Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.001); }
/* How well a line from the file fits a row BOSS saved. */
function icScore(rec, s, kind){
  let score = 0, strong = false;
  const amt = icAmountField(kind);
  const isin = icCode(rec.isin), id = icCode(rec.identifier || rec.client_id), pan = icCode(rec.pan);
  if(isin && isin === icCode(s.isin)){ score += 4; strong = true; }
  if(id && (id === icCode(s.identifier) || id === icCode(s.client_id))){ score += 3; strong = true; }
  if(pan && pan === icCode(s.pan)) score += 3;
  const cn = icKey(rec.client_name), sn = icKey(s.client_name);
  if(cn && sn){ if(cn === sn) score += 2; else if(cn.indexOf(sn) >= 0 || sn.indexOf(cn) >= 0) score += 1; }
  const fn = icKey(rec.security_name), ss = icKey(s.security_name);
  if(fn && ss){ if(fn === ss) score += 2; else if(fn.indexOf(ss) >= 0 || ss.indexOf(fn) >= 0) score += 1; }
  if(icClose(icNum(rec[amt]), icNum(s[amt]))){ score += 3; strong = true; }
  if(kind !== 'sip' && icClose(icNum(rec.invested), icNum(s.invested))) score += 1;
  if(kind !== 'sip' && icClose(icNum(rec.quantity), icNum(s.quantity))) score += 1;
  return strong && score >= 5 ? score : 0;
}
/* Fields both hold, and where they differ. */
function icDiffs(rec, s, kind){
  const out = [];
  const nums = kind === 'sip' ? ['sip_amount'] : ['current_value', 'invested', 'quantity'];
  nums.forEach(f=>{
    const a = icNum(rec[f]), b = icNum(s[f]);
    if(a !== null && b !== null && !icClose(a, b)) out.push({field: f, file: a, boss: b});
    if(a !== null && b === null) out.push({field: f, file: a, boss: '(empty)'});
  });
  ['pan', 'isin'].forEach(f=>{
    const a = icCode(rec[f]), b = icCode(s[f]);
    if(a && b && a !== b) out.push({field: f, file: rec[f], boss: s[f]});
  });
  const a = icKey(rec.security_name), b = icKey(s.security_name);
  if(a && b && a !== b && a.indexOf(b) < 0 && b.indexOf(a) < 0) out.push({field: 'security_name', file: rec.security_name, boss: s.security_name});
  return out;
}
function icMissing(s, kind, resolve){
  const out = [];
  const who = resolve ? resolve(s) : null;
  if(who && !who.clientId) out.push('not matched to a BOSS client');
  if(kind === 'sip'){ if(icNum(s.sip_amount) === null) out.push('no SIP amount'); }
  else {
    if(icNum(s.current_value) === null) out.push('no current value');
    if(icNum(s.invested) === null && s.level !== 'details') out.push('no invested amount');
  }
  return out;
}
const IC_FIELD_LABEL = {current_value: 'Current value', invested: 'Invested', quantity: 'Units / quantity', sip_amount: 'SIP amount',
  pan: 'PAN', isin: 'ISIN', security_name: 'Scheme / security', client_name: 'Client'};

/* The comparison itself. job: {file, kind, platform, product, uploadType,
   clientName, batchId}; read: what maReadFile returned; created: what
   maCreateUpload returned (or null); outcome: 'ok' | 'skipped' | 'refused'
   | 'failed' | 'details'; error: the message when there is one. */
async function icCompare(job, read, created, outcome, error){
  const kind = job.kind === 'sip' ? 'sip' : 'aum';
  const lines = [];
  const notes = [];
  const fileName = (job.file && job.file.name) || '';
  const isPdf = /\.pdf$/i.test(fileName);
  /* What BOSS holds for this platform and report kind: this upload's rows
     first, then the rows already on file (an unchanged client is kept from
     the earlier upload, not saved again). */
  const pool = [];
  let resolve = null;
  try {
    const thisId = created && created.upload ? created.upload.id : '';
    if(thisId) maRowsOf(created.upload).forEach((r, i)=>pool.push({s: r, src: 'imported', ref: thisId + ':' + i}));
    const pk = icKey(job.platform);
    maUploads().filter(u=>u.id !== thisId && icKey(u.platform) === pk && (u.kind === 'sip') === (kind === 'sip'))
      .sort((a, b)=>(b.version || 0) - (a.version || 0))
      .forEach(u=>maRowsOf(u).forEach((r, i)=>pool.push({s: r, src: 'kept', ref: u.id + ':' + i, version: u.version})));
    resolve = maResolver(pool.map(p=>p.s));
  } catch(e){ notes.push('BOSS’s saved rows could not be read for the comparison: ' + e.message); }

  let readable = false;
  if(!isPdf && job.file && typeof workbookSheets === 'function'){
    try {
      const wb = await workbookSheets(job.file);
      wb.sheets.forEach(sheet=>{
        const rows = sheet.rows || [];
        const header = icHeaderOf(rows, kind);
        if(!header){
          if(rows.some(r=>(r || []).some(c=>icText(c)))) notes.push('Sheet "' + sheet.name + '" has no table BOSS recognises, so it was not compared line by line');
          return;
        }
        readable = true;
        for(let i = header.at + 1; i < rows.length; i++){
          const row = rows[i] || [];
          const why = icSkipReason(row, header);
          const rec = icRecordOf(row, header.map);
          lines.push({sheet: sheet.name, n: i + 1, rec, cells: row.map(icText).filter(Boolean).join(' | ').slice(0, 240),
            status: why ? 'skipped' : '', reason: why});
        }
      });
    } catch(e){ notes.push('The file could not be read again for the comparison: ' + e.message); }
  } else if(isPdf) notes.push('A PDF statement is compared by its records, not line by line: the counts are what BOSS read from it and what it holds');

  /* Match every record line to the best saved row, each row used once. */
  const data = lines.filter(l=>!l.status);
  const pairs = [];
  data.forEach((l, li)=>pool.forEach((p, pi)=>{ const sc = icScore(l.rec, p.s, kind); if(sc) pairs.push({li, pi, sc: sc + (p.src === 'imported' ? 0.5 : 0)}); }));
  pairs.sort((a, b)=>b.sc - a.sc);
  const usedLine = new Set(), usedRow = new Set();
  pairs.forEach(p=>{
    if(usedLine.has(p.li) || usedRow.has(p.pi)) return;
    usedLine.add(p.li); usedRow.add(p.pi);
    const l = data[p.li], hit = pool[p.pi];
    l.status = hit.src === 'imported' ? 'imported' : 'kept';
    l.ref = hit.ref;
    if(hit.src === 'kept') l.reason = 'same as BOSS already held from version ' + (hit.version || '?') + ' — kept as it was';
    l.diffs = icDiffs(l.rec, hit.s, kind);
    l.missing = icMissing(hit.s, kind, resolve);
    l.client = icText(hit.s.client_name || l.rec.client_name); l.security = icText(hit.s.security_name || l.rec.security_name);
    l.amount = icNum(hit.s[icAmountField(kind)]);
  });
  /* What is left: a repeat of an earlier line, the same holding as a matched
     line, or a genuine miss. */
  const seenText = new Map();
  data.forEach(l=>{
    const sig = JSON.stringify(Object.keys(l.rec).sort().map(k=>[k, icText(l.rec[k]).toLowerCase()]));
    if(seenText.has(sig)){
      const first = seenText.get(sig);
      l.duplicateOf = first.n;
      if(!l.status || l.status === 'imported' || l.status === 'kept'){
        l.reason = 'repeats line ' + first.n + ' word for word' + (l.status ? ' (kept as a separate line, as the platform gave it)' : ' (not saved again)');
        l.wasImported = !!l.status;
        l.status = 'duplicate';
      }
    } else seenText.set(sig, l);
  });
  const holdingKey = r => icKey(r.client_name || r.pan || r.client_id) + '|' + icKey(r.security_name || r.isin || r.identifier);
  const matchedKeys = new Map();
  data.filter(l=>l.status === 'imported' || l.status === 'kept').forEach(l=>matchedKeys.set(holdingKey(l.rec), l.n));
  data.filter(l=>!l.status).forEach(l=>{
    const k = holdingKey(l.rec);
    if(matchedKeys.has(k) && k !== '|'){ l.status = 'combined'; l.reason = 'same holding as line ' + matchedKeys.get(k) + ', added into it'; return; }
    l.status = 'failed';
    const amt = icNum(l.rec[icAmountField(kind)]);
    l.reason = !icText(l.rec.client_name) && !l.rec.pan && !l.rec.client_id ? 'no client name, PAN or client code on the line'
      : amt === null ? 'no ' + (kind === 'sip' ? 'SIP amount' : 'current value') + ' on the line'
      : outcome !== 'ok' ? 'the file was not imported (' + (error || outcome) + ')'
      : 'nothing in BOSS matches this line';
  });
  data.forEach(l=>{ if(!l.client) l.client = icText(l.rec.client_name); if(!l.security) l.security = icText(l.rec.security_name); if(l.amount === undefined) l.amount = icNum(l.rec[icAmountField(kind)]); });
  /* Rows this upload saved that no line accounts for (a total the importer
     made for an investor, a statement line from a PDF). */
  const extras = [];
  pool.forEach((p, pi)=>{ if(p.src === 'imported' && !usedRow.has(pi)) extras.push({sheet: '', n: '', status: 'extra', rec: {}, client: icText(p.s.client_name),
    security: icText(p.s.security_name), amount: icNum(p.s[icAmountField(kind)]), reason: readable ? 'saved by the importer but not matched line-for-line to the file' : 'saved from the file', ref: p.ref}); });

  const all = lines.concat(extras);
  const count = st => all.filter(l=>l.status === st).length;
  const importedLines = all.filter(l=>l.status === 'imported' || l.status === 'kept' || (l.status === 'duplicate' && l.wasImported));
  const counts = {
    inFile: readable ? data.length : (read && read.rows ? read.rows.length : 0),
    imported: readable ? count('imported') + count('kept') : (created ? created.rowsCount : 0),
    kept: count('kept'),
    combined: count('combined'),
    duplicates: count('duplicate'),
    skipped: count('skipped'),
    failed: readable ? count('failed') : 0,
    mismatched: importedLines.filter(l=>l.diffs && l.diffs.length).length,
    missing: importedLines.filter(l=>l.missing && l.missing.length).length,
    extra: readable ? count('extra') : 0,
  };
  counts.notImported = counts.failed + all.filter(l=>l.status === 'duplicate' && !l.wasImported).length;
  /* A PDF, or a sheet with no table BOSS recognises: the counts are what the
     importer read against what it saved. */
  if(!readable && read && read.rows) counts.notImported = outcome === 'ok' ? Math.max(0, read.rows.length - (created ? created.rowsCount : 0)) : read.rows.length;
  const status = outcome === 'failed' || outcome === 'refused' ? 'Failed'
    : outcome === 'skipped' ? 'Unchanged'
    : counts.failed || counts.mismatched || counts.missing || (!readable && counts.notImported) ? 'Discrepancies' : 'Matched';
  const id = uid('ICR');
  const summary = {id, at: new Date().toISOString(), by: currentUser, batchId: job.batchId || '', uploadId: created && created.upload ? created.upload.id : '',
    platform: job.platform || '', product: job.product || '', kind, uploadType: job.uploadType || 'platform', client: job.clientName || '',
    file: fileName, outcome, error: error || '', status, counts, lineByLine: readable, notes};
  return {summary, lines: all.map(l=>({sheet: l.sheet, n: l.n, status: l.status, reason: l.reason || '', cells: l.cells || '',
    client: l.client || '', security: l.security || '', amount: l.amount === undefined ? null : l.amount,
    diffs: l.diffs || [], missing: l.missing || [], duplicateOf: l.duplicateOf || null, ref: l.ref || ''}))};
}
/* Keep it: the summary in the history, the lines under their own key. */
async function icRecord(job, read, created, outcome, error){
  try {
    const r = await icCompare(job, read, created, outcome, error);
    await sset(icDetailKey(r.summary.id), r.lines);
    DB[IC_KEY] = icReports().concat([r.summary]);
    await save(IC_KEY);
    return r.summary;
  } catch(e){
    console.error('import comparison', e);
    return null;
  }
}

/* =====================================================================
   THE SCREENS
   ===================================================================== */
const icFilter = {platform: '', from: '', to: '', status: '', type: ''};
const IC_TYPES = {failed: 'Not imported', duplicates: 'Duplicates', skipped: 'Skipped', mismatched: 'Mismatched fields', missing: 'Missing fields', combined: 'Combined lines'};
function icStatusBadge(st){
  const tone = st === 'Matched' ? 'ok' : st === 'Discrepancies' ? 'warn' : st === 'Failed' ? 'danger' : 'muted';
  return `<span class="badge ${tone}">${esc(st)}</span>`;
}
function icFiltered(){
  const f = icFilter;
  return icReports().filter(r=>(!f.platform || r.platform === f.platform)
    && (!f.from || String(r.at).slice(0, 10) >= f.from) && (!f.to || String(r.at).slice(0, 10) <= f.to)
    && (!f.status || r.status === f.status) && (!f.type || (r.counts && r.counts[f.type] > 0)))
    .slice().sort((a, b)=>String(b.at).localeCompare(String(a.at)));
}
function icHistoryHtml(){
  const platforms = Array.from(new Set(icReports().map(r=>r.platform).filter(Boolean))).sort();
  const list = icFiltered();
  const sel = (key, opts, all) => `<select onchange="icFilter.${key}=this.value; render()" style="border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12.5px">
    <option value="">${all}</option>${opts.map(([v, l])=>`<option value="${esc(v)}" ${icFilter[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const n = v => v ? `<b>${v}</b>` : '0';
  const rows = list.slice(0, 200).map(r=>{ const c = r.counts || {};
    return `<tr><td>${esc(fmtDateTime(r.at))}<div class="small-note" style="margin:2px 0 0">${esc(teamName(r.by))}</div></td>
      <td><b>${esc(r.platform)}</b><div class="small-note" style="margin:2px 0 0">${esc(r.product)} · ${r.kind === 'sip' ? 'SIP' : 'AUM'}${r.uploadType === 'client' ? ' · ' + esc(r.client) : ''}</div></td>
      <td style="max-width:220px;word-break:break-all">${esc(r.file)}</td>
      <td class="se-r">${c.inFile || 0}</td><td class="se-r">${c.imported || 0}</td><td class="se-r" style="color:var(--${c.notImported ? 'danger' : 'muted'})">${n(c.notImported)}</td>
      <td class="se-r">${n(c.duplicates)}</td><td class="se-r">${n(c.skipped)}</td><td class="se-r">${n((c.mismatched || 0) + (c.missing || 0))}</td>
      <td>${icStatusBadge(r.status)}${r.error ? `<div class="small-note" style="margin:2px 0 0">${esc(r.error)}</div>` : ''}</td>
      <td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" onclick="icOpen('${r.id}')">View</button>
        <button class="btn sm ghost" onclick="icDownload('${r.id}')">Download</button></div></td></tr>`; });
  return `
    <p class="small-note" style="margin-top:0;max-width:880px">After every platform-wise upload the file is read again line by line and each line is matched to a holding or SIP that is
      really in BOSS — by ISIN, folio or client code, PAN, names and amounts — so the report says which records went in, which did not and why,
      and where a field differs. Duplicates and lines that are not records (titles, totals, blanks) are counted on their own, apart from genuine failures.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap;margin:0 0 10px">
      ${sel('platform', platforms.map(p=>[p, p]), 'All platforms')}
      <label class="small-note" style="margin:0">From</label><input type="date" value="${esc(icFilter.from)}" onchange="icFilter.from=this.value; render()">
      <label class="small-note" style="margin:0">To</label><input type="date" value="${esc(icFilter.to)}" onchange="icFilter.to=this.value; render()">
      ${sel('status', [['Matched', 'Matched'], ['Discrepancies', 'Discrepancies'], ['Failed', 'Failed'], ['Unchanged', 'Unchanged']], 'Any status')}
      ${sel('type', Object.entries(IC_TYPES), 'Any discrepancy')}
      ${Object.values(icFilter).some(Boolean) ? `<button class="btn sm ghost" onclick="Object.keys(icFilter).forEach(k=>icFilter[k]=''); render()">Clear</button>` : ''}
    </div>
    ${repTable([{t: 'Uploaded'}, {t: 'Platform'}, {t: 'File'}, {t: 'In file', r: 1}, {t: 'Imported', r: 1}, {t: 'Not imported', r: 1}, {t: 'Duplicates', r: 1},
      {t: 'Skipped', r: 1}, {t: 'Field issues', r: 1}, {t: 'Status'}, {t: ''}], rows, icReports().length ? 'No imports match these filters.' : 'No platform-wise import has been compared yet — the next upload will be.')}`;
}
let icView = null;     // {summary, lines, show}
async function icOpen(id){
  const summary = icReports().find(r=>r.id === id);
  if(!summary) return;
  const lines = (await sget(icDetailKey(id), [])) || [];
  icView = {summary, lines, show: summary.counts && (summary.counts.notImported || summary.counts.mismatched || summary.counts.missing) ? 'problems' : 'all'};
  icRenderDetail();
}
function icRenderDetail(){
  if(!icView) return;
  const {summary: s, lines} = icView;
  const c = s.counts || {};
  const problem = l=>l.status === 'failed' || (l.status === 'duplicate' && !/kept as a separate line/.test(l.reason)) || (l.diffs && l.diffs.length) || (l.missing && l.missing.length);
  const shown = lines.filter(l=>icView.show === 'all' ? true : icView.show === 'problems' ? problem(l) : icView.show === 'issues' ? (l.diffs && l.diffs.length) || (l.missing && l.missing.length) : l.status === icView.show);
  const chip = (key, label, n) => `<button class="btn sm ${icView.show === key ? 'primary' : ''}" onclick="icView.show='${key}'; icRenderDetail()">${esc(label)}${n === undefined ? '' : ' (' + n + ')'}</button>`;
  const money0 = v => v === null || v === undefined ? '—' : (typeof money === 'function' ? money(v) : String(v));
  const rows = shown.slice(0, 1500).map(l=>{ const st = IC_LINE_STATUS[l.status] || {label: l.status, tone: 'muted'};
    const issues = (l.diffs || []).map(d=>`${esc(IC_FIELD_LABEL[d.field] || d.field)}: file <b>${esc(String(d.file))}</b>, BOSS <b>${esc(String(d.boss))}</b>`)
      .concat((l.missing || []).map(m=>'missing: ' + esc(m)));
    return `<tr><td class="small-note" style="margin:0">${esc(l.sheet || '')}${l.n ? ' · line ' + l.n : ''}</td><td><span class="badge ${st.tone}">${esc(st.label)}</span></td>
      <td>${esc(l.client || '—')}<div class="small-note" style="margin:2px 0 0">${esc(l.security || '')}</div></td><td class="se-r">${money0(l.amount)}</td>
      <td style="font-size:12px">${esc(l.reason || '')}${issues.length ? `<div style="margin-top:2px;color:var(--warn)">${issues.join('<br>')}</div>` : ''}
        ${l.status === 'failed' || l.status === 'skipped' || l.status === 'duplicate' ? `<div class="small-note" style="margin:2px 0 0;word-break:break-all">${esc(l.cells || '')}</div>` : ''}</td></tr>`; });
  const body = `
    <div class="small-note" style="margin-top:0">${esc(s.platform)} · ${esc(s.product)} · ${s.kind === 'sip' ? 'SIP' : 'AUM'} · ${esc(s.file)} · uploaded ${esc(fmtDateTime(s.at))} by ${esc(teamName(s.by))} ${icStatusBadge(s.status)}</div>
    ${s.error ? repNote('danger', 'The file itself', esc(s.error)) : ''}
    ${repKpis([{label: 'Records in the file', value: c.inFile || 0}, {label: 'Imported', value: c.imported || 0, tone: 'ok', note: c.kept ? c.kept + ' of them kept unchanged from an earlier upload' : ''},
      {label: 'Not imported', value: c.notImported || 0, tone: c.notImported ? 'danger' : ''}, {label: 'Duplicates', value: c.duplicates || 0, tone: c.duplicates ? 'warn' : ''},
      {label: 'Skipped (not records)', value: c.skipped || 0}, {label: 'Mismatched fields', value: c.mismatched || 0, tone: c.mismatched ? 'warn' : ''},
      {label: 'Missing fields', value: c.missing || 0, tone: c.missing ? 'warn' : ''}, {label: 'Combined lines', value: c.combined || 0}])}
    ${(s.notes || []).length ? `<div class="small-note">${s.notes.map(esc).join('<br>')}</div>` : ''}
    <div class="row" style="gap:6px;flex-wrap:wrap;margin:12px 0 8px">
      ${chip('problems', 'Needs a look', lines.filter(problem).length)}${chip('failed', 'Not imported', lines.filter(l=>l.status === 'failed').length)}
      ${chip('issues', 'Field issues', lines.filter(l=>(l.diffs && l.diffs.length) || (l.missing && l.missing.length)).length)}
      ${chip('duplicate', 'Duplicates', c.duplicates || 0)}${chip('skipped', 'Skipped', c.skipped || 0)}${chip('combined', 'Combined', c.combined || 0)}
      ${chip('imported', 'Imported', lines.filter(l=>l.status === 'imported').length)}${chip('kept', 'Kept unchanged', c.kept || 0)}${chip('all', 'Every line', lines.length)}
    </div>
    ${repTable([{t: 'Where'}, {t: 'Result'}, {t: 'Client / holding'}, {t: s.kind === 'sip' ? 'SIP amount' : 'Value', r: 1}, {t: 'Why / what differs'}], rows,
      icView.show === 'problems' ? 'Nothing needs a look — every record in the file is in BOSS as the file gives it.' : 'No lines here.')}
    ${shown.length > 1500 ? `<div class="small-note">The first 1,500 of ${shown.length} lines are shown; Download has them all.</div>` : ''}`;
  openModal('Import comparison', body, `<button class="btn" onclick="icDownload('${s.id}')">Download report</button><button class="btn primary" onclick="closeModal()">Close</button>`, {wide: true});
}
async function icDownload(id){
  const s = icReports().find(r=>r.id === id);
  if(!s) return;
  const lines = (await sget(icDetailKey(id), [])) || [];
  const c = s.counts || {};
  const summary = [['Platform', s.platform], ['Product', s.product], ['Report', s.kind === 'sip' ? 'SIP' : 'AUM'], ['File', s.file],
    ['Uploaded', fmtDateTime(s.at)], ['Uploaded by', teamName(s.by)], ['Status', s.status], [],
    ['Records in the file', c.inFile || 0], ['Imported', c.imported || 0], ['  of which kept unchanged', c.kept || 0], ['Not imported', c.notImported || 0],
    ['Duplicates', c.duplicates || 0], ['Skipped (not records)', c.skipped || 0], ['Combined lines', c.combined || 0],
    ['Mismatched fields', c.mismatched || 0], ['Missing fields', c.missing || 0], ['In BOSS, not line-for-line in the file', c.extra || 0]]
    .concat((s.notes || []).map(n=>['Note', n]));
  const head = ['Sheet', 'Line', 'Result', 'Client', 'Scheme / security', s.kind === 'sip' ? 'SIP amount' : 'Value', 'Why', 'Field differences', 'Missing fields', 'Line as in the file'];
  const body = lines.map(l=>[l.sheet || '', l.n || '', (IC_LINE_STATUS[l.status] || {label: l.status}).label, l.client || '', l.security || '',
    l.amount === null || l.amount === undefined ? '' : l.amount, l.reason || '',
    (l.diffs || []).map(d=>(IC_FIELD_LABEL[d.field] || d.field) + ': file ' + d.file + ', BOSS ' + d.boss).join('; '), (l.missing || []).join('; '), l.cells || '']);
  const name = ('Import_comparison_' + s.platform + '_' + String(s.at).slice(0, 10)).replace(/[^A-Za-z0-9_\-]+/g, '_') + '.xlsx';
  if(typeof downloadXlsx === 'function') downloadXlsx([{name: 'Summary', rows: summary}, {name: 'Lines', rows: [head].concat(body)}], name);
}
/* The line under each file in the upload result. */
function icResultCell(summary){
  if(!summary) return '<span class="small-note" style="margin:0">—</span>';
  const c = summary.counts || {};
  return `${icStatusBadge(summary.status)} <span class="small-note" style="margin:0">${c.imported || 0} of ${c.inFile || 0} in BOSS${c.notImported ? ', ' + c.notImported + ' not imported' : ''}${c.duplicates ? ', ' + c.duplicates + ' duplicate' : ''}${c.skipped ? ', ' + c.skipped + ' skipped' : ''}${(c.mismatched || c.missing) ? ', ' + ((c.mismatched || 0) + (c.missing || 0)) + ' with field issues' : ''}</span>
    <a href="javascript:void(0)" class="cell-link" onclick="closeModal(); window._impMapSection='reports'; navigate('settings','importmaps'); setTimeout(()=>icOpen('${summary.id}'), 50)">View</a>`;
}
