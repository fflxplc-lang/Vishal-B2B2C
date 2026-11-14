/* "I COMPLETED THE FQ TEST BUT THE DATA IS NOT STORED" — AND "ON REFRESH IT SENDS ME BACK".

   1. On the FQ link a quick second tap moved on twice, skipping the next
      question; at the end the submit refused the "unanswered" ones and the
      page sat on "Working out your score…". Taps now wait for the move, a
      missed question is shown again, and a refresh keeps the answers.
   2. A save whose answer came back after this tab had saved again replaced
      the tab's list with the older copy; the next save sent the old record
      back, so a lead was a stage behind on the next refresh. */
const {suite} = require('../lib/harness');

suite(async t => {
  let lead, token;

  await t.step('a lead is sent the FQ link from Send Form', async () => {
    const r = await t.eval(async ()=>{
      const l = {id: uid('LMS'), firstName: 'ZZ Suraj', lastName: 'Test', mobile: '9821269089', email: 'zz.suraj@finowise.test',
        assignedTo: currentUser, createdAt: new Date().toISOString(), createdBy: currentUser};
      initState('LMS', l); DB.leads.push(l); await save('leads');
      const tok = await createDocLink(l.id, fqLinkStage(), {fqPick: true});
      return {lead: l.id, token: tok};
    });
    lead = r.lead; token = r.token;
    return token;
  });

  const tapThrough = async (from, to, double) => {
    for(let i = from; i < to; i++){
      await t.page.waitForSelector('.fx-opt', {timeout: 5000});
      const btns = await t.page.$$('.fx-opt');
      const b = btns[i % btns.length];
      if(double) await b.dblclick(); else await b.click();
      await t.wait(420);
      const mile = await t.page.$('.fx-mile button');
      if(mile){ await mile.click(); await t.wait(150); }
      const sc = await t.eval(()=>fqaRun && fqaRun.screen);
      if(sc !== 'quiz') break;
    }
  };

  await t.step('double-tapping every answer skips nothing', async () => {
    await t.doc(token, 1500);
    await t.eval(()=>fqaPickStage('FQ_YOUNG')); await t.wait(200);
    await t.eval(()=>{ document.getElementById('fqa_fq_name').value = 'ZZ Suraj Test'; document.getElementById('fqa_fq_email').value = 'zz.suraj@finowise.test';
      document.getElementById('fqa_fq_mobile').value = '9821269089'; fqaLeadSubmit(); });
    await t.wait(200);
    await t.eval(()=>fqaBeginQuiz()); await t.wait(150);
    await tapThrough(0, 8, true);
    const mid = await t.eval(()=>({i: fqaRun.i, answered: Object.keys(fqaRun.picks).length,
      gap: fqQuestionFields(fqaRun.type).findIndex(q=>fqaRun.picks[q.k] === undefined)}));
    if(mid.answered !== mid.i || mid.gap !== mid.i) throw new Error('a question was skipped: ' + JSON.stringify(mid));
    return 'after 8 double taps: on question ' + (mid.i + 1) + ', ' + mid.answered + ' answered, none skipped';
  });

  await t.step('a refresh half-way keeps the answers and carries on from the next question', async () => {
    await t.doc(token, 1500);
    const r = await t.eval(()=>({screen: fqaRun.screen, i: fqaRun.i, answered: Object.keys(fqaRun.picks).length, note: (document.getElementById('fqaGapNote') || {}).innerText || ''}));
    if(r.screen !== 'quiz' || r.answered !== 8 || r.i !== 8) throw new Error('not picked up where it stopped: ' + JSON.stringify(r));
    if(!/Welcome back/.test(r.note)) throw new Error('nobody was told');
    return 'back on question 9 with 8 answers';
  });

  await t.step('a question missed is shown again, then the score is stored on the lead', async () => {
    /* Knock one answer out, as a skip used to, and finish the rest. */
    await t.eval(()=>{ delete fqaRun.picks[fqQuestionFields(fqaRun.type)[3].k]; fqaSaveProgress(); });
    const total = await t.eval(()=>fqQuestionFields(fqaRun.type).length);
    await tapThrough(8, total, false);
    await t.wait(300);
    const shown = await t.eval(()=>({screen: fqaRun.screen, i: fqaRun.i, note: (document.getElementById('fqaGapNote') || {}).innerText || ''}));
    if(shown.screen !== 'quiz' || shown.i !== 3 || !/not answered/.test(shown.note)) throw new Error('the missed question was not shown again: ' + JSON.stringify(shown));
    await t.page.click('.fx-opt'); await t.wait(1500);
    for(let i = 0; i < 20 && (await t.eval(()=>fqaRun && fqaRun.screen)) !== 'result'; i++) await t.wait(300);
    const end = await t.eval(()=>fqaRun.screen);
    if(end !== 'result') throw new Error('stuck on ' + end + ' · dialogs: ' + t.dialogs.join(' / '));
    if(t.dialogs.some(d=>/Please answer these/.test(d))) throw new Error('the submit still refused: ' + t.dialogs.join(' / '));
    const kept = await t.eval((tok)=>{ try { return localStorage.getItem('fqa_progress_' + tok); } catch(e){ return 'x'; } }, token);
    await t.home();
    const l = await t.eval(async (id)=>{ const all = JSON.parse((await (await fetch('/api/storage/leads', {headers: apiHeaders()})).json()).value || '[]');
      const x = all.find(y=>y.id === id) || {}; return {score: x.fqScore, cat: x.fqCategory}; }, lead);
    if(l.score === undefined || l.score === null || l.score === '') throw new Error('the score is not on the lead: ' + JSON.stringify(l));
    if(kept) throw new Error('the saved progress was not cleared after submitting');
    return 'missed question shown, then scored: ' + l.score + ' (' + l.cat + '); progress cleared';
  });

  await t.step('two saves in flight, then a third: the newest change is what the server keeps', async () => {
    const r = await t.eval(async (id)=>{
      /* A colleague's lead the tab has not seen, so the server merges. */
      const cur = JSON.parse((await (await fetch('/api/storage/leads', {headers: apiHeaders()})).json()).value || '[]');
      cur.push({id: uid('LMS'), firstName: 'ZZ Colleague', lastName: 'Lead', createdAt: new Date().toISOString()});
      await fetch('/api/storage/leads', {method: 'PUT', headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'colleague'}),
        body: JSON.stringify({value: JSON.stringify(cur)})});
      /* …and this tab has not heard of it yet, as a tab a moment behind has not. */
      await new Promise(z=>setTimeout(z, 600));
      const cid = cur[cur.length - 1].id;
      DB.leads = DB.leads.filter(x=>x.id !== cid);
      storeBaseSet('leads', JSON.stringify(DB.leads));
      const l = DB.leads.find(x=>x.id === id);
      /* The order a slow connection can give: the first save's answer comes
         back after the second save has gone out, and before its answer. */
      const realFetch = window.fetch; let n = 0, releaseA, releaseB, sentA, sentB;
      const aSent = new Promise(z=>{ sentA = z; }), bSent = new Promise(z=>{ sentB = z; });
      const gateA = new Promise(z=>{ releaseA = z; }), gateB = new Promise(z=>{ releaseB = z; });
      window.fetch = function(url, opts){
        const p = realFetch.apply(this, arguments);
        if(/\/api\/storage\/leads$/.test(String(url)) && opts && opts.method === 'PUT'){
          n++;
          if(n === 1){ sentA(); return p.then(r=>gateA.then(()=>r)); }
          if(n === 2){ sentB(); return p.then(r=>gateB.then(()=>r)); }
        }
        return p;
      };
      try {
        l.zzStep = 'first';
        const a = save('leads');
        await aSent;
        l.zzStep = 'second';
        const b = save('leads');
        await bSent;
        releaseA(); await a;
        releaseB(); await b;
      } finally { window.fetch = realFetch; }
      const local = (DB.leads.find(x=>x.id === id) || {}).zzStep;
      await save('leads');
      const srv = JSON.parse((await (await fetch('/api/storage/leads', {headers: apiHeaders()})).json()).value || '[]');
      await liveRefresh(['leads']);
      return {local, server: (srv.find(x=>x.id === id) || {}).zzStep, colleague: DB.leads.some(x=>x.firstName === 'ZZ Colleague')};
    }, lead);
    if(r.local !== 'second') throw new Error('the tab lost its newer change: ' + r.local);
    if(r.server !== 'second') throw new Error('the server was sent the older record: ' + r.server);
    if(!r.colleague) throw new Error('the colleague\'s lead was not taken in');
    return 'tab and server both on the newest; the colleague\'s lead taken in';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
