/* CLIENT-WISE IMPORT FROM THE CLIENT'S PORTFOLIO TAB (changes 14-11-2026).

   Beside + Add investment: choose the platform, upload the client's report
   (Excel or PDF), check which client it is, preview and correct every row,
   confirm — and the client's AUM, platform lines and the rest follow. The
   same file twice is refused; a re-import updates, never duplicates; a hand
   entry is not overwritten unless somebody ticks it; a report for somebody
   else is not imported until somebody says whose it is. Real files, the real
   reader, the real upload underneath. */
const {suite} = require('../lib/harness');
const {xlsx} = require('../lib/xlsx-write');
const fs = require('fs'), os = require('os'), path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bosscwi-'));
const write = (name, rows) => { const p = path.join(DIR, name); fs.writeFileSync(p, xlsx('Holdings', rows)); return p; };
function pdfFile(name, lines){
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const ops = lines.map(([x, y, text]) => `BT /F1 9 Tf ${x} ${y} Td (${esc(text)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const p = path.join(DIR, name); fs.writeFileSync(p, out, 'latin1'); return p;
}
const HEAD = ['Scheme Name', 'Folio No', 'Units', 'NAV', 'Cost Value', 'Current Value'];
const F = {
  march: write('Kapoor_Finowise_Mar.xlsx', [
    ['Investor: ZZ Kapoor Anil   PAN: ZZKAP1234K'], ['Portfolio valuation as on 31-Mar-2026'], HEAD,
    ['ZZ Bluechip Fund - Direct Growth', 'F-101', '1000', '130', '1,00,000', '1,30,000'],
    ['ZZ Short Debt Fund - Direct Growth', 'F-102', '500', '108', '50,000', '54,000'],
    ['ZZ Midcap Fund - Direct Growth', 'F-103', '200', '150', '25,000', '30,000'],
    ['ZZ Midcap Fund - Direct Growth', 'F-103', '200', '150', '25,000', '30,000'],
    ['', 'F-104', '', '', '', ''],
  ]),
  april: write('Kapoor_Finowise_Apr.xlsx', [
    ['Investor: ZZ Kapoor Anil   PAN: ZZKAP1234K'], ['Portfolio valuation as on 30-Apr-2026'], HEAD,
    ['ZZ Bluechip Fund - Direct Growth', 'F-101', '1000', '140', '1,00,000', '1,40,000'],
    ['ZZ Short Debt Fund - Direct Growth', 'F-102', '500', '108', '50,000', '54,000'],
    ['ZZ Hand Fund - Direct Growth', 'F-109', '10', '1200', '10,000', '12,000'],
  ]),
  someoneElse: write('Sharma_Finowise.xlsx', [
    ['Investor: ZZ Sharma Neha   PAN: ZZSHA5678N'], ['Portfolio valuation as on 31-Mar-2026'], HEAD,
    ['ZZ Liquid Fund - Direct Growth', 'F-201', '100', '1000', '1,00,000', '1,01,000'],
  ]),
  anonymous: write('No_Name_Report.xlsx', [
    ['Portfolio valuation as on 31-Mar-2026'], HEAD,
    ['ZZ Gold Fund - Direct Growth', 'F-301', '100', '200', '18,000', '20,000'],
  ]),
  pdf: pdfFile('Kapoor_Piper_AIF.pdf', [
    [40, 540, 'Investor: ZZ Kapoor Anil PAN: ZZKAP1234K'], [40, 525, 'Statement as on 31-Mar-2026'],
    [40, 500, 'Scheme Name'], [260, 500, 'Units'], [340, 500, 'Invested Amount'], [460, 500, 'Current Value'],
    [40, 485, 'ZZ Growth AIF Cat III'], [260, 485, '1000'], [340, 485, '1000000'], [460, 485, '1150000'],
  ]),
};

suite(async t => {
  let ids;
  const book = () => t.eval((cid)=>{ maInvalidate(); const st = maState(); const c = DB.clients.find(x=>x.id === cid);
    return {aum: clientBookAum(c), rows: st.holdings.filter(r=>r._c.ck === 'c:' + cid).map(r=>({n: r.security_name, v: r.current_value, p: r.platform, manual: !!r._u.manual})),
      lines: DB.platformHoldings.filter(h=>h.clientId === cid && !h.deletedAt).reduce((n, h)=>n + Number(h.current || 0), 0)}; }, ids.k);
  const open = async () => { await t.eval((cid)=>{ cwiOpen(cid); }, ids.k); await t.wait(150); };
  const pick = async (platform, file, kind) => {
    await t.eval(([p, k])=>{ document.getElementById('cwiPlatform').value = p; cwi.platformId = p; document.getElementById('cwiKind').value = k || 'aum'; cwi.kind = k || 'aum'; }, [platform, kind]);
    await t.page.setInputFiles('#cwiFile', file);
    await t.eval(async ()=>{ await cwiRead(); });
    for(let i = 0; i < 40; i++){ const s = await t.eval(()=>cwi && !cwi.busy ? cwi.step : 'busy'); if(s !== 'busy') break; await t.wait(150); }
    return t.eval(()=>({step: cwi.step, err: cwi.err, statuses: cwi.rows.map(r=>r.status + ':' + (r.v.security_name || '?') + (r.sel ? '+' : '-')),
      needs: cwi.needsChoice, can: cwiCanImport(), mapNote: (document.getElementById('cwiMapNote') || {}).innerText || '', missing: (cwi.missing || []).length, dup: !!cwi.dupFile}));
  };
  const confirm = async () => { await t.eval(async ()=>{ await cwiImport(); }); await t.wait(400);
    return t.eval(()=>({step: cwi && cwi.step, done: (document.getElementById('cwiDone') || {}).innerText || '', hist: cwi && cwi.historyId})); };

  await t.step('a client with a PAN, another client, and the button beside + Add investment', async () => {
    ids = await t.eval(async ()=>{
      const mk = (name, pan)=>{ const c = {id: uid('CMS'), cmsName: name, pan, branch: (DB.config.branches || ['Varanasi'])[0], rmName: currentUser, createdAt: new Date().toISOString(), createdBy: currentUser};
        initState('CMS', c); DB.clients.push(c); return c.id; };
      const k = mk('ZZ Kapoor Anil', 'ZZKAP1234K'), s = mk('ZZ Sharma Neha', 'ZZSHA5678N');
      await save('clients'); return {k, s};
    });
    const r = await t.eval(async (cid)=>{ window._clientTab = 'portfolio'; navigate('cms', cid); await new Promise(z=>setTimeout(z, 250));
      const btns = [...document.querySelectorAll('#content button')].map(b=>b.textContent.trim());
      const a = btns.findIndex(x=>/Add investment/.test(x)), w = btns.findIndex(x=>/Client-Wise Import/.test(x));
      return {a, w}; }, ids.k);
    if(r.w < 0) throw new Error('no Client-Wise Import button');
    if(r.w !== r.a + 1) throw new Error('it is not beside + Add investment');
    return 'beside + Add investment';
  });

  await t.step('an Excel report: matched by PAN; new rows ticked, the duplicate and the incomplete row left out', async () => {
    await open();
    const r = await pick('mf-finowise', F.march);
    if(r.step !== 'preview') throw new Error('not read: ' + r.err);
    if(r.needs || !/PAN ZZKAP1234K/.test(r.mapNote)) throw new Error('not matched by PAN: ' + r.mapNote);
    const s = r.statuses.join(' | ');
    if((s.match(/new:[^|]*\+/g) || []).length !== 3) throw new Error('three new rows should be ticked: ' + s);
    if(!/dup:ZZ Midcap[^|]*-/.test(s)) throw new Error('the repeated row was not caught: ' + s);
    if(/ZZ Kapoor|F-104/.test(s) && !/invalid:/.test(s)) throw new Error('the row without a name was not flagged: ' + s);
    return s;
  });

  await t.step('a value corrected in the preview is what is imported; everything follows', async () => {
    await t.page.fill('#cwi_2_current_value', '32000');
    await t.page.dispatchEvent('#cwi_2_current_value', 'change');
    const c = await confirm();
    if(c.step !== 'done') throw new Error('the import did not finish');
    const b = await book();
    if(b.aum !== 216000) throw new Error('AUM ' + b.aum + ' (expected 1,30,000 + 54,000 + 32,000)');
    if(b.lines !== 216000) throw new Error('platform lines ' + b.lines);
    if(!b.rows.some(x=>/Midcap/.test(x.n) && x.v === 32000)) throw new Error('the corrected value was not imported');
    const h = await t.eval(async (id)=>{ const e = DB.importHistory.find(x=>x.id === id); const d = await sget('importReport.' + id, null);
      return {e, lines: d && d.lines.length, audit: DB.auditLog.some(a=>a.action === 'Client-Wise Import')}; }, c.hist);
    if(!h.e || h.e.imported !== 3 || h.e.clientName !== 'ZZ Kapoor Anil' || h.e.platform !== 'Finowise') throw new Error('history: ' + JSON.stringify(h.e));
    if(!h.lines || !h.audit) throw new Error('no row report, or not audited');
    return 'corrected Midcap 32,000 imported; AUM 2,16,000 on the book and the platform lines; history and audit written';
  });

  await t.step('the history is on the client\'s Portfolio tab, with its report', async () => {
    const r = await t.eval(async (cid)=>{ cwiClose(); window._clientTab = 'portfolio'; navigate('cms', cid); await new Promise(z=>setTimeout(z, 250));
      const card = document.getElementById('cwiHistory');
      let sheets = null; const real = downloadXlsx; downloadXlsx = (s)=>{ sheets = s.map(x=>x.name + ':' + (x.rows.length - 1)); return 1; };
      try { await cwiReport(DB.importHistory.filter(h=>h.module === 'Client-Wise Import').pop().id); } finally { downloadXlsx = real; }
      return {card: card ? card.innerText : '', sheets}; }, ids.k);
    if(!/Finowise/.test(r.card) || !/Kapoor_Finowise_Mar/.test(r.card)) throw new Error('history card: ' + r.card);
    if(!r.sheets || !r.sheets.some(x=>/^Not imported:1$/.test(x))) throw new Error('report sheets: ' + JSON.stringify(r.sheets));
    return r.sheets.join(', ');
  });

  await t.step('the same file again is refused', async () => {
    await open();
    const r = await pick('mf-finowise', F.march);
    if(!r.dup || r.can.ok) throw new Error('the repeat was not refused: ' + JSON.stringify(r.can));
    await t.eval(()=>cwiClose());
    return r.can.why;
  });

  await t.step('next month: the changed value updates, the unchanged one is left, a hand entry is not overwritten', async () => {
    await t.eval(async (cid)=>{ await maSaveManual(cid, 'Finowise', 'MF', 'aum', [{security_name: 'ZZ Hand Fund - Direct Growth', identifier: 'F-109', quantity: 10, invested: 10000, current_value: 11000}], 'by hand'); }, ids.k);
    await open();
    const r = await pick('mf-finowise', F.april);
    const s = r.statuses.join(' | ');
    if(!/changed:ZZ Bluechip[^|]*\+/.test(s)) throw new Error('the changed value is not an update: ' + s);
    if(!/same:ZZ Short Debt[^|]*-/.test(s)) throw new Error('the unchanged row is not left out: ' + s);
    if(!/manual:ZZ Hand Fund[^|]*-/.test(s)) throw new Error('the hand entry would be overwritten: ' + s);
    if(r.missing !== 1) throw new Error('the scheme not in the report was not noticed: ' + r.missing);
    await confirm();
    const b = await book();
    const blue = b.rows.filter(x=>/Bluechip/.test(x.n));
    if(blue.length !== 1 || blue[0].v !== 140000) throw new Error('Bluechip: ' + JSON.stringify(blue));
    const hand = b.rows.find(x=>/Hand Fund/.test(x.n));
    if(!hand || hand.v !== 11000 || !hand.manual) throw new Error('the hand entry changed: ' + JSON.stringify(hand));
    if(!b.rows.some(x=>/Midcap/.test(x.n) && x.v === 32000)) throw new Error('the scheme not in the report was dropped');
    await t.eval(()=>cwiClose());
    return 'Bluechip 1,30,000 → 1,40,000, once; Short Debt untouched; hand entry kept at 11,000; Midcap kept';
  });

  await t.step('somebody else\'s report from this client\'s page is not imported until somebody says whose it is', async () => {
    await open();
    const r = await pick('mf-finowise', F.someoneElse);
    if(!r.needs || r.can.ok) throw new Error('it would have been imported to the wrong client: ' + JSON.stringify(r));
    if(!/ZZ Sharma Neha/.test(r.mapNote)) throw new Error('the matching client was not named: ' + r.mapNote);
    await t.eval((sid)=>{ cwiPickTarget(sid); cwi.confirm = true; cwiDraw(); }, ids.s);
    await confirm();
    const r2 = await t.eval((sid)=>{ maInvalidate(); return maState().holdings.filter(x=>x._c.ck === 'c:' + sid).map(x=>x.security_name); }, ids.s);
    if(!r2.some(n=>/Liquid/.test(n))) throw new Error('not imported to the chosen client: ' + JSON.stringify(r2));
    const b = await book();
    if(b.rows.some(x=>/Liquid/.test(x.n))) throw new Error('it landed on this client as well');
    await t.eval(()=>cwiClose());
    return 'held until a client was chosen and confirmed; went to ZZ Sharma Neha only';
  });

  await t.step('a report naming nobody needs a confirmation, then imports', async () => {
    await open();
    const r = await pick('mf-finowise', F.anonymous);
    if(!r.needs || r.can.ok) throw new Error('imported without asking: ' + JSON.stringify(r.can));
    await t.eval(()=>{ cwi.confirm = true; cwiDraw(); });
    const ok = await t.eval(()=>cwiCanImport().ok);
    if(!ok) throw new Error('still blocked after confirming');
    await confirm(); await t.eval(()=>cwiClose());
    const b = await book();
    if(!b.rows.some(x=>/Gold Fund/.test(x.n))) throw new Error('not imported');
    return 'asked, confirmed, imported';
  });

  await t.step('a PDF statement is read and imported the same way', async () => {
    await open();
    const r = await pick('aif-piper-serica', F.pdf);
    if(r.step !== 'preview') throw new Error('PDF not read: ' + r.err);
    if(!/new:ZZ Growth AIF/.test(r.statuses.join('|'))) throw new Error('rows: ' + r.statuses.join('|'));
    await confirm(); await t.eval(()=>cwiClose());
    const b = await book();
    if(!b.rows.some(x=>/Growth AIF/.test(x.n) && x.v === 1150000)) throw new Error('the AIF is not on the book: ' + JSON.stringify(b.rows));
    return 'PDF read off its text layer; AIF 11,50,000 on the book';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
