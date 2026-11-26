/* WEBSITE FQ RESULTS (website-fq.js, POST /api/public/website-lead).

   Every FQ test taken on the website is kept, whether or not the visitor
   asks to talk:
   · consent: true  → a lead (as before) and a result linked to it;
   · consent: false → a result only — no lead, no task, nobody asked to call;
     with or without contact details; filed against an existing lead (same
     mobile) as history, without touching that lead's consent;
   · Forms › Website FQ Results lists them with filters and search, and any
     row — or a website lead's "More Details →" — opens the whole result:
     score, points, band, life stage, sections, every question and answer,
     attempt by attempt;
   · a partner cannot read them; an RM on Own scope sees only those of
     their own leads. */
const http = require('http');
const {suite, PORT} = require('../lib/harness');

function req(method, path, opts){
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = {Host: 'localhost:' + PORT};
    let body = null;
    if(opts.json !== undefined){ body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    if(opts.form){ body = new URLSearchParams(opts.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if(opts.cookie) headers.Cookie = opts.cookie;
    if(body !== null) headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({host: '127.0.0.1', port: PORT, method, path, headers}, res => {
      let data = ''; res.on('data', d => data += d);
      res.on('end', () => {
        const set = [].concat(res.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('finowise_session='));
        let json = null; try { json = JSON.parse(data); } catch(e) {}
        resolve({status: res.statusCode, json, text: data, cookie: set || opts.cookie || ''});
      });
    });
    r.on('error', reject);
    if(body !== null) r.write(body);
    r.end();
  });
}
const FQ = (score, extra) => Object.assign({score, band: score >= 60 ? 'Wise Planner' : 'Impulse Explorer', points: score, max: 100,
  stage: 'FQ_YOUNG', stageLabel: 'Young & Single', completedAt: new Date().toISOString(),
  sections: [{name: 'Earn', score: 18, max: 25}, {name: 'Spend', score: 9, max: 25}, {name: 'Save', score: 20, max: 25}, {name: 'Invest', score: 15, max: 25}],
  pillars: {Earn: 18, Spend: 9, Save: 20, Invest: 15},
  answers: [
    {pillar: 'Earn', question: 'How stable is your income?', answer: 'Salaried, steady', option: 'A', points: 4},
    {pillar: 'Spend', question: 'How do you spend a bonus?', answer: 'On something I want', option: 'C', points: 1},
    {pillar: 'Save', question: 'Do you have an emergency fund?', answer: 'Yes, six months', option: 'A', points: 5},
    {pillar: 'Invest', question: 'How do you choose investments?', answer: 'Ask a friend', option: 'B', points: 2}]}, extra || {});
const post = body => req('POST', '/api/public/website-lead', {json: body});

suite(async t => {
  const ids = {};
  const admin = (await req('POST', '/login', {form: {email: 'test@finowise.test', password: 'testpassword1'}})).cookie;
  const store = async (key, who) => JSON.parse((await req('GET', '/api/storage/' + key, {cookie: who || admin})).json.value || '[]');

  await t.step('a visitor who does not ask to talk is kept as a result — no lead, no task', async () => {
    const before = (await store('leads')).length, tasksBefore = (await store('tasks')).length;
    const r = await post({consent: false, name: 'ZZ Declined Visitor', mobile: '9811100001', email: 'zz.declined@example.com', city: 'Pune', fq: FQ(42)});
    const anon = await post({consent: false, fq: FQ(71)});
    const bad = await post({consent: false, name: 'ZZ Bad', mobile: '12345', fq: FQ(30)});
    const noScore = await post({consent: false, fq: {answers: []}});
    const results = await store('websiteFqResults');
    const row = results.find(x => x.name === 'ZZ Declined Visitor');
    const leads = await store('leads'), tasks = await store('tasks');
    if(r.status !== 200 || !r.json.stored || anon.status !== 200 || bad.status !== 400 || noScore.status !== 400) throw new Error(JSON.stringify({r: r.status, anon: anon.status, bad: bad.status, noScore: noScore.status}));
    if(!row || row.consentToConnect || row.leadId || row.fqTest.answers.length !== 4 || row.fqTest.sections.length !== 4) throw new Error('row ' + JSON.stringify(row));
    if(leads.length !== before || tasks.length !== tasksBefore) throw new Error('a lead or task was made');
    if(!results.find(x => !x.name && x.score === 71)) throw new Error('the anonymous result was not kept');
    ids.declined = row.id;
    return 'declined visitor and an anonymous one kept with all 4 answers and 4 sections; bad mobile and missing score refused; no lead, no task';
  });

  await t.step('a visitor who asks to talk becomes a lead, and their result is linked to it', async () => {
    const r = await post({consent: true, name: 'ZZ Keen Visitor', mobile: '9811100002', email: 'zz.keen@example.com', city: 'Varanasi', fq: FQ(64)});
    const lead = (await store('leads')).find(l => l.mobile === '9811100002');
    const row = (await store('websiteFqResults')).find(x => x.mobile === '9811100002');
    if(r.status !== 200 || !r.json.created || !lead || !row || row.leadId !== lead.id || !row.consentToConnect || !row.leadCreated) throw new Error(JSON.stringify({r: r.json, row}));
    ids.keenLead = lead.id; ids.keen = row.id;
    return 'lead ' + lead.id + ' created; result ' + row.id + ' linked to it';
  });

  await t.step('the same person taking it again without asking to talk is filed as history on their lead', async () => {
    const r = await post({consent: false, name: 'ZZ Keen Visitor', mobile: '9811100002', fq: FQ(70)});
    const leads = (await store('leads')).filter(l => l.mobile === '9811100002');
    const row = (await store('websiteFqResults')).filter(x => x.mobile === '9811100002').find(x => !x.consentToConnect);
    if(r.status !== 200 || leads.length !== 1 || !row || row.leadId !== ids.keenLead) throw new Error(JSON.stringify({status: r.status, leads: leads.length, row}));
    if(leads[0].fqHistory.length !== 2 || leads[0].consentToConnect !== true || leads[0].fqTest.score !== 64) throw new Error('lead changed: ' + JSON.stringify({h: leads[0].fqHistory.length, c: leads[0].consentToConnect, s: leads[0].fqTest.score}));
    return 'no second lead; the attempt joins their history (2), their consent and current score untouched';
  });

  await t.step('Forms › Website FQ Results lists every result, with filters and search', async () => {
    const r = await t.eval(async () => {
      DB.websiteFqResults = await sget('websiteFqResults', []); DB.leads = await sget('leads', []);
      navigate('webfq'); await new Promise(r => setTimeout(r, 150));
      const n = () => document.querySelectorAll('#wfqTable tbody tr').length;
      const out = {inMenu: !!NAV_GROUPS.find(g => g.id === 'forms').items.includes('webfq'), title: (document.querySelector('#content .mod-head h2') || {}).textContent || '',
        all: n(), stats: [...document.querySelectorAll('.wfq-stats b')].map(b => b.textContent)};
      wfqSet('consent', 'No'); out.no = n();
      wfqSet('consent', 'Yes'); out.yes = n();
      wfqSet('consent', 'All');
      const box = document.getElementById('wfqSearch'); box.value = 'declined'; box.dispatchEvent(new Event('input', {bubbles: true})); out.search = n();
      wfqSearch(''); wfqSet('band', 'Wise Planner'); out.band = n(); wfqSet('band', '');
      return out;
    });
    if(!r.inMenu || !/Website FQ Results/.test(r.title) || r.all !== 4 || r.no !== 3 || r.yes !== 1 || r.search !== 1 || r.band !== 3) throw new Error(JSON.stringify(r));
    return r.all + ' results (3 did not ask to talk, 1 did); search and category filter narrow it; stats ' + r.stats.join('/');
  });

  await t.step('any row opens the whole result: score, sections, every answer — attempt by attempt', async () => {
    const r = await t.eval(async (ids) => {
      wfqOpen(ids.declined); await new Promise(r => setTimeout(r, 80));
      const m = document.getElementById('modalBody');
      const out = {dial: (m.querySelector('.wfq-dial b') || {}).textContent, band: (m.querySelector('.wfq-band') || {}).textContent,
        bars: m.querySelectorAll('.fqa-bar').length, answers: m.querySelectorAll('.wfq-answers tr').length,
        firstQ: (m.querySelector('.wfq-answers .q') || {}).textContent, contact: m.textContent.includes('9811100001'),
        consent: /Did not ask to be contacted/.test(m.textContent), wide: !!document.querySelector('.modal.wide')};
      closeModal();
      wfqOpen(ids.keen); await new Promise(r => setTimeout(r, 80));
      out.tabs = [...document.querySelectorAll('#modalBody .tabs .tab')].map(b => b.textContent.trim().replace(/\s+/g, ' '));
      out.openLead = !!document.querySelector('.modal-foot .btn.primary, #modalFoot .btn.primary, .modal .btn.primary');
      closeModal();
      return out;
    }, ids);
    if(r.dial !== '42' || r.band !== 'Impulse Explorer' || r.bars !== 4 || r.answers !== 4 || r.firstQ !== 'How stable is your income?' || !r.contact || !r.consent || !r.wide) throw new Error(JSON.stringify(r));
    if(r.tabs.join('|') !== 'Latest · 70|Attempt 1 · 64' || !r.openLead) throw new Error('attempts: ' + JSON.stringify(r));
    return 'score 42, Impulse Explorer, 4 section bars, 4 answers with their points; the keen visitor’s two attempts as tabs';
  });

  await t.step('a website lead’s "More Details →" opens its result in full', async () => {
    const r = await t.eval(async (id) => {
      openFqDetails(id); await new Promise(r => setTimeout(r, 120));
      const m = document.getElementById('modalBody');
      const out = {title: (document.querySelector('.modal h3, .modal .modal-title, #modalTitle') || {}).textContent || '', answers: m ? m.querySelectorAll('.wfq-answers tr').length : 0};
      closeModal();
      return out;
    }, ids.keenLead);
    if(!/ZZ Keen Visitor/.test(r.title) || r.answers !== 4) throw new Error(JSON.stringify(r));
    return 'opens "' + r.title.trim() + '" with every answer';
  });

  await t.step('partners cannot read them; an RM on Own scope sees only their own leads’ results', async () => {
    const team = await store('team');
    const keen = (await store('leads')).find(l => l.id === ids.keenLead);
    team.push({id: 'ZRM', name: 'ZZ RM', email: 'zrm@zz.test', role: 'Relationship Manager', scope: 'own', status: 'Active', perms: {}},
              {id: 'ZPT', name: 'ZZ Partner', email: 'zpt@zz.test', partnerPobId: 'ZPOB', partnerLevel: 'L3', scope: 'team', status: 'Active'});
    const tp = await req('PUT', '/api/storage/team', {cookie: admin, json: {value: JSON.stringify(team)}});
    if(tp.status !== 200) throw new Error('team ' + tp.status + ' ' + tp.text);
    // The keen lead (and so its results) belongs to the RM.
    await req('PUT', '/api/storage/leads', {cookie: admin, json: {patch: {kind: 'rows', changes: [{id: keen.id, set: {assignedTo: 'ZRM'}}]}}});
    const rows = await store('websiteFqResults');
    await req('PUT', '/api/storage/websiteFqResults', {cookie: admin, json: {patch: {kind: 'rows',
      changes: rows.filter(x => x.leadId === keen.id).map(x => ({id: x.id, set: {assignedTo: 'ZRM'}}))}}});
    const sign = async (id, email) => {
      const a = await req('POST', '/api/users/sync', {cookie: admin, json: {memberId: id, email}});
      if(!a.json || !a.json.ok) throw new Error('account for ' + id + ': ' + a.status + ' ' + a.text);
      const s = await req('POST', '/login', {form: {email, password: a.json.password}});
      return (await req('POST', '/api/account/password', {cookie: s.cookie, json: {current: a.json.password, password: 'Zz!wfq-9' + id, confirm: 'Zz!wfq-9' + id}})).cookie;
    };
    const rm = await sign('ZRM', 'zrm@zz.test'), pt = await sign('ZPT', 'zpt@zz.test');
    const rmRows = await store('websiteFqResults', rm);
    const ptRes = await req('GET', '/api/storage/websiteFqResults', {cookie: pt});
    const ptRows = ptRes.status === 200 ? JSON.parse(ptRes.json.value) : [];
    if(rmRows.length !== 2 || rmRows.some(x => x.leadId !== keen.id)) throw new Error('RM sees ' + JSON.stringify(rmRows.map(x => x.name)));
    if(ptRows.length) throw new Error('a partner read ' + ptRows.length + ' result(s)');
    return 'RM sees the 2 results of their own lead (not the declined strangers); the partner sees none';
  });
});
