/* SOMEBODY ELSE'S ACTIVITY NEVER ERASES SOMEBODY'S ONGOING WORK (changes 14-11-2026).

   · A change made here and not saved yet survives other people's saves
     arriving: they are merged in field by field, not poured over it.
   · A save that does not reach the server is kept, retried, and sent again
     after a refresh; the corner says Sync failed until it has gone.
   · Two people changing the same field: the second sees the first's value
     and can keep theirs or put it back.
   · What is typed into a form is kept as a draft — offered back after a
     refresh or a dialog closed without saving, never on another record's
     form, and gone once saved.
   · The corner says Saving… / Saved / Unsaved changes. */
const {suite} = require('../lib/harness');
const signIn = require('../lib/signin');

suite(async t => {
  let ids;
  const srv = (key, id) => t.eval(async ([key, id])=>{
    const all = JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value || '[]');
    return all.find(x=>x && x.id === id) || null; }, [key, id]);
  const colleague = (key, id, set) => t.eval(async ([key, id, set])=>{
    const all = JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value || '[]');
    const r = all.find(x=>x && x.id === id); Object.assign(r, set);
    await fetch('/api/storage/' + key, {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'colleague'}),
      body: JSON.stringify({patch: {kind: 'rows', adds: [], changes: [{id, set}], removed: []}})}); }, [key, id, set]);
  const status = () => t.eval(()=>{ const el = document.getElementById('syncStatus'); return el && !el.hidden ? el.getAttribute('data-state') + ': ' + el.innerText : 'none'; });

  await t.step('two clients to work on', async () => {
    ids = await t.eval(async ()=>{
      const mk = n=>{ const c = {id: uid('CMS'), cmsName: n, mobile: '98765' + String(Math.floor(Math.random() * 1e5)).padStart(5, '0'), rmName: currentUser, createdAt: new Date().toISOString(), createdBy: currentUser};
        initState('CMS', c); DB.clients.push(c); return c.id; };
      const a = mk('ZZ Work One'), b = mk('ZZ Work Two'); await save('clients'); return {a, b};
    });
    return 'set up';
  });

  await t.step('a change not saved yet survives a colleague\'s save arriving, and goes out with the next save', async () => {
    await t.eval((id)=>{ DB.clients.find(x=>x.id === id).city = 'ZZ Unsaved City'; }, ids.a);         // changed here, not saved
    await colleague('clients', ids.a, {email: 'zz.colleague@finowise.test'});
    await t.eval(async ()=>{ await liveRefresh(['clients']); });
    const local = await t.eval((id)=>{ const c = DB.clients.find(x=>x.id === id); return {city: c.city, email: c.email}; }, ids.a);
    if(local.city !== 'ZZ Unsaved City') throw new Error('the unsaved change was wiped by the refresh');
    if(local.email !== 'zz.colleague@finowise.test') throw new Error('the colleague\'s change did not arrive');
    await t.eval(async ()=>{ await save('clients'); });
    const s = await srv('clients', ids.a);
    if(s.city !== 'ZZ Unsaved City' || s.email !== 'zz.colleague@finowise.test') throw new Error('server: ' + JSON.stringify({city: s.city, email: s.email}));
    return 'kept here, merged in, both on the server';
  });

  await t.step('the corner says Unsaved changes while typing, and Saved after', async () => {
    await t.eval((id)=>openClientForm(id), ids.b);
    await t.wait(300);
    const field = await t.eval(()=>{ const el = [...document.querySelectorAll('#modalBody input[type=text], #modalBody input:not([type])')].find(x=>x.id && !x.disabled && !x.readOnly); return el ? el.id : ''; });
    if(!field) throw new Error('no text field on the client form');
    await t.page.fill('#' + field, 'ZZ typed');
    await t.wait(300);
    const typing = await status();
    if(!/^unsaved/.test(typing)) throw new Error('while typing the corner says ' + typing);
    await t.eval(()=>closeModal());
    await t.eval(async (id)=>{ DB.clients.find(x=>x.id === id).zzNote = 'saved'; await save('clients'); }, ids.b);
    const after = await status();
    if(!/^(saved|none)/.test(after)) throw new Error('after a save the corner says ' + after);
    return 'typing: ' + typing + ' · after: ' + after;
  });

  await t.step('a dialog closed without saving offers the typing back — on that client only', async () => {
    await t.eval((id)=>openClientForm(id), ids.b);
    await t.wait(400);
    const offered = await t.eval(()=>!!document.getElementById('draftBarm'));
    if(!offered) throw new Error('the draft was not offered on reopening');
    await t.eval(()=>draftRestore('m'));
    const field = await t.eval(()=>{ const el = [...document.querySelectorAll('#modalBody input')].find(x=>x.value === 'ZZ typed'); return el ? el.id : ''; });
    if(!field) throw new Error('restoring did not put the typing back');
    await t.eval(()=>closeModal());
    await t.eval((id)=>openClientForm(id), ids.a);
    await t.wait(400);
    const wrong = await t.eval(()=>!!document.getElementById('draftBarm'));
    await t.eval(()=>closeModal());
    if(wrong) throw new Error('client B\'s typing was offered on client A\'s form');
    return 'offered and restored on B; not offered on A';
  });

  await t.step('the draft survives a refresh, and a save clears it', async () => {
    await t.home();
    await t.eval((id)=>openClientForm(id), ids.b);
    await t.wait(400);
    const offered = await t.eval(()=>!!document.getElementById('draftBarm'));
    if(!offered) throw new Error('the draft did not survive the refresh');
    await t.eval(()=>{ draftRestore('m'); });
    /* Saved: the form's own save, then closed. */
    await t.eval(async (id)=>{ DB.clients.find(x=>x.id === id).zzNote2 = 'x'; await save('clients'); closeModal(); }, ids.b);
    await t.eval((id)=>openClientForm(id), ids.b);
    await t.wait(400);
    const again = await t.eval(()=>!!document.getElementById('draftBarm'));
    await t.eval(()=>closeModal());
    if(again) throw new Error('the draft was offered again after saving');
    return 'offered after the refresh; gone once saved';
  });

  await t.step('a save that cannot reach the server is kept, shown as Sync failed, and retried', async () => {
    t.expectConsole(/storage set failed/, /network down/, /Failed to fetch/);
    const r = await t.eval(async (id)=>{
      const real = window.fetch;
      window.fetch = function(u, o){ if(/\/api\/storage\/clients$/.test(String(u)) && o && o.method === 'PUT') return Promise.reject(new TypeError('network down')); return real.apply(this, arguments); };
      DB.clients.find(x=>x.id === id).profession = 'ZZ Offline Edit';
      await save('clients');
      const st = document.getElementById('syncStatus').getAttribute('data-state');
      const box = JSON.parse(localStorage.getItem('crm_outbox') || '[]').length;
      window.fetch = real;
      await syncRetryAll();
      return {st, box, after: document.getElementById('syncStatus').getAttribute('data-state'), boxAfter: JSON.parse(localStorage.getItem('crm_outbox') || '[]').length};
    }, ids.a);
    if(r.st !== 'failed') throw new Error('the corner did not say Sync failed: ' + r.st);
    if(!r.box) throw new Error('the unsent change was not kept in the browser');
    const s = await srv('clients', ids.a);
    if(s.profession !== 'ZZ Offline Edit') throw new Error('the retry did not deliver it');
    if(r.after === 'failed' || r.boxAfter) throw new Error('still marked failed after it went: ' + JSON.stringify(r));
    return 'Sync failed shown, kept, retried and delivered';
  });

  await t.step('an unsent change is sent after the page is closed and opened again', async () => {
    t.expectConsole(/storage set failed/, /network down/, /Failed to fetch/);
    await t.eval(async (id)=>{
      const real = window.fetch;
      window.fetch = function(u, o){ if(/\/api\/storage\/clients$/.test(String(u)) && o && o.method === 'PUT') return Promise.reject(new TypeError('network down')); return real.apply(this, arguments); };
      DB.clients.find(x=>x.id === id).designation = 'ZZ Sent After Reload';
      await save('clients');
      clearTimeout(sync.timer);
    }, ids.a);
    await t.home();                       // a fresh page; the change never reached the server
    await t.wait(1500);
    const s = await srv('clients', ids.a);
    if(s.designation !== 'ZZ Sent After Reload') throw new Error('the unsent change was lost with the page');
    return 'delivered by the reopened page';
  });

  await t.step('two people change the same field: the second is shown the first\'s value, and can put it back', async () => {
    await t.eval(async ()=>{ await liveRefresh(['clients']); });
    await t.eval((id)=>{ window._zzBase = JSON.stringify(DB.clients); }, ids.a);
    await colleague('clients', ids.a, {annualIncome: '12 lakh'});            // the first person
    const r = await t.eval(async (id)=>{
      storeBaseSet('clients', window._zzBase);                                 // this tab read it before that
      const c = DB.clients.find(x=>x.id === id); c.annualIncome = '15 lakh';
      await save('clients');
      return {n: sync.conflicts.length, c: sync.conflicts[0] || null, state: document.getElementById('syncStatus').getAttribute('data-state')};
    }, ids.a);
    if(!r.n || r.c.field !== 'annualIncome' || r.c.theirs !== '12 lakh' || r.c.mine !== '15 lakh') throw new Error('no conflict reported: ' + JSON.stringify(r));
    if(r.state !== 'conflict') throw new Error('the corner did not offer a review: ' + r.state);
    await t.eval(()=>syncReview()); await t.wait(200);
    const table = await t.eval(()=>(document.getElementById('syncConflictTable') || {}).innerText || '');
    if(!/12 lakh/.test(table) || !/15 lakh/.test(table)) throw new Error('the review does not show both: ' + table);
    await t.eval(async ()=>{ await syncResolve(0, true); });
    const s = await srv('clients', ids.a);
    if(s.annualIncome !== '12 lakh') throw new Error('Use theirs did not put it back: ' + s.annualIncome);
    return 'clash shown (15 lakh saved, they had 12 lakh); Use theirs restored 12 lakh';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
