/* SEVERAL PEOPLE AT ONCE: NOBODY'S SAVE PUTS BACK AN OLD COPY OF ANYBODY ELSE'S WORK.

   The firm's report (14-11-2026): a lead qualified after its FQ came back
   went back to "Ready for Qualification" with the FQ "not back yet"; data
   other people had saved reset or reverted. The cause was every save
   sending the whole store, so any tab that had missed an update put its old
   copies back. Now a save sends only the fields it changed, and the server
   refuses an older copy of a record over a newer one.

   User A, User B and the client's own link are separate tabs here, each
   with its own copy of the data, as they are in the office. */
const {suite} = require('../lib/harness');
const signIn = require('../lib/signin');

suite(async t => {
  const browser = t.page.context().browser();
  const ctx = await browser.newContext({viewport: {width: 1400, height: 900}});
  let B, C, ids;
  const srv = (key, id) => t.eval(async ([key, id])=>{
    const all = JSON.parse((await (await fetch('/api/storage/' + key, {headers: apiHeaders()})).json()).value || '[]');
    return all.find(x=>x && x.id === id) || null; }, [key, id]);
  const evalIn = (page, fn, arg) => page.evaluate(fn, arg);
  const openTab = async () => { const p = await ctx.newPage(); p.on('dialog', d=>d.accept().catch(()=>{})); await signIn(p, t.base); await p.goto(t.url('/'), {waitUntil: 'domcontentloaded'});
    await p.waitForFunction(()=>typeof appBooted !== 'undefined' && appBooted, null, {timeout: 30000}); await p.waitForTimeout(500); return p; };
  /* A tab that has stopped hearing about other people's saves: asleep, or
     its connection dropped. */
  const deafen = page => evalIn(page, ()=>{ try { if(live.src) live.src.close(); } catch(e){} live.src = null; window.liveFlush = async()=>{}; window.liveOnChange = ()=>{}; });

  await t.step('a lead, a client and two more tabs: User B, and the lead\'s own FQ link', async () => {
    ids = await t.eval(async ()=>{
      const now = new Date().toISOString();
      const l = {id: uid('LMS'), firstName: 'ZZ Guru', lastName: 'Lead', mobile: '9876512345', email: 'zz.guru@finowise.test', assignedTo: currentUser,
        zzStage: 'Ready for Qualification', createdAt: now, createdBy: currentUser};
      initState('LMS', l);
      const other = {id: uid('LMS'), firstName: 'ZZ Other', lastName: 'Lead', assignedTo: currentUser, createdAt: now, createdBy: currentUser};
      initState('LMS', other);
      DB.leads.push(l, other); await save('leads');
      const c = {id: uid('CMS'), cmsName: 'ZZ Shared Client', mobile: '9876500077', rmName: currentUser, createdAt: now, createdBy: currentUser};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      const tok = await createDocLink(l.id, fqLinkStage(), {fqPick: true});
      return {lead: l.id, other: other.id, client: c.id, tok};
    });
    B = await openTab();
    C = await ctx.newPage(); await C.goto(t.url('/?doc=' + ids.tok), {waitUntil: 'domcontentloaded'}); await C.waitForTimeout(1500);
    await deafen(B);
    const ok = await evalIn(C, (id)=>DB.leads.some(x=>x.id === id), ids.lead);
    if(!ok) throw new Error('the link page does not hold the lead');
    return 'User B open and no longer hearing updates; the FQ link open on the lead';
  });

  await t.step('the FQ comes back and User A qualifies the lead', async () => {
    /* What the client's link writes on submitting, then User A's Qualify. */
    await evalIn(C, async (id)=>{ const l = DB.leads.find(x=>x.id === id); l.fqScore = 50; l.fqCategory = 'Conscious Spender'; l.fqAnsweredAt = new Date().toISOString(); await save('leads'); }, ids.lead);
    await t.wait(600);
    await t.eval(async (id)=>{ await liveRefresh(['leads']); const l = DB.leads.find(x=>x.id === id); l.zzStage = 'Lead Qualified'; await save('leads'); }, ids.lead);
    const s = await srv('leads', ids.lead);
    if(s.zzStage !== 'Lead Qualified' || s.fqScore !== 50) throw new Error('not saved: ' + JSON.stringify({stage: s.zzStage, fq: s.fqScore}));
    return 'qualified, FQ 50 on the lead';
  });

  await t.step('User B, who missed all of that, saves a different lead — the qualified lead stays qualified', async () => {
    await evalIn(B, async (id)=>{ const o = DB.leads.find(x=>x.id === id); o.notesZZ = 'B was here'; await save('leads'); }, ids.other);
    const s = await srv('leads', ids.lead), o = await srv('leads', ids.other);
    if(s.zzStage !== 'Lead Qualified') throw new Error('User B put the old stage back: ' + s.zzStage);
    if(s.fqScore !== 50) throw new Error('User B wiped the FQ result');
    if(o.notesZZ !== 'B was here') throw new Error('User B\'s own change was not saved');
    return 'lead still qualified with its FQ; B\'s change to the other lead saved';
  });

  await t.step('the client presses something else on their link — the lead stays qualified', async () => {
    await evalIn(C, async (id)=>{ const l = DB.leads.find(x=>x.id === id); l.fqMeetingRequestZZ = 'Thursday evening'; await save('leads'); }, ids.lead);
    const s = await srv('leads', ids.lead);
    if(s.zzStage !== 'Lead Qualified') throw new Error('the link page put the old stage back: ' + s.zzStage);
    if(s.fqMeetingRequestZZ !== 'Thursday evening') throw new Error('the client\'s request was not saved');
    return 'still qualified; the client\'s request saved';
  });

  await t.step('User B edits that lead with an old copy: only the field B changed moves', async () => {
    await evalIn(B, async (id)=>{ const l = DB.leads.find(x=>x.id === id); l.city = 'Varanasi'; await save('leads'); }, ids.lead);
    const s = await srv('leads', ids.lead);
    if(s.city !== 'Varanasi') throw new Error('B\'s field was not saved');
    if(s.zzStage !== 'Lead Qualified' || s.fqScore !== 50) throw new Error('B\'s old copy reverted other fields: ' + JSON.stringify({stage: s.zzStage, fq: s.fqScore}));
    return 'city saved; stage and FQ untouched';
  });

  await t.step('two people edit different fields of one client at once: both kept', async () => {
    await Promise.all([
      t.eval(async (id)=>{ const c = DB.clients.find(x=>x.id === id); c.email = 'zz.a@finowise.test'; await save('clients'); }, ids.client),
      evalIn(B, async (id)=>{ await new Promise(z=>setTimeout(z, 20)); const c = DB.clients.find(x=>x.id === id); c.profession = 'Doctor'; await save('clients'); }, ids.client),
    ]);
    const s = await srv('clients', ids.client);
    if(s.email !== 'zz.a@finowise.test' || s.profession !== 'Doctor') throw new Error('one change lost: ' + JSON.stringify({email: s.email, profession: s.profession}));
    return 'email (A) and profession (B) both on the client';
  });

  await t.step('several people add records at the same moment: every one is kept', async () => {
    const made = await Promise.all([t.page, B, C].map((p, i)=>evalIn(p, async (i)=>{
      const id = uid('TXN'); DB.transactions = DB.transactions || [];
      DB.transactions.push({id, clientId: 'ZZ', amount: 100 + i, status: 'Completed', createdAt: new Date().toISOString()});
      await save('transactions'); return id; }, i).catch(e=>'ERR ' + e.message)));
    const all = await t.eval(async ()=>JSON.parse((await (await fetch('/api/storage/transactions', {headers: apiHeaders()})).json()).value || '[]').map(x=>x.id));
    const lost = made.filter(id=>!all.includes(id));
    /* The link page may not add transactions (outside its link) — that is a refusal, not a loss. */
    const realLost = lost.filter(id=>!/^ERR/.test(id));
    if(realLost.length) throw new Error('lost: ' + realLost.join(', '));
    return made.length - lost.length + ' added together, none lost';
  });

  await t.step('a tab still running the old page cannot put back an older copy', async () => {
    const r = await t.eval(async (id)=>{
      const all = JSON.parse((await (await fetch('/api/storage/leads', {headers: apiHeaders()})).json()).value || '[]');
      const old = all.map(x=>x.id === id ? Object.assign({}, x, {zzStage: 'Ready for Qualification', fqScore: undefined, _mt: 1}) : x);
      const res = await fetch('/api/storage/leads', {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'old-tab'}),
        body: JSON.stringify({value: JSON.stringify(old)})});
      return res.status;
    }, ids.lead);
    const s = await srv('leads', ids.lead);
    if(s.zzStage !== 'Lead Qualified' || s.fqScore !== 50) throw new Error('the old whole-store write reverted it: ' + JSON.stringify({status: r, stage: s.zzStage, fq: s.fqScore}));
    return 'refused record by record; still qualified';
  });

  await t.step('a refresh, and signing out and in, change nothing', async () => {
    const before = await srv('leads', ids.lead);
    await B.reload({waitUntil: 'domcontentloaded'});
    await B.waitForFunction(()=>typeof appBooted !== 'undefined' && appBooted, null, {timeout: 30000}); await B.waitForTimeout(800);
    await t.home();
    const after = await srv('leads', ids.lead);
    const seenB = await evalIn(B, (id)=>{ const l = DB.leads.find(x=>x.id === id) || {}; return {stage: l.zzStage, fq: l.fqScore}; }, ids.lead);
    const strip = x => { const o = Object.assign({}, x); delete o._mt; return JSON.stringify(o); };
    if(strip(before) !== strip(after)) throw new Error('a refresh changed the lead');
    if(seenB.stage !== 'Lead Qualified' || seenB.fq !== 50) throw new Error('User B, refreshed, does not see the latest: ' + JSON.stringify(seenB));
    return 'unchanged on the server; User B sees it qualified after a refresh';
  });

  await t.step('nothing went wrong on the page', async () => {
    await ctx.close().catch(()=>{});
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
