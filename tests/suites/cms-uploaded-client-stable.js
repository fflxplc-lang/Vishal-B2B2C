/* OPENING A CLIENT THAT CAME FROM AN UPLOAD DOES NOT FLICKER, RELOAD OR EAT CLICKS.

   The firm reported that clicking an uploaded client in CMS made the whole
   site blink, then hard-refresh, and that clicks had to be repeated. That is
   the shape of a redraw loop: drawing the page writes something, the write
   redraws the page, and so on — every redraw replaces the whole screen, so a
   click lands on a button that is gone. This opens such a client and counts
   what happens while nobody touches anything. */
const {suite} = require('../lib/harness');
const {xlsx} = require('../lib/xlsx-write');
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bossup-'));
const FILE = path.join(DIR, 'MO_Holdings.xlsx');
fs.writeFileSync(FILE, xlsx('Holdings', [
  ['Motilal Oswal — Holdings as on 31-Mar-2026'],
  ['Client Name', 'PAN', 'Stock Name', 'ISIN', 'Qty', 'Avg Price', 'LTP', 'Market Value'],
  ['ZZ Uploaded Kapoor', 'ZZUPK1234K', 'ZZ Infra Ltd', 'INE000ZZ0001', '100', '500', '600', '60,000'],
  ['ZZ Uploaded Kapoor', 'ZZUPK1234K', 'ZZ Power Ltd', 'INE000ZZ0002', '50', '200', '260', '13,000'],
]));

