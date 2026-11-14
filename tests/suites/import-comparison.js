/* PLATFORM-WISE IMPORT: THE FILE AGAINST WHAT BOSS HOLDS, LINE BY LINE.

   One Motilal Oswal holdings file with every kind of line in it: two good
   holdings, the first repeated word for word, a Total line, a blank line, a
   line with no value, and a holding that names nobody. After the upload
   the comparison has to put each line in its place — imported, duplicate,
   skipped, not imported — from what is really saved, not from totals; a
   second upload of the same file has to say the lines are already in BOSS;
   and a field BOSS holds differently from the file has to be named. */
const {suite} = require('../lib/harness');
const {xlsx} = require('../lib/xlsx-write');
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bossic-'));
const FILE = path.join(DIR, 'MO_Holdings_Compare.xlsx');
fs.writeFileSync(FILE, xlsx('Holdings', [
  ['Motilal Oswal — Holdings as on 31-Mar-2026'],
  ['Client Name', 'PAN', 'Stock Name', 'ISIN', 'Qty', 'Avg Price', 'LTP', 'Market Value'],
  ['ZZ Compare Mehta', 'ZZCMP1234M', 'ZZ Infra Ltd', 'INE000ZC0001', '100', '500', '600', '60,000'],   // line 3
  ['ZZ Compare Mehta', 'ZZCMP1234M', 'ZZ Power Ltd', 'INE000ZC0002', '50', '200', '260', '13,000'],   // line 4
  ['ZZ Compare Mehta', 'ZZCMP1234M', 'ZZ Infra Ltd', 'INE000ZC0001', '100', '500', '600', '60,000'],  // line 5: repeats 3
  ['', '', '', '', '', '', '', ''],                                                                 // line 6: blank
  ['ZZ Compare Rao', 'ZZCMP5678R', 'ZZ Steel Ltd', 'INE000ZC0003', '', '', '', ''],                  // line 7: no value
  ['', '', 'ZZ Bank Ltd', 'INE000ZC0004', '10', '900', '950', '9,500'],                               // line 8: names nobody
  ['Total', '', '', '', '', '', '', '1,42,500'],                                                     // line 9
]));

