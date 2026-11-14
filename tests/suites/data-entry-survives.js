/* NOTHING TYPED OR SAVED DISAPPEARS BY ITSELF — ACROSS THE SITE.

   The firm saw data "deleted automatically after an auto refresh", in more
   than one place. Two ways it happened, both covered here store by store:
   1. A save from a tab a moment behind replaced the whole store, deleting
      records colleagues had just made (now merged on the server).
   2. A redraw — a colleague's save arriving, or this tab's own background
      write (the attendance heartbeat) — rebuilt a full-page form somebody was
      halfway through, emptying it (now held until the page is saved or left). */
const {suite} = require('../lib/harness');

const STORES = ['leads', 'clients', 'tasks', 'meetings', 'callEntries', 'businessEntries', 'transactions', 'queries', 'projects',
  'recommendations', 'workActivities', 'djtEntries', 'notifications', 'communications', 'partners'];

suite(async t => {
  await t.home();

  await t.step('in every store: a colleague\'s new record survives a save from a tab that had not read it', async () => {
    const r = await t.eval(async (STORES)=>{
      const out = [];
      for(const key of STORES){
        if(!Array.isArray(DB[key])) { out.push(key + ': not a list here'); continue; }
        const stale = DB[key].slice(), seen = JSON.stringify(DB[key]);
        /* the colleague, from their own browser */
        const cur = JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value || '[]');
        const theirs = {id: 'ZZ-COLLEAGUE-' + key, createdAt: new Date().toISOString(), title: 'from a colleague'};
        await fetch('/api/storage/' + key, {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'colleague'}),
          body: JSON.stringify({value: JSON.stringify(cur.concat([theirs]))})});
        /* this tab, a moment behind, saves a record of its own */
        DB[key] = stale; storeBaseSet(key, seen);
        const mine = {id: 'ZZ-MINE-' + key, createdAt: new Date().toISOString(), title: 'mine'};
        DB[key].push(mine);
        await sset(key, DB[key]);
        const after = JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value || '[]').map(x=>x && x.id);
        const lostTheirs = !after.includes(theirs.id), lostMine = !after.includes(mine.id), lostOld = cur.filter(x=>x && x.id && !after.includes(x.id)).length;
        if(lostTheirs || lostMine || lostOld) out.push(key + ': lost ' + [lostTheirs && 'the colleague\'s', lostMine && 'this tab\'s', lostOld && lostOld + ' earlier'].filter(Boolean).join(', '));
        /* and a deliberate delete still deletes: take both test rows out again */
        DB[key] = await sget(key, []);
        DB[key] = DB[key].filter(x=>!(x && /^ZZ-(COLLEAGUE|MINE)-/.test(x.id)));
        await sset(key, DB[key]);
        const left = JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value || '[]').filter(x=>x && /^ZZ-(COLLEAGUE|MINE)-/.test(x.id)).length;
        if(left) out.push(key + ': a deliberate delete did not stick');
      }
      await loadAll();
      return out;
    }, STORES);
    if(r.length) throw new Error(r.join(' | '));
    return STORES.length + ' stores: nothing lost';
  });

  await t.step('a half-filled full-page form keeps what is typed while colleagues save and the heartbeat writes', async () => {
    await t.eval(()=>{ window._pendingSubTasks = []; window._pendingTaskFields = {}; navigate('dst', 'new'); });
    await t.wait(300);
    await t.page.fill('#f_description', 'ZZ half-typed description');
    await t.page.click('h1, .page-title, body', {position: {x: 5, y: 5}}).catch(()=>{});
    await t.eval(()=>{ if(document.activeElement) document.activeElement.blur(); });
    /* colleagues save, and this tab's own background write fires */
    await t.eval(async ()=>{
      for(const key of ['tasks', 'leads']){
        const cur = JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value || '[]');
        const now = new Date().toISOString(), today = now.slice(0, 10);
        cur.push(key === 'tasks'
          ? {id: 'ZZ-BG-tasks' + Date.now(), taskType: 'Follow-up Call', description: 'ZZ colleague task', overallStatus: 'Not Started', assignTo: currentUser, createdBy: currentUser, createdAt: now, assignedDate: today, dueDate: today}
          : {id: 'ZZ-BG-leads' + Date.now(), name: 'ZZ Colleague Lead', fullName: 'ZZ Colleague Lead', mobile: '9000000001', status: 'New', stage: 'New', source: 'Referral', assignedTo: currentUser, createdBy: currentUser, createdAt: now});
        await fetch('/api/storage/' + key, {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'colleague'}),
          body: JSON.stringify({value: JSON.stringify(cur)})});
      }
      await save('settings');
    });
    await t.wait(2500);
    const r = await t.eval(()=>({value: (document.getElementById('f_description') || {}).value, notice: !!document.getElementById('liveHeld')}));
    if(r.value !== 'ZZ half-typed description') throw new Error('the typed description was wiped: "' + r.value + '"');
    if(!r.notice) throw new Error('nobody was told the colleagues\' changes are waiting');
    return 'typing kept; the "changes waiting" bar shown';
  });

  /* The server batches writes that land together into one event. A batch
     holding this tab's own save and a colleague's must not read as this tab's
     own — that dropped the colleague's change on the floor. */
  await t.step('leaving the page shows the latest, and the bar goes', async () => {
    const r = await t.eval(async ()=>{ navigate('dst'); await new Promise(z=>setTimeout(z, 200));
      return {notice: !!document.getElementById('liveHeld'), sees: DB.tasks.some(x=>/^ZZ-BG-tasks/.test(x.id))}; });
    if(r.notice) throw new Error('the bar stayed after leaving the page');
    if(!r.sees) throw new Error('the colleagues\' change never arrived');
    return 'latest shown';
  });

  await t.step('a pop-up form keeps what is typed while colleagues save', async () => {
    await t.eval(()=>openQueryForm());
    await t.wait(200);
    await t.page.fill('#f_qSubject', 'ZZ typed in a pop-up');
    await t.eval(async ()=>{
      const cur = JSON.parse((await (await fetch('/api/storage/queries', {headers: apiHeaders()})).json()).value || '[]');
      const q = Object.assign({}, cur[0] || {}, {id: 'ZZ-BG-Q' + Date.now(), subject: 'colleague ticket', createdBy: currentUser, createdAt: new Date().toISOString()});
      cur.push(q);
      await fetch('/api/storage/queries', {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'colleague'}),
        body: JSON.stringify({value: JSON.stringify(cur)})});
    });
    await t.wait(2500);
    const v = await t.eval(()=>{ const x = (document.getElementById('f_qSubject') || {}).value; closeModal(); return x; });
    if(v !== 'ZZ typed in a pop-up') throw new Error('the pop-up lost its typing: "' + v + '"');
    return 'kept';
  });
});
