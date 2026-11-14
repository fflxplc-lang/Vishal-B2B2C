/* EXPORT ON CMS TAKES A CLIENT'S COMPLETE DATA (changes 14-11-2026).

   Every field on the record, including ones no screen shows, the answers to
   their forms, the journey, and every record linked to them in any store —
   for the ticked clients, for one client from its own page, or for every
   client the person can see. A field closed to their role stays out;
   passwords and link tokens never leave; a file goes out as its name. */
const {suite} = require('../lib/harness');

suite(async t => {
  let ids;
  /* Catch the workbook instead of downloading it. */
  const capture = `(function(){ window._zzBook = null; window._zzRealXlsx = window._zzRealXlsx || downloadXlsx;
    downloadXlsx = function(sheets, name){ window._zzBook = {name, sheets}; return 1; }; })`;
  const sheet = (book, name) => (book.sheets.find(s=>s.name === name) || {rows: []}).rows;

  await t.step('two clients, with records linked to them across the system', async () => {
    ids = await t.eval(async ()=>{
      const now = new Date().toISOString(), today = now.slice(0, 10);
      const leadId = uid('LMS');
      const mk = (name, extra)=>{ const c = Object.assign({id: uid('CMS'), cmsName: name, mobile: '9000011111', email: 'zz.exp@finowise.test', pan: 'ZZEXP1234E',
        rmName: currentUser, branch: 'Varanasi', createdAt: now, createdBy: currentUser}, extra); initState('CMS', c); DB.clients.push(c); return c; };
      const a = mk('ZZ Export One', {convertedFromLeadId: leadId, zzUnshownField: 'held but on no screen', platformPassword: 'hunter2',
        insPolicyNo: 'POL-ZZ-1', firstNomineeName: 'ZZ Nominee', formData: {CLIENT_PROFILE: {cp_hobbies: 'Chess', cp_family: [{relationship: 'Spouse', name: 'ZZ Wife'}]}},
        notes: [{text: 'a nested note', at: now}], photo: 'data:image/png;base64,' + 'A'.repeat(4000)});
      const b = mk('ZZ Export Two', {});
      const other = mk('ZZ Not Exported', {});
      await save('clients');
      DB.transactions.push({id: uid('TXN'), clientId: a.id, amount: 50000, status: 'Completed', transactionType: 'Purchase', createdAt: now, createdBy: currentUser});
      DB.transactions.push({id: uid('TXN'), clientId: other.id, amount: 1, status: 'Completed', transactionType: 'Purchase', createdAt: now, createdBy: currentUser});
      await save('transactions');
      DB.meetings.push({id: uid('MTG'), clientId: a.id, meetingDate: today, agenda: 'ZZ review', createdAt: now, createdBy: currentUser, organizer: currentUser}); await save('meetings');
      DB.callEntries.push({id: uid('CALL'), leadId, notes: 'ZZ call while a lead', loggedBy: currentUser, createdAt: now}); await save('callEntries');
      const q = {id: uid('QRY'), clientId: a.id, subject: 'ZZ ticket', createdAt: now, createdBy: currentUser}; DB.queries.push(q); await save('queries');
      DB.queryReplies = DB.queryReplies || []; DB.queryReplies.push({id: uid('QRP'), queryId: q.id, text: 'ZZ reply', at: now}); await save('queryReplies');
      const tok = await createDocLink(null, 'CLIENT_PROFILE', {recordModule: 'CMS', recordId: a.id});
      DB.docSubmissions.push({id: uid('DOCSUB'), token: tok, type: 'CLIENT_PROFILE', answers: {cp_hobbies: 'Chess'}, submittedAt: now}); await save('docSubmissions');
      return {a: a.id, b: b.id, other: other.id, tok};
    });
    return 'set up';
  });

  await t.step('one client from its own page: every field and every linked record, in their own sheets', async () => {
    const r = await t.eval(async ({ids, capture})=>{
      eval(capture)();
      window._clientTab = 'overview'; navigate('cms', ids.a); await new Promise(z=>setTimeout(z, 200));
      const btn = [...document.querySelectorAll('#content .prof-head button')].find(b=>/Export/.test(b.textContent));
      if(!btn) return {noButton: true};
      btn.click(); await new Promise(z=>setTimeout(z, 600));
      return {book: window._zzBook};
    }, {ids, capture});
    if(r.noButton) throw new Error('no Export button on the client page');
    const book = r.book;
    if(!book) throw new Error('nothing was exported');
    const names = book.sheets.map(s=>s.name);
    const need = ['Summary', 'Client — All Fields', 'Form Answers', 'Journey History', 'Transactions', 'Meetings', 'Calls', 'Tickets', 'Ticket Replies', 'Forms Sent', 'Forms Returned', 'Nested Details'];
    const missing = need.filter(n=>!names.includes(n));
    if(missing.length) throw new Error('missing sheets: ' + missing.join(', ') + ' — got ' + names.join(', '));
    const all = JSON.stringify(book.sheets);
    const fields = sheet(book, 'Client — All Fields');
    const head = fields[0].join('|');
    if(!/zzUnshownField/.test(head) || !/held but on no screen/.test(JSON.stringify(fields))) throw new Error('a field no screen shows was left out');
    if(!/Policy No|insPolicyNo/.test(head) || !/firstNomineeName/.test(head)) throw new Error('insurance or nominee fields missing');
    if(/hunter2|platformPassword/.test(all)) throw new Error('a password left the building');
    if(new RegExp(ids.tok).test(all)) throw new Error('a form link token was exported');
    if(/AAAAAAAAAA/.test(all)) throw new Error('a file\'s contents were exported');
    if(!/ZZ call while a lead/.test(all)) throw new Error('the call from before they were a client is missing');
    if(!/ZZ reply/.test(all)) throw new Error('the ticket reply is missing');
    if(!/Chess/.test(JSON.stringify(sheet(book, 'Form Answers'))) || !/ZZ Wife/.test(JSON.stringify(sheet(book, 'Form Answers')))) throw new Error('form answers missing');
    if(/ZZ Not Exported|ZZ Export Two/.test(all)) throw new Error('another client\'s data came with it');
    return names.length + ' sheets: ' + names.join(', ');
  });

  await t.step('the ticked clients only, from the CMS Export button', async () => {
    const r = await t.eval(async ({ids, capture})=>{
      eval(capture)();
      bulkSelection.CMS = new Set([ids.a, ids.b]);
      navigate('cms'); await new Promise(z=>setTimeout(z, 200));
      const btn = [...document.querySelectorAll('#content button')].find(b=>/^\W*Export\s*$/.test(b.textContent.trim()) || /Export$/.test(b.textContent.trim()));
      btn.click(); await new Promise(z=>setTimeout(z, 600));
      bulkSelection.CMS = new Set();
      return window._zzBook;
    }, {ids, capture});
    if(!r) throw new Error('nothing was exported');
    const summary = JSON.stringify(sheet(r, 'Summary'));
    if(!/ZZ Export One/.test(summary) || !/ZZ Export Two/.test(summary)) throw new Error('a ticked client is missing');
    if(/ZZ Not Exported/.test(JSON.stringify(r.sheets))) throw new Error('an unticked client came too');
    return r.name;
  });

  await t.step('a field closed to the person\'s role stays out', async () => {
    const r = await t.eval(async ({ids, capture})=>{
      eval(capture)();
      DB.config.fieldSecurity = Object.assign({}, DB.config.fieldSecurity, {'CMS.pan': ['ZZ Nobody']});
      const realAdmin = window.isAdmin; window.isAdmin = ()=>false;
      const realCan = window.can; window.can = ()=>true;
      try { await exportClientsComplete([ids.a]); } finally { window.isAdmin = realAdmin; window.can = realCan; delete DB.config.fieldSecurity['CMS.pan']; }
      return JSON.stringify(window._zzBook ? window._zzBook.sheets : null);
    }, {ids, capture});
    if(r === 'null') throw new Error('nothing was exported');
    if(/ZZEXP1234E/.test(r)) throw new Error('the PAN went out to somebody who may not see it');
    return 'PAN left out';
  });

  await t.step('nothing on the client was changed by exporting it', async () => {
    const r = await t.eval(async (ids)=>{
      const srv = JSON.parse((await (await fetch('/api/storage/clients', {headers: apiHeaders()})).json()).value || '[]').find(c=>c.id === ids.a);
      downloadXlsx = window._zzRealXlsx;
      return {pw: srv.platformPassword, photo: (srv.photo || '').length, unshown: srv.zzUnshownField};
    }, ids);
    if(r.pw !== 'hunter2' || r.photo < 4000 || r.unshown !== 'held but on no screen') throw new Error('the stored record changed: ' + JSON.stringify(r));
    return 'stored record untouched';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