suite(async t => {
  await t.home();
  let first;

  const upload = async () => {
    await t.eval(()=>{ MA.picked = {}; MA.result = null; MA.uploadType = 'platform'; MA.createClients = true; maNav('upload'); });
    await t.wait(300);
    await t.page.setInputFiles('input[data-ma="stocks-motilal-oswal:aum"]', FILE);
    await t.wait(100);
    await t.page.click('#maUploadAll');
    for(let i = 0; i < 80; i++){ await t.wait(250); if(await t.eval(()=>!MA.busy && !!MA.result)) break; }
    const r = await t.eval(()=>({modal: (document.getElementById('maResultTable') || {}).innerText || '',
      compare: (MA.result.results.find(x=>x.job.kind === 'aum') || {}).compare || null}));
    await t.eval(()=>closeModal());
    return r;
  };
  const detail = id => t.eval(async (id)=>((await sget('importReport.' + id, [])) || []).map(l=>({n: l.n, status: l.status, reason: l.reason, diffs: l.diffs, missing: l.missing})), id);

  await t.step('after the upload, every line of the file is accounted for, from what was really saved', async () => {
    const r = await upload();
    first = r.compare;
    if(!first) throw new Error('no comparison was made');
    const lines = await detail(first.id);
    const at = n => lines.find(l=>l.n === n) || {};
    const c = first.counts;
    const problems = [];
    if(at(3).status !== 'imported') problems.push('line 3 ' + at(3).status);
    if(at(4).status !== 'imported') problems.push('line 4 ' + at(4).status);
    if(at(5).status !== 'duplicate' || !/line 3/.test(at(5).reason)) problems.push('line 5 ' + at(5).status + ' ' + at(5).reason);
    if(at(6).status !== 'skipped') problems.push('line 6 (blank) ' + at(6).status);
    if(at(9).status !== 'skipped' || !/Total/.test(at(9).reason)) problems.push('line 9 (total) ' + at(9).status + ' ' + at(9).reason);
    if(at(7).status !== 'failed' || !/no current value/.test(at(7).reason)) problems.push('line 7 (no value) ' + at(7).status + ' ' + at(7).reason);
    if(!/imported|kept/.test(at(8).status) || !(at(8).missing || []).some(m=>/not matched to a BOSS client/.test(m))) problems.push('line 8 (names nobody) ' + at(8).status + ' ' + JSON.stringify(at(8).missing));
    if(problems.length) throw new Error(problems.join(' | ') + ' :: ' + JSON.stringify(lines));
    if(c.duplicates !== 1 || c.skipped !== 2 || c.failed !== 1) throw new Error('counts: ' + JSON.stringify(c));
    if(!/Compared with BOSS/i.test(r.modal) || !/not imported/.test(r.modal)) throw new Error('the upload result does not show the comparison: ' + r.modal.replace(/\s+/g, ' '));
    return JSON.stringify(c) + ' — ' + first.status;
  });

  await t.step('the history lists it, filters by platform, status and discrepancy type, and opens the lines', async () => {
    const r = await t.eval(async ()=>{
      window._impMapSection = 'reports'; navigate('settings', 'importmaps');
      await new Promise(z=>setTimeout(z, 200));
      const all = document.getElementById('content').innerText;
      icFilter.type = 'duplicates'; render(); const dup = document.getElementById('content').innerText;
      icFilter.type = ''; icFilter.status = 'Matched'; render(); const matched = document.getElementById('content').innerText;
      icFilter.status = ''; icFilter.platform = 'Nobody Platform'; render(); const none = document.getElementById('content').innerText;
      icFilter.platform = ''; render();
      const view = [...document.querySelectorAll('#content button')].find(b=>b.textContent.trim() === 'View');
      if(!view) return {err: document.getElementById('content').innerText.replace(/\s+/g, ' ').slice(0, 600)};
      view.click(); await new Promise(z=>setTimeout(z, 300));
      const modal = document.getElementById('modalBody').innerText;
      closeModal();
      return {all, dup, matched, none, modal};
    });
    if(r.err) throw new Error('no View button: ' + r.err);
    if(!/MO_Holdings_Compare\.xlsx/.test(r.all)) throw new Error('the history does not list the upload');
    if(!/MO_Holdings_Compare/.test(r.dup)) throw new Error('the duplicates filter lost it');
    if(/MO_Holdings_Compare/.test(r.matched)) throw new Error('a run with discrepancies shows under Matched');
    if(/MO_Holdings_Compare/.test(r.none)) throw new Error('the platform filter did not narrow');
    for(const want of ['Records in the file', 'Not imported', 'Duplicates', 'Skipped', 'no current value'])
      if(r.modal.toLowerCase().indexOf(want.toLowerCase()) < 0) throw new Error('the detail does not show "' + want + '"');
    return 'listed; filters narrow; detail shows the counts and the failed line with its reason';
  });

  await t.step('the discrepancy report downloads as a workbook with every line', async () => {
    const [dl] = await Promise.all([t.page.waitForEvent('download', {timeout: 15000}),
      t.eval(id=>icDownload(id), first.id)]);
    const p = await dl.path();
    const size = fs.statSync(p).size;
    if(!/\.xlsx$/.test(dl.suggestedFilename()) || size < 2000) throw new Error('download: ' + dl.suggestedFilename() + ' ' + size);
    return dl.suggestedFilename() + ', ' + size + ' bytes';
  });

  await t.step('the same file again: nothing is re-saved, and the comparison says the lines are already in BOSS', async () => {
    const r = await upload();
    const c = r.compare;
    if(!c) throw new Error('no comparison for the repeat');
    const lines = await detail(c.id);
    const kept = lines.filter(l=>l.status === 'kept' || (l.status === 'duplicate')).length;
    if(c.outcome !== 'skipped') throw new Error('outcome ' + c.outcome);
    if(lines.find(l=>l.n === 3).status !== 'kept') throw new Error('line 3 is ' + lines.find(l=>l.n === 3).status);
    return c.status + ' — ' + kept + ' lines found already in BOSS';
  });

  await t.step('a field BOSS holds differently from the file is named, with both values', async () => {
    await t.eval(b64=>{ window._zzFile = b64; }, fs.readFileSync(FILE).toString('base64'));
    const r = await t.eval(async ()=>{
      /* BOSS's copy of line 4 says 13,500, the file says 13,000. */
      const up = maUploads().find(u=>u.file === 'MO_Holdings_Compare.xlsx');
      const rows = maRowsOf(up);
      const row = rows.find(x=>x.isin === 'INE000ZC0002');
      const was = row.current_value; row.current_value = 13500;
      const file = new File([await (await fetch('data:application/octet-stream;base64,' + window._zzFile)).arrayBuffer()], 'MO_Holdings_Compare.xlsx');
      const out = await icCompare({file, kind: 'aum', platform: up.platform, product: up.product, uploadType: 'platform'}, null, {upload: up, rowsCount: rows.length}, 'ok', '');
      row.current_value = was;
      const l4 = out.lines.find(l=>l.n === 4);
      return {status: l4.status, diffs: l4.diffs, mismatched: out.summary.counts.mismatched};
    });
    const d = (r.diffs || []).find(x=>x.field === 'current_value');
    if(!d || Number(d.file) !== 13000 || Number(d.boss) !== 13500) throw new Error('the difference is not named: ' + JSON.stringify(r));
    if(r.mismatched < 1) throw new Error('not counted as a mismatch');
    return 'Current value: file 13,000, BOSS 13,500 — counted as mismatched';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