suite(async t => {
  await t.home();
  let id;

  await t.step('a client made by a platform upload', async () => {
    await t.eval(()=>{ MA.picked = {}; MA.result = null; MA.uploadType = 'platform'; MA.createClients = true; maNav('upload'); });
    await t.wait(300);
    await t.page.setInputFiles('input[data-ma="stocks-motilal-oswal:aum"]', FILE);
    await t.wait(100);
    await t.page.click('#maUploadAll');
    for(let i = 0; i < 60; i++){ await t.wait(250); if(await t.eval(()=>!MA.busy && !!MA.result)) break; }
    await t.eval(()=>closeModal());
    id = await t.eval(()=>(DB.clients.find(c=>c.cmsName === 'ZZ Uploaded Kapoor') || {}).id);
    if(!id) throw new Error('the upload made no client');
    return id;
  });

  await t.step('opening it, then waiting: no stream of saves and redraws', async () => {
    const r = await t.eval(async (id)=>{
      const saves = [], draws = [];
      const realSet = window.sset, realRender = window.render;
      window.sset = function(k){ saves.push(k + ' @ ' + ((new Error().stack || '').split('\n')[2] || '').trim()); return realSet.apply(this, arguments); };
      window.render = function(){ draws.push(1); return realRender.apply(this, arguments); };
      let rootSwaps = 0;
      const mo = new MutationObserver(m=>m.forEach(x=>{ if(x.target.id === 'root') rootSwaps++; }));
      mo.observe(document.getElementById('root'), {childList: true});
      try {
        navigate('cms', id);
        await new Promise(z=>setTimeout(z, 6000));
      } finally { window.sset = realSet; window.render = realRender; mo.disconnect(); }
      return {saves, draws: draws.length, rootSwaps};
    }, id);
    if(r.saves.length > 2 || r.draws > 3) throw new Error(r.draws + ' redraws and ' + r.saves.length + ' saves in 6 seconds: ' + r.saves.slice(0, 8).join(' | '));
    return r.draws + ' redraw(s), ' + r.saves.length + ' save(s), root swapped ' + r.rootSwaps + ' time(s)';
  });

  await t.step('each tab opens on the first click', async () => {
    const r = await t.eval(async ()=>{
      const out = [];
      const tabs = ()=>[...document.querySelectorAll('.prof-tabs .tab, .tabs .tab, [data-tab]')];
      const names = tabs().map(x=>x.textContent.trim()).filter(Boolean).slice(0, 10);
      for(const name of names){
        const el = tabs().find(x=>x.textContent.trim() === name);
        if(!el) { out.push(name + ': gone'); continue; }
        el.click();
        await new Promise(z=>setTimeout(z, 250));
        const on = tabs().find(x=>x.textContent.trim() === name);
        out.push(name + ': ' + (on && /active|on|selected/.test(on.className) ? 'open' : 'not open'));
      }
      return out;
    });
    const bad = r.filter(x=>!/open$/.test(x) || /not open/.test(x));
    if(bad.length) throw new Error(bad.join(', '));
    return r.length + ' tabs, each opened on one click';
  });

  /* What other people do while this page is open. Each write below goes to the
     server as another tab would (its own X-Client-Id), so the live layer here
     hears about it the way it hears about a colleague's work. */
  const otherTabWrites = (keys) => t.eval(async (keys)=>{
    for(const k of keys){
      const cur = await (await fetch('/api/storage/' + k, {headers: apiHeaders()})).json().catch(()=>({}));
      let list = []; try { list = JSON.parse(cur.value || '[]'); } catch(e){}
      if(!Array.isArray(list)) list = [];
      list.push({id: 'ZZ-' + Math.random().toString(36).slice(2), at: new Date().toISOString(), note: 'from another tab'});
      await fetch('/api/storage/' + k, {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'another-tab'}),
        body: JSON.stringify({value: JSON.stringify(list)})});
    }
  }, keys);
  const spyReloads = () => t.eval(()=>{
    window._zzLoads = 0; window._zzDraws = 0;
    if(!window._zzWrapped){
      window._zzWrapped = true;
      const realLoad = window.loadAll, realRender = window.render;
      window.loadAll = function(){ window._zzLoads++; return realLoad.apply(this, arguments); };
      window.render = function(){ window._zzDraws++; return realRender.apply(this, arguments); };
    }
  });
  const reloads = () => t.eval(()=>({loads: window._zzLoads, draws: window._zzDraws}));

  await t.step('a colleague saving their DJT, and the connector log being written, do not reload this page', async () => {
    await t.eval((id)=>navigate('cms', id), id);
    await t.wait(300);
    await spyReloads();
    await otherTabWrites(['djtEntries', 'apiReqLog', 'apiSyncRuns', 'settingsAudit', 'accessRequests', 'complianceItems']);
    await t.wait(2500);
    const r = await reloads();
    if(r.loads) throw new Error('the whole database was re-read ' + r.loads + ' time(s)');
    /* One redraw per change at most. This used to be over 150 in the same
       time: the LEXI card asked for live NAVs on every redraw, and redrew on
       every answer, for funds the NAV list never had. */
    if(r.draws > 8) throw new Error(r.draws + ' redraws for six writes by others — the page is redrawing itself in a loop');
    const arrived = await t.eval(()=>['djtEntries', 'accessRequests', 'complianceItems'].filter(k=>(DB[k] || []).some(x=>x && x.note === 'from another tab')));
    if(arrived.length !== 3) throw new Error('the colleagues\' changes did not reach this page: only ' + arrived.join(', '));
    return 'no full re-read; their changes arrived; ' + r.draws + ' redraw(s) for six writes by others';
  });

  await t.step('changes that arrive while a dialog is open are applied without a full re-read when it closes', async () => {
    await spyReloads();
    await t.eval(()=>openModal('ZZ busy', '<p>busy</p>', ''));
    await otherTabWrites(['djtEntries', 'leads', 'tasks']);
    await t.wait(1200);
    await t.eval(()=>closeModal());
    await t.wait(2500);
    const r = await reloads();
    if(r.loads) throw new Error('closing the dialog re-read the whole database ' + r.loads + ' time(s)');
    return 'queued while busy, applied store by store after';
  });

  await t.step('a store this page does not hold is left alone, not answered with a full re-read', async () => {
    await spyReloads();
    await otherTabWrites(['zzSomethingNew']);
    await t.wait(2000);
    const r = await reloads();
    if(r.loads) throw new Error('an unknown store re-read everything');
    return 'left alone';
  });

  await t.step('live NAVs are asked for once, not on every redraw, when the NAV list cannot answer', async () => {
    const r = await t.eval(async (id)=>{
      let calls = 0, draws = 0;
      const realFetch = window.fetch, realRender = window.render;
      /* The firm's server today: the AMFI list cannot be read, and says so at once. */
      window.fetch = function(url, o){
        if(String(url).indexOf('/api/market/nav') >= 0){ calls++; return Promise.resolve(new Response(JSON.stringify({ok: false, message: 'the NAV file had no schemes in it'}), {headers: {'Content-Type': 'application/json'}})); }
        return realFetch.apply(this, arguments);
      };
      window.render = function(){ draws++; return realRender.apply(this, arguments); };
      try {
        lexiNav.at = 0; lexiNav.map = {}; lexiNav.asked = {}; lexiNav.error = '';
        navigate('cms', id);
        await new Promise(z=>setTimeout(z, 4000));
      } finally { window.fetch = realFetch; window.render = realRender; }
      return {calls, draws, error: lexiNav.error};
    }, id);
    if(r.calls > 2 || r.draws > 4) throw new Error(r.calls + ' NAV requests and ' + r.draws + ' redraws in 4 seconds — the page is asking in a loop');
    return r.calls + ' NAV request(s), ' + r.draws + ' redraw(s); says "' + r.error + '"';
  });
});
