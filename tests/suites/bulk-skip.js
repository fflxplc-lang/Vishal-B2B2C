/* SKIP AFTER MANDATE APPROVAL — FOR BULK-UPLOAD CLIENTS ONLY.

   A client who came in from a platform report or a spreadsheet did not walk
   the LMS journey. From Place Order on, every step can be skipped and every
   mandatory check inside those steps passed over — with nothing filled in,
   nothing sent, and every skip written down. A client converted from a lead
   keeps every check exactly as it was. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  let ids;

  await t.step('one client from a platform import and one from LMS, both at Place Order', async () => {
    ids = await t.eval(async ()=>{
      const now = new Date().toISOString();
      const mk = o=>Object.assign({id: uid('CMS'), createdAt: now, createdBy: currentUser, rmName: currentUser, branch: 'Varanasi',
        cmsStage: 'initiateTransaction', blueprintHistory: [{state: 'initiateTransaction', at: now, by: currentUser}]}, o);
      const bulk = mk({cmsName: 'ZZ Bulk Investor', createdVia: 'Platform import · NJ', mobile: '9811111111', email: 'zz.bulk@zz.in'});
      const lms = mk({cmsName: 'ZZ Journey Investor', convertedFromLeadId: 'LMS-ZZ1', mobile: '9822222222'});
      DB.clients.push(bulk, lms); await save('clients');
      return {bulk: bulk.id, lms: lms.id};
    });
    return JSON.stringify(ids);
  });

  const panel = (id) => t.eval(async (id)=>{
    navigate('cms', id);
    await new Promise(z=>setTimeout(z, 200));
    const btns = [...document.querySelectorAll('#content button')].map(b=>({text: b.textContent.trim(), disabled: b.disabled}));
    return {btns, text: document.getElementById('content').innerText};
  }, id);

  await t.step('the bulk client has Skip; the LMS client does not, and its order still waits for the review', async () => {
    const b = await panel(ids.bulk), l = await panel(ids.lms);
    if(!b.btns.some(x=>/^Skip/.test(x.text))) throw new Error('no Skip for the bulk client');
    if(!/Bulk upload client/.test(b.text)) throw new Error('the bulk client is not labelled');
    if(l.btns.some(x=>/^Skip/.test(x.text))) throw new Error('the LMS client was offered Skip');
    const placed = l.btns.find(x=>/Review the Allocation First|Transaction Placed/.test(x.text));
    if(!placed || !placed.disabled) throw new Error('the LMS client\'s Transaction Placed is no longer held: ' + JSON.stringify(placed));
    return 'Skip for bulk only; LMS order held as before';
  });

  await t.step('Skip moves the bulk client on, writes nothing else, and records the skip', async () => {
    const r = await t.eval(async (ids)=>{
      const c = DB.clients.find(x=>x.id === ids.bulk);
      const before = JSON.parse(JSON.stringify(c));
      const comms = (DB.communications || []).length, tasks = DB.tasks.length;
      await cmsSkipStep(ids.bulk);
      await new Promise(z=>setTimeout(z, 200));
      const after = DB.clients.find(x=>x.id === ids.bulk);
      const changed = Object.keys(after).filter(k=>JSON.stringify(after[k]) !== JSON.stringify(before[k]));
      const last = after.blueprintHistory[after.blueprintHistory.length - 1];
      return {stage: after.cmsStage, changed, last, skipped: after.cmsSkipped, newComms: (DB.communications || []).length - comms,
        newTasks: DB.tasks.length - tasks, audit: DB.auditLog.some(a=>a.recordId === ids.bulk && /Stage Skipped/.test(a.action))};
    }, ids);
    if(r.stage !== 'transactionPlaced') throw new Error('stage is ' + r.stage);
    const extra = r.changed.filter(k=>['cmsStage', 'blueprintHistory', 'cmsSkipped', '_mt'].indexOf(k) < 0);   // _mt: the server's change stamp
    if(extra.length) throw new Error('Skip wrote other fields: ' + extra.join(', '));
    if(!r.last.skipped || r.last.skippedFrom !== 'initiateTransaction') throw new Error('the history does not mark the skip: ' + JSON.stringify(r.last));
    if(!r.skipped || r.skipped[0].kind !== 'step' || r.skipped[0].state !== 'initiateTransaction' || !r.skipped[0].by) throw new Error('no skip record: ' + JSON.stringify(r.skipped));
    if(r.newComms || r.newTasks) throw new Error('Skip sent ' + r.newComms + ' mail(s) and raised ' + r.newTasks + ' task(s)');
    if(!r.audit) throw new Error('no audit line');
    return 'Place Order → Transaction Placed; only the stage, its history and the skip record changed';
  });

  await t.step('a mandatory check inside a step can be passed over for the bulk client, and is recorded', async () => {
    const r = await t.eval(async (ids)=>{
      /* Another bulk client at Place Order: "Transaction Placed" normally waits
         for the allocation to be marked Done — Reviewed. */
      const now = new Date().toISOString();
      const c = {id: uid('CMS'), cmsName: 'ZZ Bulk Two', createdVia: 'Platform upload · Motilal', createdAt: now,
        cmsStage: 'initiateTransaction', blueprintHistory: [{state: 'initiateTransaction', at: now, by: currentUser}]};
      DB.clients.push(c); await save('clients');
      await doTransition('CMS', c.id, 'transactionPlacedT');
      for(let i = 0; i < 20 && c.cmsStage === 'initiateTransaction'; i++) await new Promise(z=>setTimeout(z, 100));
      await new Promise(z=>setTimeout(z, 600));
      return {stage: c.cmsStage, reviewed: c.placeOrderReviewedAt || '', skipped: (c.cmsSkipped || []).map(x=>x.kind + ':' + x.what)};
    }, ids);
    if(r.stage !== 'transactionPlaced') throw new Error('stage is ' + r.stage);
    if(r.reviewed) throw new Error('the review was filled in: ' + r.reviewed);
    if(!r.skipped.some(x=>/^field:Done — Reviewed/.test(x))) throw new Error('the skipped check is not recorded: ' + r.skipped);
    if(!t.dialogs.some(d=>/bulk upload, so this can be skipped/.test(d))) throw new Error('nobody was asked');
    return 'asked, then moved to Transaction Placed; review left empty, recorded as skipped';
  });

  await t.step('Skip again: Transaction Placed → Unit Allotted', async () => {
    const r = await t.eval(async (ids)=>{ await cmsSkipStep(ids.bulk); await new Promise(z=>setTimeout(z, 300)); return DB.clients.find(x=>x.id === ids.bulk).cmsStage; }, ids);
    if(r !== 'unitAllotted') throw new Error('stage is ' + r);
    return r;
  });

  await t.step('a required field can be skipped from its box without anything written into it', async () => {
    const r = await t.eval(async (ids)=>{
      await cmsSkipStep(ids.bulk);                                   // Unit Allotted → Family Mapping
      await new Promise(z=>setTimeout(z, 150));
      await doTransition('CMS', ids.bulk, 'familyMember');            // needs the family head
      await new Promise(z=>setTimeout(z, 150));
      const skipBtn = [...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim() === 'Skip');
      if(!skipBtn) return {err: 'no Skip in the required-field box'};
      skipBtn.click();
      for(let i = 0; i < 20 && DB.clients.find(x=>x.id === ids.bulk).cmsStage === 'familyMapping'; i++) await new Promise(z=>setTimeout(z, 100));
      await new Promise(z=>setTimeout(z, 800));                       // the move finishes saving before the next press
      const c = DB.clients.find(x=>x.id === ids.bulk);
      return {stage: c.cmsStage, head: c.familyHeadLookup, skipped: c.cmsSkipped.map(x=>x.kind + ':' + x.what)};
    }, ids);
    if(r.err) throw new Error(r.err);
    if(r.stage !== 'loginCredentials') throw new Error('stage is ' + r.stage);
    if(r.head) throw new Error('something was written into the family head: ' + r.head);
    if(!r.skipped.some(x=>/^field:/.test(x) && /Family Head/i.test(x))) throw new Error('the skipped field is not recorded: ' + r.skipped);
    return 'moved to Login Credentials; family head left empty, recorded as skipped';
  });

  await t.step('the progress bar marks the skipped steps, and Ready to Convert has no Skip', async () => {
    const r = await t.eval(async (ids)=>{
      await cmsSkipStep(ids.bulk);                                   // Login Credentials → Ready to Convert
      await new Promise(z=>setTimeout(z, 200));
      navigate('cms', ids.bulk);
      await new Promise(z=>setTimeout(z, 200));
      const skipped = [...document.querySelectorAll('.step.skipped .lbl')].map(x=>x.textContent.replace('(skipped)', '').trim());
      const skipBtn = [...document.querySelectorAll('#content button')].some(b=>/^Skip/.test(b.textContent.trim()));
      return {stage: DB.clients.find(x=>x.id === ids.bulk).cmsStage, skipped, skipBtn,
        note: (document.getElementById('content').innerText.match(/Skipped \(bulk upload client\):[^\n]*/) || [''])[0]};
    }, ids);
    if(r.stage !== 'readyForRMS') throw new Error('stage is ' + r.stage);
    for(const s of ['Place Order', 'Unit Allotted', 'Login Credentials & Platform Link'])
      if(r.skipped.indexOf(s) < 0) throw new Error(s + ' is not marked skipped: ' + r.skipped.join(', '));
    if(r.skipBtn) throw new Error('Ready to Convert offers Skip');
    if(!r.note) throw new Error('no list of what was skipped');
    return 'marked: ' + r.skipped.join(', ');
  });

  await t.step('the LMS client is held exactly as before', async () => {
    const r = await t.eval(async (ids)=>{
      await doTransition('CMS', ids.lms, 'transactionPlacedT');
      await new Promise(z=>setTimeout(z, 150));
      const c = DB.clients.find(x=>x.id === ids.lms);
      let threw = '';
      try { await cmsSkipStep(ids.lms); } catch(e){ threw = e.message; }
      return {stage: DB.clients.find(x=>x.id === ids.lms).cmsStage, skipped: c.cmsSkipped || null};
    }, ids);
    if(r.stage !== 'initiateTransaction') throw new Error('the LMS client moved to ' + r.stage);
    if(r.skipped) throw new Error('a skip was recorded on the LMS client');
    if(!t.dialogs.some(d=>/Done — Reviewed/.test(d) && !/bulk upload/.test(d))) throw new Error('the LMS client did not get the usual message');
    return 'stopped at Place Order with the usual message; Skip refused';
  });

  await t.step('who counts as bulk upload: imports and uploads yes, LMS and the New Client form no', async () => {
    const r = await t.eval(async ()=>{
      const plan = impBackPlan('clients', [{cmsName: 'ZZ Sheet Client', mobile: '9833333333'}]);
      const undo = {created: [], updated: []};
      await impBackWrite([plan], undo);
      const sheet = DB.clients.find(c=>c.cmsName === 'ZZ Sheet Client');
      /* An older sheet import, before the mark: known from what that import created. */
      const old = {id: uid('CMS'), cmsName: 'ZZ Old Sheet Client'};
      DB.clients.push(old);
      DB.importUndo = (DB.importUndo || []).concat([{id: uid('IUN'), created: [{srcId: 'clients', id: old.id}], updated: []}]);
      return {sheetVia: sheet && sheet.createdVia,
        sheet: cmsIsBulkClient(sheet), old: cmsIsBulkClient(old),
        upload: cmsIsBulkClient({createdVia: 'Platform upload · Motilal'}),
        lms: cmsIsBulkClient({createdVia: 'Platform import · NJ', convertedFromLeadId: 'LMS-1'}),
        manual: cmsIsBulkClient({id: 'CMS-MANUAL', cmsName: 'Typed in'})};
    });
    if(r.sheetVia !== 'Bulk upload' || !r.sheet) throw new Error('a sheet import is not marked: ' + JSON.stringify(r));
    if(!r.old || !r.upload) throw new Error('older imports or uploads are not recognised: ' + JSON.stringify(r));
    if(r.lms || r.manual) throw new Error('an LMS or hand-made client counts as bulk: ' + JSON.stringify(r));
    return 'sheet, older sheet and platform upload: bulk; LMS and New Client: not';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
