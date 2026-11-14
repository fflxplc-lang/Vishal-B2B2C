/* A SAVE NEVER DELETES A RECORD SOMEBODY ELSE JUST MADE.

   "I created a lead and it was deleted automatically." A save sends the
   whole list the tab holds; a tab a moment behind (a colleague's new lead
   not read yet), or one whose last read failed (taken for empty), sent a
   list without it, and the server replaced the store with that. The server
   now keeps any record the save did not say it removed. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  const otherTab = (key, mutate) => t.eval(async ({key, mutate})=>{
    const cur = await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json();
    const list = JSON.parse(cur.value || '[]');
    eval(mutate)(list);
    const res = await fetch('/api/storage/' + key, {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'colleague'}),
      body: JSON.stringify({value: JSON.stringify(list)})});
    return res.status;
  }, {key, mutate: String(mutate)});
  const serverIds = key => t.eval(async key=>JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value).map(r=>r.id), key);

  await t.step('a colleague\'s new lead survives a save from a tab that had not read it yet', async () => {
    const stale = await t.eval(()=>{ window._zzStale = JSON.parse(JSON.stringify(DB.leads)); window._zzBase = JSON.stringify(DB.leads); return DB.leads.length; });
    await otherTab('leads', `list=>list.push({id:'LMS-ZZCOLLEAGUE', firstName:'ZZ Colleague', lastName:'Lead', createdAt:new Date().toISOString()})`);
    await t.wait(1500);
    const r = await t.eval(async ()=>{
      /* This tab, a moment behind: it never saw the colleague's lead. */
      DB.leads = window._zzStale; storeBaseSet('leads', window._zzBase);
      const mine = {id: uid('LMS'), firstName: 'ZZ Mine', lastName: 'Lead', assignedTo: currentUser, createdAt: new Date().toISOString()};
      initState('LMS', mine); DB.leads.push(mine); await save('leads');
      await new Promise(z=>setTimeout(z, 300));
      await liveRefresh(['leads']);        // and it catches up on its next read
      return {mine: mine.id, local: DB.leads.some(l=>l.id === 'LMS-ZZCOLLEAGUE')};
    });
    const ids = await serverIds('leads');
    if(!ids.includes('LMS-ZZCOLLEAGUE')) throw new Error('the colleague\'s lead was deleted by the stale save');
    if(!ids.includes(r.mine)) throw new Error('this tab\'s lead was not saved');
    if(!r.local) throw new Error('this tab was not given the colleague\'s lead back');
    return 'both leads on the server (' + (ids.length) + ' leads, was ' + stale + '); this tab caught up';
  });

  await t.step('a read that fails never turns into a save that empties the store', async () => {
    const before = (await serverIds('leads')).length;
    t.expectConsole(/storage get failed/, /network down/);   // the failures are the point
    const r = await t.eval(async ()=>{
      const real = window.fetch;
      window.fetch = function(u, o){ if(/\/api\/storage\/leads$/.test(String(u)) && !(o && o.method)) return Promise.reject(new Error('network down')); return real.apply(this, arguments); };
      let liveKept, emptied;
      try {
        const had = DB.leads.length;
        await liveRefresh(['leads']);                              // the live layer: failure leaves the screen alone
        liveKept = DB.leads.length === had;
        DB.leads = await sget('leads', []);                        // the old way: a failure reads as empty...
        emptied = DB.leads.length;
      } finally { window.fetch = real; }
      const one = {id: uid('LMS'), firstName: 'ZZ After', lastName: 'Failure', createdAt: new Date().toISOString()};
      DB.leads.push(one); await save('leads');                     // ...and the next save sends back almost nothing
      return {liveKept, emptied, one: one.id};
    });
    const ids = await serverIds('leads');
    if(!r.liveKept) throw new Error('a failed live read replaced the leads on screen');
    if(ids.length < before + 1 || !ids.includes(r.one)) throw new Error('the save after a failed read deleted leads: ' + ids.length + ' left of ' + before);
    return 'screen kept on a failed read; the save after it deleted nothing (' + ids.length + ' leads)';
  });

  await t.step('a record this tab really removes is removed', async () => {
    const r = await t.eval(async ()=>{
      DB.leads = await sget('leads', []);
      const gone = DB.leads.find(l=>l.firstName === 'ZZ After');
      DB.leads = DB.leads.filter(l=>l !== gone);
      await save('leads');
      return gone.id;
    });
    const ids = await serverIds('leads');
    if(ids.includes(r)) throw new Error('a removed lead came back');
    return 'removed';
  });

  await t.step('a reset or a restore still replaces the store outright', async () => {
    const r = await t.eval(async ()=>{
      await sset('zzMergeProbe', [{id: 'A'}, {id: 'B'}]);
      systemResetting = true;
      try { await sset('zzMergeProbe', []); } finally { systemResetting = false; }
      return (await sget('zzMergeProbe', null)).length;
    });
    if(r !== 0) throw new Error(r + ' rows left after a reset');
    return 'emptied';
  });
});
