/* THE CLIENT'S PORTFOLIO, EDITED BY HAND — AND EVERYWHERE FOLLOWS.

   On the client's Portfolio tab: add an investment on a platform, correct
   it, add a SIP, remove a holding, and correct one that came from an
   upload. After each change the client's book AUM and SIP, the platform
   lines the dashboards and MIS read (platformHoldings / platformSips), and
   the scheme rows the review report reads (maState) all say the same thing.
   Nothing earlier is overwritten: each change is a version of its own. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  let cid;

  const book = () => t.eval((cid)=>{
    maInvalidate();
    const c = DB.clients.find(x=>x.id === cid);
    const ph = DB.platformHoldings.filter(h=>h.clientId === cid && !h.deletedAt);
    const ps = DB.platformSips.filter(h=>h.clientId === cid && !h.deletedAt);
    const st = maState();
    const rows = st.holdings.filter(r=>r._c.ck === 'c:' + cid).map(r=>({name: r.security_name, plat: r.platform, prod: r.product, cur: r.current_value, inv: r.invested}));
    const sips = st.sips.filter(r=>r._c.ck === 'c:' + cid).map(r=>({name: r.security_name, amt: r.sip_amount, m: r.monthly_amount, live: r.live}));
    return {aum: clientBookAum(c), sip: clientBookSip(c), platformLines: ph.reduce((n, h)=>n + Number(h.current || 0), 0), platformSips: ps.length, rows, sips};
  }, cid);
  const fill = (vals) => t.eval((vals)=>{ Object.entries(vals).forEach(([id, v])=>{ const el = document.getElementById(id); el.value = v; }); }, vals);

  await t.step('a client with nothing on the books has + Add investment on their Portfolio tab', async () => {
    cid = await t.eval(async ()=>{
      const c = {id: uid('CMS'), cmsName: 'ZZ Portfolio Edit', pan: 'ZZPED1234E', rmName: currentUser, createdAt: new Date().toISOString(), createdBy: currentUser};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      return c.id;
    });
    const r = await t.eval(async (cid)=>{
      window._clientTab = 'portfolio'; navigate('cms', cid);
      await new Promise(z=>setTimeout(z, 200));
      return !![...document.querySelectorAll('#content button')].find(b=>/Add investment/.test(b.textContent));
    }, cid);
    if(!r) throw new Error('no + Add investment button on the Portfolio tab');
    return 'button there';
  });

  await t.step('adding an NJ mutual fund: the AUM, the platform lines and the review rows all carry it', async () => {
    await t.eval((cid)=>maOpenEdit(cid, 'aum', ''), cid);
    await fill({maePlatform: 'NJ', maeProduct: 'MF', maeName: 'ZZ Bluechip Fund', maeIsin: 'INF000ZZ0001', maeQty: '100', maeInv: '50,000', maeCur: '62000'});
    await t.eval(async ()=>{ await maSaveEdit(); });
    await t.wait(300);
    const b = await book();
    if(b.aum !== 62000 || b.platformLines !== 62000) throw new Error('AUM ' + b.aum + ', platform lines ' + b.platformLines);
    if(!b.rows.some(r=>r.name === 'ZZ Bluechip Fund' && r.cur === 62000 && r.inv === 50000)) throw new Error('not in the scheme rows: ' + JSON.stringify(b.rows));
    const shown = await t.eval(async (cid)=>{ window._clientTab = 'portfolio'; navigate('cms', cid); await new Promise(z=>setTimeout(z, 200)); return document.getElementById('content').innerText; }, cid);
    if(!/ZZ Bluechip Fund/.test(shown) || !/entered by hand/.test(shown)) throw new Error('the Portfolio tab does not show it as entered by hand');
    return 'AUM 62,000 on the book, the platform lines and the scheme rows; shown as entered by hand';
  });

  await t.step('correcting it: the new figure everywhere, and the first version kept', async () => {
    const r = await t.eval(async (cid)=>{
      maInvalidate();
      const row = maState().holdings.find(x=>x._c.ck === 'c:' + cid && x.security_name === 'ZZ Bluechip Fund');
      maOpenEdit(cid, 'aum', maRowRef(row));
      await new Promise(z=>setTimeout(z, 100));
      const pre = document.getElementById('maeCur').value;
      document.getElementById('maeCur').value = '70000';
      await maSaveEdit();
      await new Promise(z=>setTimeout(z, 300));
      return {pre, versions: maUploads().filter(u=>u.clientId === cid && u.manual).length,
        audit: DB.auditLog.some(a=>a.recordId === cid && a.action === 'Portfolio Holding Corrected' && (a.details || []).some(d=>d.oldValue === '62000' && d.newValue === '70000'))};
    }, cid);
    const b = await book();
    if(r.pre !== '62000') throw new Error('the form did not open with the figure: ' + r.pre);
    if(b.aum !== 70000 || b.platformLines !== 70000) throw new Error('AUM ' + b.aum + ', platform lines ' + b.platformLines);
    if(b.rows.filter(x=>x.name === 'ZZ Bluechip Fund').length !== 1) throw new Error('the holding is counted twice: ' + JSON.stringify(b.rows));
    if(r.versions !== 2 || !r.audit) throw new Error('versions ' + r.versions + ', audited ' + r.audit);
    return '62,000 → 70,000 everywhere, counted once; both versions kept; audited';
  });

  await t.step('adding a SIP: the client\'s SIP follows', async () => {
    await t.eval((cid)=>maOpenEdit(cid, 'sip', ''), cid);
    await fill({maePlatform: 'NJ', maeProduct: 'MF', maeName: 'ZZ Bluechip Fund', maeSip: '5000', maeFreq: 'Monthly', maeStatus: 'Active'});
    await t.eval(async ()=>{ await maSaveEdit(); });
    await t.wait(300);
    const b = await book();
    if(b.sip !== 5000 || !b.sips.some(s=>s.amt === 5000 && s.m === 5000 && s.live)) throw new Error('SIP ' + b.sip + ' ' + JSON.stringify(b.sips));
    return 'SIP 5,000 a month, live, on the book';
  });

  await t.step('an investment on another platform and category adds to the AUM', async () => {
    await t.eval((cid)=>maOpenEdit(cid, 'aum', ''), cid);
    await fill({maePlatform: 'Motilal Oswal', maeProduct: 'Stocks', maeName: 'ZZ Infra Ltd', maeQty: '10', maeInv: '9000', maeCur: '11000'});
    await t.eval(async ()=>{ await maSaveEdit(); });
    await t.wait(300);
    const b = await book();
    if(b.aum !== 81000) throw new Error('AUM ' + b.aum);
    return 'NJ MF 70,000 + Motilal Oswal Stocks 11,000 = 81,000';
  });

  await t.step('removing a holding takes it out everywhere, and the removal is recorded, not erased', async () => {
    const r = await t.eval(async (cid)=>{
      maInvalidate();
      const row = maState().holdings.find(x=>x._c.ck === 'c:' + cid && x.security_name === 'ZZ Infra Ltd');
      await maRemoveHolding(cid, maRowRef(row));
      await new Promise(z=>setTimeout(z, 300));
      return {audit: DB.auditLog.some(a=>a.recordId === cid && a.action === 'Portfolio Holding Removed'),
        stillOnFile: maUploads().some(u=>u.clientId === cid && maRowsOf(u).some(x=>x.security_name === 'ZZ Infra Ltd' && !x.removed))};
    }, cid);
    const b = await book();
    if(b.aum !== 70000 || b.rows.some(x=>x.name === 'ZZ Infra Ltd')) throw new Error('AUM ' + b.aum + ' rows ' + JSON.stringify(b.rows));
    if(!r.audit || !r.stillOnFile) throw new Error('audit ' + r.audit + ', the original still on file ' + r.stillOnFile);
    return 'gone from AUM (70,000) and the rows; the entry stays on file; audited';
  });

  await t.step('a holding from an upload is corrected by hand; the uploaded row stays underneath', async () => {
    const r = await t.eval(async (cid)=>{
      /* As a platform upload would leave it. */
      await maCreateUpload({uploadType: 'client', clientName: 'ZZ Portfolio Edit', clientId: cid, platform: 'Anand Rathi', product: 'PMS', kind: 'aum',
        file: 'AR_PMS.xlsx', rows: [{client_name: 'ZZ Portfolio Edit', security_name: 'ZZ Growth PMS', invested: 500000, current_value: 520000}]});
      await maSyncCrm({});
      maInvalidate();
      const before = clientBookAum(DB.clients.find(x=>x.id === cid));
      const row = maState().holdings.find(x=>x._c.ck === 'c:' + cid && x.security_name === 'ZZ Growth PMS');
      maOpenEdit(cid, 'aum', maRowRef(row));
      await new Promise(z=>setTimeout(z, 100));
      document.getElementById('maeCur').value = '540000';
      await maSaveEdit();
      await new Promise(z=>setTimeout(z, 300));
      maInvalidate();
      const after = clientBookAum(DB.clients.find(x=>x.id === cid));
      const uploaded = maUploads().find(u=>u.file === 'AR_PMS.xlsx');
      return {before, after, uploadedKept: !!uploaded && maRowsOf(uploaded)[0].current_value === 520000};
    }, cid);
    if(r.before !== 590000 || r.after !== 610000) throw new Error('AUM before ' + r.before + ', after ' + r.after);
    if(!r.uploadedKept) throw new Error('the uploaded row was overwritten');
    return 'PMS 5,20,000 → 5,40,000 (AUM 5,90,000 → 6,10,000); the upload still holds 5,20,000';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
