/* MERGE CLIENTS: ONE PERSON, ONE PROFILE — AND THE NEXT IMPORT KNOWS IT.

   "DEXTER PETER FONSECA" was typed in with a PAN and a mobile; a platform
   report later made "Dexter Peter Nicholas Fonseca" with neither. They are
   one investor. This suite checks that BOSS offers them as a likely
   duplicate, that a merge keeps every field and moves every linked record,
   that the original records survive in the merge history, and that the
   next report under the long name lands on the master instead of making
   the duplicate again. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  let ids;

  await t.step('a book with the same investor twice, and two look-alikes who are not', async () => {
    ids = await t.eval(async ()=>{
      const now = new Date().toISOString();
      const mk = (o)=>{ const c = Object.assign({id: uid('CMS'), createdAt: now, branch: 'Mumbai'}, o); initState('CMS', c); return c; };
      const a = mk({cmsName: 'DEXTER PETER FONSECA', pan: 'DXTPF4321K', mobile: '8291985285', clientCategory: 'Alpha', rmName: currentUser,
        nominees: [{id: 'N1', name: 'Maria Fonseca'}], createdAt: '2026-01-05T10:00:00.000Z'});
      const b = mk({cmsName: 'Dexter Peter Nicholas Fonseca', email: 'dexter@example.com', city: 'Mumbai', clientCategory: 'Beta',
        nominees: [{id: 'N2', name: 'Paul Fonseca'}]});
      /* Same name, different PAN: two people. */
      const c = mk({cmsName: 'Rahul Verma', pan: 'PQRSV1111A', mobile: '9000000001'});
      const d = mk({cmsName: 'Rahul Verma', pan: 'PQRSV2222B', mobile: '9000000002'});
      DB.clients = DB.clients.concat([a, b, c, d]);
      await save('clients');
      /* Records that belong to the duplicate, in the stores a client's money and work live in. */
      DB.transactions = (DB.transactions || []).concat([{id: uid('TXN'), clientId: b.id, amount: 50000, createdAt: now}]);
      await save('transactions');
      DB.platformHoldings = (DB.platformHoldings || []).concat([{id: uid('PH'), clientId: b.id, scheme: 'ZZ Bluechip', value: 125000}]);
      await save('platformHoldings');
      DB.tasks = (DB.tasks || []).concat([{id: uid('DST'), clientId: b.id, description: 'ZZ KYC for Dexter', overallStatus: 'Not Started', assignTo: currentUser, createdBy: currentUser, createdAt: now}]);
      await save('tasks');
      return {a: a.id, b: b.id, c: c.id, d: d.id};
    });
    return JSON.stringify(ids);
  });

  t.section('Finding them');

  await t.step('the two Dexters are offered as one person; the two Rahul Vermas are not', async () => {
    const r = await t.eval((ids)=>{
      const g = cmFindGroups();
      const dex = g.find(x=>x.ids.indexOf(ids.a) >= 0);
      const rahul = g.find(x=>x.ids.indexOf(ids.c) >= 0 || x.ids.indexOf(ids.d) >= 0);
      return {dex: dex && {ids: dex.ids.slice().sort(), reasons: dex.reasons, names: dex.ids.map(i=>DB.clients.find(c=>c.id===i).cmsName+'/'+DB.clients.find(c=>c.id===i).pan)}, rahul: !!rahul};
    }, ids);
    if(!r.dex || r.dex.ids.indexOf(ids.b) < 0) throw new Error('the Dexters were not paired: ' + JSON.stringify(r));
    if(r.rahul) throw new Error('two clients with different PANs were offered as one person');
    return r.dex.reasons.join(', ') + ' :: ' + r.dex.names.join(' ; ');
  });

  await t.step('Find Duplicates on the CMS list shows the pair, and Not the same person hides a pair for good', async () => {
    const r = await t.eval(async (ids)=>{
      navigate('cms');
      const btn = [...document.querySelectorAll('button')].find(b=>/Find Duplicates/.test(b.textContent));
      if(!btn) return {err: 'no Find Duplicates button'};
      btn.click();
      await new Promise(z=>setTimeout(z, 200));
      const text = document.getElementById('modalBody').innerText;
      /* A pair dismissed is not offered again. */
      const x = {id: uid('CMS'), cmsName: 'ZZ Twin Kapoor', mobile: '9111111111', createdAt: new Date().toISOString()};
      const y = {id: uid('CMS'), cmsName: 'ZZ Twin Kapoor', createdAt: new Date().toISOString()};
      DB.clients.push(x, y); await save('clients');
      const before = cmFindGroups().some(g=>g.ids.indexOf(x.id) >= 0);
      await cmNotDuplicates([x.id, y.id]);
      const after = cmFindGroups().some(g=>g.ids.indexOf(x.id) >= 0);
      closeModal();
      return {listed: /DEXTER PETER FONSECA/.test(text) && /Dexter Peter Nicholas Fonseca/.test(text), before, after};
    }, ids);
    if(r.err) throw new Error(r.err);
    if(!r.listed) throw new Error('the duplicates list does not show both Dexters');
    if(!r.before || r.after) throw new Error('dismissing a pair did not hide it: ' + JSON.stringify(r));
    return 'listed; a dismissed pair stays dismissed';
  });

  t.section('Merging them');

  await t.step('ticking both on the CMS list offers Merge Selected, and the dialog shows what differs and what moves', async () => {
    const r = await t.eval(async (ids)=>{
      navigate('cms');
      bulkSelection.CMS = new Set([ids.a, ids.b]);
      navigate('cms');
      const btn = [...document.querySelectorAll('button')].find(b=>/Merge Selected/.test(b.textContent));
      if(!btn) return {err: 'no Merge Selected button with two clients ticked'};
      btn.click();
      await new Promise(z=>setTimeout(z, 200));
      const m = document.getElementById('modalBody');
      const master = m.querySelector('input[name="cmMaster"]:checked');
      return {text: m.innerText, masterRow: master ? master.closest('tr').innerText : ''};
    }, ids);
    if(r.err) throw new Error(r.err);
    if(!/DEXTER PETER FONSECA/.test(r.masterRow)) throw new Error('the record with the PAN and mobile was not proposed as master: ' + r.masterRow);
    for(const want of ['Where the records disagree', 'Moves to the master', 'Dexter Peter Nicholas Fonseca'])
      if(r.text.indexOf(want) < 0) throw new Error('the dialog does not say "' + want + '"');
    if(!/Transactions: 1/.test(r.text) || !/Platform AUM snapshots: 1/.test(r.text)) throw new Error('the linked records are not counted: ' + r.text.slice(0, 900));
    return 'master proposed: the record with PAN and mobile';
  });

  await t.step('picking the other category and merging folds the duplicate into the master', async () => {
    const r = await t.eval(async (ids)=>{
      /* Category differs (Alpha / Beta): keep the duplicate's, Beta. */
      const pick = document.querySelector(`input[name="cm_clientCategory"][onchange*="${ids.b}"]`);
      if(!pick) return {err: 'no choice offered for Client Category'};
      pick.click();
      await new Promise(z=>setTimeout(z, 100));
      const go = [...document.querySelectorAll('#modalBody button, .modal button')].find(b=>/^Merge 2 clients/.test(b.textContent.trim()));
      if(!go) return {err: 'no Merge button'};
      go.click();
      for(let i = 0; i < 50 && DB.clients.some(c=>c.id === ids.b); i++) await new Promise(z=>setTimeout(z, 100));
      await new Promise(z=>setTimeout(z, 300));
      const m = DB.clients.find(c=>c.id === ids.a);
      return {gone: !DB.clients.some(c=>c.id === ids.b), m,
        txn: DB.transactions.filter(x=>x.clientId === ids.b).length + '/' + DB.transactions.filter(x=>x.clientId === ids.a).length,
        hold: DB.platformHoldings.filter(x=>x.clientId === ids.a).length, task: DB.tasks.filter(x=>x.clientId === ids.a).length,
        log: (DB.clientMerges || []).filter(e=>e.kind === 'merge').slice(-1)[0],
        audit: DB.auditLog.filter(a=>a.recordId === ids.a && a.action === 'Clients Merged').length
             + DB.auditLog.filter(a=>a.recordId === ids.b && /^Merged Into/.test(a.action)).length,
        page: document.getElementById('content').innerText};
    }, ids);
    if(r.err) throw new Error(r.err);
    if(!r.gone) throw new Error('the duplicate is still on the client list');
    const m = r.m;
    if(m.pan !== 'DXTPF4321K' || m.mobile !== '8291985285') throw new Error('the master lost its PAN or mobile');
    if(m.email !== 'dexter@example.com' || m.city !== 'Mumbai') throw new Error('the duplicate\'s email and city were not filled in: ' + JSON.stringify(m));
    if(m.clientCategory !== 'Beta') throw new Error('the category picked (Beta) was not kept: ' + m.clientCategory);
    if((m.nominees || []).length !== 2) throw new Error('the nominees were not joined: ' + JSON.stringify(m.nominees));
    if(m.createdAt !== '2026-01-05T10:00:00.000Z') throw new Error('the master did not keep the earliest created date');
    if(r.txn !== '0/1' || r.hold !== 1 || r.task !== 1) throw new Error('linked records did not move: txn ' + r.txn + ' holdings ' + r.hold + ' tasks ' + r.task);
    if(!r.log || r.log.masterId !== ids.a || r.log.mergedIds[0] !== ids.b || !r.log.records[0] || r.log.records[0].cmsName !== 'Dexter Peter Nicholas Fonseca' || !r.log.by)
      throw new Error('the merge history does not hold the original record: ' + JSON.stringify(r.log));
    if(r.log.masterBefore.clientCategory !== 'Alpha') throw new Error('the master as it was is not in the merge history');
    if(r.audit !== 2) throw new Error('expected an audit line on the master and on the merged record, got ' + r.audit);
    if(!/Merged from/.test(r.page) || r.page.indexOf(ids.b) < 0) throw new Error('the client page does not say what was merged into it');
    return 'filled, picked, joined, moved; original kept in the merge history';
  });

  await t.step('the merge history lists it: original id, master, date and who', async () => {
    const r = await t.eval(async (ids)=>{
      openClientDuplicates('history');
      await new Promise(z=>setTimeout(z, 150));
      const text = document.getElementById('modalBody').innerText;
      closeModal();
      return {text, me: teamName(currentUser)};
    }, ids);
    for(const want of [ids.a, ids.b, r.me]) if(r.text.indexOf(want) < 0) throw new Error('the merge history does not show ' + want);
    return 'listed';
  });

  await t.step('the old client id opens a page pointing at the master', async () => {
    const r = await t.eval(async (ids)=>{ navigate('cms', ids.b); await new Promise(z=>setTimeout(z, 150)); return document.getElementById('content').innerText; }, ids);
    if(!/was merged into another client/.test(r) || r.indexOf(ids.a) < 0) throw new Error('the old id does not point at the master: ' + r.slice(0, 200));
    return 'points at ' + ids.a;
  });

  t.section('The next import');

  await t.step('a report naming "Dexter Peter Nicholas Fonseca" with no PAN lands on the master, not a new client', async () => {
    const r = await t.eval((ids)=>{
      const clients = DB.clients.filter(c=>!c.deletedAt);
      const byName = impMatchClient({name: 'Dexter Peter Nicholas Fonseca'}, clients);
      const byNameMob = impMatchClient({name: 'DEXTER PETER NICHOLAS FONSECA', mobile: '8291985285'}, clients);
      const byPan = impMatchClient({pan: 'DXTPF4321K', name: 'Dexter Peter Nicholas Fonseca'}, clients);
      /* A multi-asset row uploaded against the old id, and one with only the long name. */
      const resolve = maResolver([]);
      const oldId = resolve({cid: ids.b, client_name: 'whoever'});
      const longName = resolve({client_name: 'Dexter Peter Nicholas Fonseca'});
      return {byName, byNameMob, byPan, oldId: oldId.clientId, longName: longName.clientId};
    }, ids);
    if(r.byName.clientId !== ids.a) throw new Error('the long name did not match the master: ' + JSON.stringify(r.byName));
    if(r.byNameMob.clientId !== ids.a) throw new Error('the long name with the master\'s mobile did not match: ' + JSON.stringify(r.byNameMob));
    if(r.byPan.clientId !== ids.a) throw new Error('the PAN did not match the master');
    if(r.oldId !== ids.a) throw new Error('a multi-asset row on the old id is not the master\'s: ' + r.oldId);
    if(r.longName !== ids.a) throw new Error('a multi-asset row with only the long name is not the master\'s: ' + r.longName);
    return 'by name, by name + mobile, by PAN, by old id: all ' + ids.a;
  });

  await t.step('an old export does not bring the merged client back, and its records come in on the master', async () => {
    const r = await t.eval((ids)=>{
      const cl = impBackPlan('clients', [{id: ids.b, cmsName: 'Dexter Peter Nicholas Fonseca'}]);
      const tx = impBackPlan('transactions', [{id: 'TXN-ZZOLD1', clientId: ids.b, amount: 100}]);
      return {clSkip: cl.skip.map(s=>s.why), clAdd: cl.add.length + cl.update.length,
        txClient: (tx.add[0] || tx.update[0] || {row: {}}).row.clientId};
    }, ids);
    if(r.clAdd || !/merged into/.test(r.clSkip.join(' '))) throw new Error('the merged client would be re-created: ' + JSON.stringify(r));
    if(r.txClient !== ids.a) throw new Error('a transaction on the old id comes in on ' + r.txClient);
    return 'skipped: ' + r.clSkip[0];
  });

  await t.step('merging the master into a third record later carries every old id and name along', async () => {
    const r = await t.eval(async (ids)=>{
      const e = {id: uid('CMS'), cmsName: 'Dexter P Fonseca', mobile: '8291985285', createdAt: new Date().toISOString()};
      initState('CMS', e);
      DB.clients.push(e); await save('clients');
      await cmMerge(e.id, [e.id, ids.a], {});
      const clients = DB.clients.filter(c=>!c.deletedAt);
      return {third: e.id, a: impMatchClient({name: 'Dexter Peter Nicholas Fonseca'}, clients).clientId,
        into: cmMergedInto(ids.b), intoA: cmMergedInto(ids.a), txn: DB.transactions.filter(x=>x.clientId === e.id).length};
    }, ids);
    if(r.a !== r.third || r.into !== r.third || r.intoA !== r.third) throw new Error('the chain was not followed: ' + JSON.stringify(r));
    if(r.txn !== 1) throw new Error('the transaction did not follow to the new master');
    return 'old ids and names now land on ' + r.third;
  });

  await t.step('keeping the other record\'s name, the master\'s old name still finds it', async () => {
    const r = await t.eval(async ()=>{
      const mk = o=>{ const c = Object.assign({id: uid('CMS'), createdAt: new Date().toISOString()}, o); initState('CMS', c); return c; };
      const a = mk({cmsName: 'SUNITA R IYER', pan: 'SNTRI5678Q'});
      const b = mk({cmsName: 'Sunita Ramesh Iyer'});
      DB.clients.push(a, b); await save('clients');
      await cmMerge(a.id, [a.id, b.id], {cmsName: b.id});
      const clients = DB.clients.filter(c=>!c.deletedAt);
      const m = clients.find(c=>c.id === a.id);
      return {name: m.cmsName, short: impMatchClient({name: 'SUNITA R IYER'}, clients).clientId,
        long: impMatchClient({name: 'Sunita Ramesh Iyer'}, clients).clientId, id: a.id};
    });
    if(r.name !== 'Sunita Ramesh Iyer') throw new Error('the name picked was not kept: ' + r.name);
    if(r.short !== r.id || r.long !== r.id) throw new Error('both names should find the master: ' + JSON.stringify(r));
    return 'both names land on ' + r.id;
  });

  await t.step('the duplicates list filters by branch, RM and client', async () => {
    const r = await t.eval(async ()=>{
      const now = new Date().toISOString();
      const mk = (name, branch, mobile)=>({id: uid('CMS'), cmsName: name, branch, mobile, rmName: currentUser, createdAt: now});
      DB.clients.push(mk('ZZ Filter Patel Alpha', 'Pune', '9700000001'), mk('ZZ Filter Patel Alpha Kumar', 'Pune', '9700000001'),
        mk('ZZ Filter Shah Beta', 'Delhi', '9700000002'), mk('ZZ Filter Shah Beta Raj', 'Delhi', '9700000002'));
      await save('clients');
      const count = ()=>{ const m = (document.getElementById('modalBody').innerText.match(/(\d+) groups? to review/) || [])[1]; return Number(m || 0); };
      const names = ()=>document.getElementById('modalBody').innerText;
      openClientDuplicates('dups');
      await new Promise(z=>setTimeout(z, 200));
      const all = count();
      cmDupFilter.branch = 'Pune'; renderClientDuplicates();
      const pune = names();
      cmDupFilter.branch = ''; cmDupFilter.q = 'shah beta'; renderClientDuplicates();
      const shah = names();
      cmDupFilter.q = ''; cmDupFilter.rm = 'USR-NOBODY'; renderClientDuplicates();
      const nobody = names();
      cmDupFilter.rm = ''; closeModal();
      return {all, puneHasPatel: /ZZ Filter Patel Alpha/.test(pune), puneHasShah: /ZZ Filter Shah/.test(pune),
        shahHasShah: /ZZ Filter Shah Beta/.test(shah), shahHasPatel: /ZZ Filter Patel/.test(shah), nobodyEmpty: /No likely duplicates match/.test(nobody),
        selects: true};
    });
    if(!r.puneHasPatel || r.puneHasShah) throw new Error('the branch filter: ' + JSON.stringify(r));
    if(!r.shahHasShah || r.shahHasPatel) throw new Error('the client search: ' + JSON.stringify(r));
    if(!r.nobodyEmpty) throw new Error('the RM filter did not narrow the list');
    return 'branch, client and RM each narrow the list (' + r.all + ' groups unfiltered)';
  });

  await t.step('a record stored twice under one ID is not offered as a merge, and is tidied to one copy', async () => {
    const r = await t.eval(async ()=>{
      const now = new Date().toISOString();
      const one = {id: uid('CMS'), cmsName: 'ZZ Twice Stored', pan: 'TWICE1234T', mobile: '9600000001', createdAt: now};
      DB.clients.push(Object.assign({}, one), Object.assign({}, one, {email: 'only.on.copy@zz.in'}));
      await save('clients');
      const pairedWithItself = cmFindGroups().some(g=>g.ids.length === 1 || (g.ids.indexOf(one.id) >= 0 && new Set(g.ids).size < g.ids.length));
      openClientDuplicates('dups');
      await new Promise(z=>setTimeout(z, 150));
      const shown = document.getElementById('modalBody').innerText;
      const said = /stored twice under the same ID/i.test(shown);
      await cmTidyCopies();
      const left = DB.clients.filter(c=>c.id === one.id);
      closeModal();
      return {dbg: shown.slice(0, 300), pairedWithItself, said, copies: left.length, email: left[0] && left[0].email,
        logged: (DB.clientMerges || []).some(e=>e.kind === 'sameIdTidy' && e.masterId === one.id && e.records.length === 1)};
    });
    if(r.pairedWithItself) throw new Error('the record was offered as a duplicate of itself');
    if(!r.said) throw new Error('the list does not say the record is stored twice: ' + r.dbg);
    if(r.copies !== 1) throw new Error(r.copies + ' copies left');
    if(r.email !== 'only.on.copy@zz.in') throw new Error('what only the second copy had was lost');
    if(!r.logged) throw new Error('the removed copy is not kept in the history');
    return 'not offered as a merge; tidied to one copy, nothing lost, the extra copy in the history';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
