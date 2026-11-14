/* The firm's own partner codes. BOSS numbers a partner FLX-P-0001 … when
   nobody says otherwise; a firm that already has partner IDs uploads them
   instead of retyping each one. Upload Partner Codes matches each row to a
   partner by current code, application ID, email, mobile or name, and the
   new code replaces the old one on the partner, their clients and their
   login. Its template is the firm's own partner list with the Partner Code
   column empty. Import Active Partners takes a Partner Code column too. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  const pick = (id, read, text) => t.eval(async ({id, read, text}) => {
    const input = document.getElementById(id);
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'codes.csv', {type: 'text/csv'}));
    input.files = dt.files;
    await window[read](input);
  }, {id, read, text});

  let ids = {};
  await t.step('three partners, numbered by BOSS', async () => {
    ids = await t.eval(async () => {
      window.alert = () => {};
      const out = {};
      for(const [first, last, mobile, email] of [['Asha', 'Code', '9876500001', 'asha.code@example.com'],
        ['Bina', 'Code', '9876500002', 'bina.code@example.com'], ['Chet', 'Code', '9876500003', 'chet.code@example.com']]){
        const p = {id: uid('PMS'), firstName: first, lastName: last, mobile, email, assignedTo: currentUser, createdAt: new Date().toISOString()};
        initState('PMS', p); p.pmsStage = 'onboarded'; pjPartners().push(p);
        const r = await pobStart(p.id, {quiet: true});
        out[first] = {id: r.id, code: r.partnerCode, app: r.applicationId};
      }
      await save('pjPartners');
      const asha = pobRecords().find(r => r.id === out.Asha.id);
      DB.clients.push({id: 'CL-CODE-1', cmsName: 'Client Of Asha', partnerPobId: asha.id, partnerCode: asha.partnerCode, createdAt: new Date().toISOString()});
      await save('clients');
      DB.team.push({id: 'TM-CODE-ASHA', name: 'Asha Code', email: 'asha.code@example.com', partnerPobId: asha.id, employeeId: asha.partnerCode,
        role: 'Partner', status: 'Active', scope: 'own', perms: fullPerms(false), adminFlags: {}, createdAt: new Date().toISOString()});
      await save('team');
      return out;
    });
    if(!/^FLX-P-\d{4}$/.test(ids.Asha.code) || ids.Asha.code === ids.Bina.code) throw new Error(JSON.stringify(ids));
    return Object.values(ids).map(x => x.code).join(', ');
  });

  await t.step('PMS offers Upload Partner Codes, and its template is the firm\'s own list', async () => {
    const r = await t.eval(async () => {
      window._pobTab = 'partners'; navigate('pob');
      const button = /Upload Partner Codes/.test(document.getElementById('content').textContent);
      let csv = '';
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = b => { b.text().then(x => { csv = x; }); return 'blob:x'; };
      const realClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function(){};
      pobCodeTemplate();
      await new Promise(r => setTimeout(r, 100));
      URL.createObjectURL = realCreate; HTMLAnchorElement.prototype.click = realClick;
      return {button, csv};
    });
    if(!r.button) throw new Error('no Upload Partner Codes button on PMS');
    const lines = r.csv.replace(/^﻿/, '').trim().split('\n');
    if(lines[0] !== 'Partner Code,Current Code,Application ID,Full Name,Email,Mobile') throw new Error(lines[0]);
    for(const k of ['Asha', 'Bina', 'Chet'])
      if(!lines.some(l => l.startsWith(',' + ids[k].code + ',' + ids[k].app + ',' + k + ' Code,'))) throw new Error(k + ' is not on the template: ' + r.csv);
    return lines.length - 1 + ' partners on the template, Partner Code left to fill in';
  });

  await t.step('each row finds its partner; a code twice, or somebody else\'s, is refused', async () => {
    await t.eval(() => pobOpenCodeUpload());
    const sheet = 'Partner Code,Current Code,Application ID,Full Name,Email,Mobile\n'
      + 'OUR-001,' + ids.Asha.code + ',,,,\n'      // by current code
      + 'OUR-002,,,,BINA.CODE@example.com,\n'      // by email, any case
      + 'OUR-002,,,,,98765 00003\n'                // the same code again
      + 'OUR-009,,,Nobody Here,,\n';               // nobody
    await pick('pobCodeFile', 'pobCodeRead', sheet);
    const r = await t.eval(() => ({plan: window._pobCodes.map(p => ({who: p.r ? pjName(p.r) : '', by: p.by, skip: p.skip, why: p.problems.join('; ')})),
      button: document.getElementById('pobCodeGo').textContent}));
    const [a, b, c, d] = r.plan;
    if(a.who !== 'Asha Code' || a.by !== 'current code' || a.skip) throw new Error(JSON.stringify(a));
    if(b.who !== 'Bina Code' || b.by !== 'email' || b.skip) throw new Error(JSON.stringify(b));
    if(c.who !== 'Chet Code' || c.by !== 'mobile' || !c.skip || !/twice/.test(c.why)) throw new Error(JSON.stringify(c));
    if(!d.skip || !/no partner found/.test(d.why)) throw new Error(JSON.stringify(d));
    if(r.button !== 'Update 2 Partner Codes') throw new Error(r.button);
    return 'Asha by current code, Bina by email; the repeated code and the unknown name skipped';
  });

  await t.step('the new code is on the partner, their client and their login, and in the list', async () => {
    const r = await t.eval(async ids => {
      await pobCodeApply();
      const asha = pobRecords().find(x => x.id === ids.Asha.id), bina = pobRecords().find(x => x.id === ids.Bina.id);
      return {asha: asha.partnerCode, bina: bina.partnerCode, history: (asha.codeHistory||[]).map(h => h.from + '>' + h.to).join(),
        client: DB.clients.find(c => c.id === 'CL-CODE-1').partnerCode, member: DB.team.find(m => m.id === 'TM-CODE-ASHA').employeeId,
        list: document.getElementById('pobTable').textContent, view: currentView};
    }, ids);
    if(r.asha !== 'OUR-001' || r.bina !== 'OUR-002') throw new Error(JSON.stringify(r));
    if(r.history !== ids.Asha.code + '>OUR-001') throw new Error('history: ' + r.history);
    if(r.client !== 'OUR-001' || r.member !== 'OUR-001') throw new Error('copies not updated: ' + JSON.stringify(r));
    if(r.view !== 'pob' || !/OUR-001/.test(r.list) || !/OUR-002/.test(r.list)) throw new Error('the list does not show them');
    return 'Asha OUR-001 (client and login too), Bina OUR-002, both shown on PMS';
  });

  await t.step('two partners can swap codes, and a code one holds cannot be given to another', async () => {
    await t.eval(() => pobOpenCodeUpload());
    await pick('pobCodeFile', 'pobCodeRead', 'Partner Code,Current Code\nOUR-002,OUR-001\nOUR-001,OUR-002\n');
    const swap = await t.eval(() => window._pobCodes.map(p => p.skip).join());
    if(swap !== 'false,false') throw new Error('the swap was refused: ' + JSON.stringify(await t.eval(() => window._pobCodes.map(p => p.problems))));
    const r = await t.eval(async ids => {
      await pobCodeApply();
      const code = id => pobRecords().find(x => x.id === id).partnerCode;
      return {asha: code(ids.Asha.id), bina: code(ids.Bina.id)};
    }, ids);
    if(r.asha !== 'OUR-002' || r.bina !== 'OUR-001') throw new Error(JSON.stringify(r));
    await t.eval(() => pobOpenCodeUpload());
    await pick('pobCodeFile', 'pobCodeRead', 'Partner Code,Full Name\nOUR-001,Chet Code\n');
    const taken = await t.eval(() => window._pobCodes[0]);
    if(!taken.skip || !/already belongs to Bina Code/.test(taken.problems.join())) throw new Error(JSON.stringify(taken.problems));
    await t.eval(() => closeModal());
    return 'Asha and Bina swapped; OUR-001 refused for Chet while Bina holds it';
  });

  await t.step('Import Active Partners takes the firm\'s Partner Code, and numbers the rest itself', async () => {
    await t.eval(() => pobOpenImportActive());
    const head = 'Full Name,Partner Code,Access Email,Level\n';
    await pick('pobImpFile', 'pobImportRead', head + 'Dev Code,OUR-050,dev.code@example.com,L1\nEla Code,,ela.code@example.com,L1\nFay Code,OUR-002,fay.code@example.com,L1\n');
    const plan = await t.eval(() => window._pobImport.map(p => ({name: p.x.name, code: p.x.partnerCode, skip: p.skip, why: p.problems.join('; ')})));
    if(plan[0].code !== 'OUR-050' || plan[0].skip || plan[1].skip) throw new Error(JSON.stringify(plan));
    if(!plan[2].skip || !/already belongs to Asha Code/.test(plan[2].why)) throw new Error(JSON.stringify(plan[2]));
    const r = await t.eval(async () => {
      await pobImportApply();
      const by = n => pobLive().find(x => pjName(x) === n) || {};
      return {dev: by('Dev Code').partnerCode, ela: by('Ela Code').partnerCode};
    });
    if(r.dev !== 'OUR-050' || !/^FLX-P-\d{4}$/.test(r.ela || '')) throw new Error(JSON.stringify(r));
    return 'Dev imported as OUR-050, Ela numbered ' + r.ela + ', Fay refused (OUR-002 is Asha\'s)';
  });

  await t.step('nothing was alerted', async () => {
    if(t.dialogs.length) throw new Error('alerts: ' + t.dialogs.join(' | ').slice(0, 200));
    return 'none';
  });
});
