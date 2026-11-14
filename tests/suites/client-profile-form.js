/* THE CLIENT PROFILE FORM — ASKS ONLY WHAT THE RECORD IS MISSING.

   From the firm's Client Profile sheet (changes 13-11-2026): a form in the
   Forms module like FQ, ISEQ, CIF and C&T. Send Form on a client generates
   a link holding only the questions the client's profile has blank; what the
   client sends back shows in its own card under Client Information, without
   repeating what that card already shows. */
const {suite} = require('../lib/harness');

suite(async t => {
  let cid, token;

  await t.step('it is in the forms library and the Forms rail, with the sheet\'s questions', async () => {
    const r = await t.eval(()=>({meta: formMeta('CLIENT_PROFILE'), qs: formQuestionCount('CLIENT_PROFILE'),
      view: !!formModuleFor('profileforms'),
      fam: (formFields('CLIENT_PROFILE').find(f=>f.k === 'cp_family') || {}).cols}));
    if(!r.meta || r.meta.category !== 'Profile') throw new Error('not in the library: ' + JSON.stringify(r.meta));
    if(r.qs < 40) throw new Error('only ' + r.qs + ' questions');
    if(!r.view) throw new Error('no Client Profile Forms module');
    if(!r.fam || r.fam.length !== 7) throw new Error('family table columns: ' + JSON.stringify(r.fam));
    const page = await t.eval(async ()=>{ navigate('profileforms'); await new Promise(z=>setTimeout(z, 200)); return document.getElementById('content').innerText; });
    if(!/Client Profile/i.test(page)) throw new Error('the module page did not draw');
    return r.qs + ' questions; module page draws';
  });

  await t.step('Send Form on a client offers it, and the link asks only what is blank', async () => {
    cid = await t.eval(async ()=>{
      const c = {id: uid('CMS'), cmsName: 'ZZ Profile Client', mobile: '9876500001', email: 'zz.profile@finowise.test', dob: '1985-04-02',
        profession: 'Doctor', mailingCity: 'Varanasi', rmName: currentUser, createdAt: new Date().toISOString(), createdBy: currentUser};
      initState('CMS', c); DB.clients.push(c); await save('clients'); return c.id;
    });
    const r = await t.eval(async (cid)=>{
      openSendCustomFormModal('CMS', cid);
      const sel = document.getElementById('f_sendFormId');
      const offered = [...sel.options].some(o=>o.value === 'CLIENT_PROFILE');
      sel.value = 'CLIENT_PROFILE';
      await submitSendCustomForm('CMS', cid);
      const link = DB.docLinks.filter(l=>l.type === 'CLIENT_PROFILE' && l.recordId === cid).pop();
      return {offered, link};
    }, cid);
    if(!r.offered) throw new Error('Send Form does not offer the Client Profile');
    if(!r.link || !Array.isArray(r.link.onlyFields)) throw new Error('no link, or it asks everything');
    const asked = r.link.onlyFields;
    const leaked = ['cp_name', 'cp_mobile', 'cp_email', 'cp_dob', 'cp_profession', 'cp_city'].filter(k=>asked.includes(k));
    if(leaked.length) throw new Error('asks what the record already holds: ' + leaked.join(', '));
    if(!asked.includes('cp_gender') || !asked.includes('cp_family')) throw new Error('does not ask what is blank: ' + asked.join(','));
    token = r.link.token;
    return asked.length + ' questions asked; name, mobile, e-mail, DOB, profession and city left out';
  });

  await t.step('the client\'s page shows only those questions, and they send it back', async () => {
    await t.doc(token);
    const r = await t.eval(()=>({
      gender: !!document.getElementById('f_cp_gender'), mobile: !!document.getElementById('f_cp_mobile'),
      name: !!document.getElementById('f_cp_name'), rel: (document.getElementById('f_cp_family_r0_relationship') || {}).value}));
    if(!r.gender) throw new Error('a blank question is not on the page');
    if(r.mobile || r.name) throw new Error('a question the record already answers is on the page');
    if(r.rel !== 'Spouse') throw new Error('the family table does not start with the sheet\'s relationships: ' + r.rel);
    await t.eval(async (tok)=>{
      document.getElementById('f_cp_gender').value = 'Male';
      document.getElementById('f_cp_hobbies').value = 'Reading, cricket';
      document.getElementById('f_cp_family_r0_name').value = 'ZZ Spouse Name';
      document.getElementById('f_cp_family_r0_mobile').value = '9876500002';
      await submitDocForm(tok);
    }, token);
    await t.wait(800);
    return 'answered: gender, hobbies, spouse';
  });

  await t.step('back in the CRM: a card under Client Information shows what came back, and only that', async () => {
    await t.home();
    const r = await t.eval(async (cid)=>{
      window._clientTab = 'overview'; navigate('cms', cid);
      await new Promise(z=>setTimeout(z, 300));
      const card = document.getElementById('clientProfileCard');
      return card ? card.innerText : '';
    }, cid);
    if(!r) throw new Error('no Client Profile card on the client\'s page');
    if(!/Male/.test(r) || !/Reading, cricket/.test(r) || !/ZZ Spouse Name/.test(r)) throw new Error('the card is missing answers: ' + r.slice(0, 400));
    if(/Son\b/.test(r)) throw new Error('empty family rows are shown');
    if(/9876500001|zz\.profile@/.test(r)) throw new Error('the card repeats Client Information');
    return 'gender, hobbies and the spouse shown; nothing repeated';
  });

  await t.step('the next link asks only what is still missing', async () => {
    const r = await t.eval(async (cid)=>{
      const c = DB.clients.find(x=>x.id === cid);
      return cpfMissingKeys(c);
    }, cid);
    if(r.includes('cp_gender') || r.includes('cp_hobbies') || r.includes('cp_family')) throw new Error('asks again: ' + r.join(','));
    if(!r.includes('cp_likes')) throw new Error('stopped asking what is still blank');
    return r.length + ' still to ask';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
