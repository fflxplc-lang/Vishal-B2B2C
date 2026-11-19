/* TWO PLATFORMS, ONE BACKEND, L1–L7 ENFORCED BY THE SERVER (access.js).

   partner.<host> is the Partner Platform, one.<host> the Company Platform;
   Chromium and this suite both reach them as partner.localhost and
   one.localhost. What is checked:

   · who may sign in where: partners on the partner platform, employees on
     the company platform, admins and L7 on both;
   · what each level is handed by the server: L1/L2 their own records only,
     L3 their own plus the partners mapped below them, L7 everything; an
     employee their own scope plus the partners they are the RM of; HR,
     employee details and company configuration closed to partners;
   · what each may write: nothing outside their reach, no promoting
     themselves, no company configuration, a whole-list save that cannot
     wipe what they were not shown;
   · team building at L5 (and not below), with no company-wide powers;
   · the same record moving both ways between a partner and company Ops;
   · a level change taking effect at once, and the write log. */
const http = require('http');
const {suite, PORT} = require('../lib/harness');

/* One request with a chosen Host, so one server can be both platforms. */
function req(method, host, path, opts){
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({Host: host + ':' + PORT}, opts.headers || {});
    let body = null;
    if(opts.json !== undefined){ body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    if(opts.form){ body = new URLSearchParams(opts.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if(opts.cookie) headers.Cookie = opts.cookie;
    if(body !== null) headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({host: '127.0.0.1', port: PORT, method, path, headers}, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const set = [].concat(res.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('finowise_session='));
        let json = null; try { json = JSON.parse(data); } catch(e) {}
        resolve({status: res.statusCode, text: data, json, cookie: set || opts.cookie || '', location: res.headers.location || ''});
      });
    });
    r.on('error', reject);
    if(body !== null) r.write(body);
    r.end();
  });
}
async function login(host, email, password){
  return req('POST', host, '/login', {form: {email, password, next: '/'}});
}
const ADMIN = {email: 'test@finowise.test', password: 'testpassword1'};
const STRONG = 'Zz!passw0rd-';

suite(async t => {
  const H = {combined: 'localhost', partner: 'partner.localhost', company: 'one.localhost'};
  let admin = (await login(H.combined, ADMIN.email, ADMIN.password)).cookie;
  const get = async (cookie, key, host) => {
    const r = await req('GET', host || H.combined, '/api/storage/' + key, {cookie});
    return r.status === 200 ? JSON.parse(r.json.value) : {status: r.status};
  };
  const put = (cookie, key, body, host, headers) => req('PUT', host || H.combined, '/api/storage/' + key, {cookie, json: body, headers});
  const patch = (cookie, key, p, host) => put(cookie, key, {patch: Object.assign({kind: 'rows'}, p)}, host);
  // This suite's own records (L-…, C-…, T-…, A-…); the admin's page adds sample ones of its own.
  const ids = v => (Array.isArray(v) ? v.map(r => r.id).filter(id => /^[A-Z]-/.test(String(id))).sort().join(',') : JSON.stringify(v));

  const people = {
    E1: {id: 'E1', name: 'ZZ RM Own', email: 'e1@zz.test', role: 'Relationship Manager', scope: 'own', status: 'Active', perms: {}},
    E2: {id: 'E2', name: 'ZZ Ops All', email: 'e2@zz.test', role: 'Operations', scope: 'all', status: 'Active', perms: {}},
    P1: {id: 'P1', name: 'ZZ Partner L1', email: 'p1@zz.test', partnerPobId: 'POB-1', partnerLevel: 'L1', parentUserId: 'P3', scope: 'own', status: 'Active'},
    P2: {id: 'P2', name: 'ZZ Partner L2', email: 'p2@zz.test', partnerPobId: 'POB-2', partnerLevel: 'L2', parentUserId: 'E1', scope: 'own', status: 'Active'},
    P3: {id: 'P3', name: 'ZZ Partner L3', email: 'p3@zz.test', partnerPobId: 'POB-3', partnerLevel: 'L3', parentUserId: 'E1', scope: 'team', status: 'Active'},
    P5: {id: 'P5', name: 'ZZ Partner L5', email: 'p5@zz.test', partnerPobId: 'POB-5', partnerLevel: 'L5', parentUserId: 'E1', scope: 'team', status: 'Active'},
    P6: {id: 'P6', name: 'ZZ Partner L6', email: 'p6@zz.test', partnerPobId: 'POB-6', partnerLevel: 'L6', parentUserId: 'E1', scope: 'team', status: 'Active',
         adminFlags: {manageUsers: 1}},
    P7: {id: 'P7', name: 'ZZ Partner L7', email: 'p7@zz.test', partnerPobId: 'POB-7', partnerLevel: 'L7', scope: 'all', status: 'Active'},
  };
  const session = {};

  await t.step('the test firm: employees, partners L1–L7, and their records', async () => {
    let r = await put(admin, 'team', {value: JSON.stringify(Object.values(people))});
    if(r.status !== 200) throw new Error('team ' + r.status + ' ' + r.text);
    const pobs = ['1', '2', '3', '5', '6', '7'].map(n => ({id: 'POB-' + n, partnerName: 'ZZ POB ' + n, pobStage: 'active',
      assignedTo: n === '7' ? 'E2' : 'E1'}));
    const seed = {
      pjOnboarding: pobs,
      leads: [
        {id: 'L-P1', firstName: 'ZZ Lead of P1', assignedTo: 'P1', partnerPobId: 'POB-1'},
        {id: 'L-P2', firstName: 'ZZ Lead of P2', assignedTo: 'P2', partnerPobId: 'POB-2'},
        {id: 'L-P3', firstName: 'ZZ Lead of P3', assignedTo: 'P3', partnerPobId: 'POB-3'},
        {id: 'L-E1', firstName: 'ZZ Lead of E1', assignedTo: 'E1'},
        {id: 'L-E2', firstName: 'ZZ Lead of E2', assignedTo: 'E2'}],
      clients: [{id: 'C-P1', name: 'ZZ Client of P1', rmName: 'P1', partnerPobId: 'POB-1', city: 'Pune'},
                {id: 'C-E2', name: 'ZZ Client of E2', rmName: 'E2', pan: 'ZZZZZ9999Z'}],
      tasks: [{id: 'T-P1', description: 'ZZ follow up', leadId: 'L-P1', assignTo: 'E2', assignedDate: '2026-11-01', dueDate: '2026-12-01'},
              {id: 'T-E2', description: 'ZZ internal', assignTo: 'E2', assignedDate: '2026-11-01', dueDate: '2026-12-01'}],
      hrAttendance: [{id: 'A-E1', userId: 'E1', date: '2026-11-02', sessions: []}, {id: 'A-P1', userId: 'P1', date: '2026-11-02', sessions: []}],
      apiConnectors: [{id: 'AC-1', name: 'ZZ secret connector'}],
    };
    for(const [k, v] of Object.entries(seed)){
      r = await put(admin, k, {value: JSON.stringify(v)});
      if(r.status !== 200) throw new Error(k + ' ' + r.status + ' ' + r.text);
    }
    /* Accounts, made the way the CRM makes them, then each person chooses
       their own password as the CRM asks them to on first sign-in. */
    for(const p of Object.values(people)){
      const a = await req('POST', H.combined, '/api/users/sync', {cookie: admin, json: {memberId: p.id, email: p.email, admin: !!(p.adminFlags && p.adminFlags.manageUsers) || p.partnerLevel === 'L7'}});
      if(!a.json || !a.json.ok) throw new Error('account for ' + p.id + ': ' + a.text);
      if(p.id === 'P6' && a.json.account.role !== 'user') throw new Error('L6 with Manage Users became a company admin');
      const s = await login(H.combined, p.email, a.json.password);
      const c = await req('POST', H.combined, '/api/account/password', {cookie: s.cookie, json: {current: a.json.password, password: STRONG + p.id, confirm: STRONG + p.id}});
      if(!c.json || !c.json.ok) throw new Error('password for ' + p.id + ': ' + c.text);
      session[p.id] = c.cookie;
    }
    return Object.keys(session).length + ' people signed in; L6 with Manage Users stayed an ordinary account';
  });

  t.section('who signs in where');

  await t.step('partners on the Partner Platform, employees on the Company Platform, admins and L7 on both', async () => {
    const out = {};
    for(const [who, email, pw] of [['P1', 'p1@zz.test', STRONG + 'P1'], ['E1', 'e1@zz.test', STRONG + 'E1'],
                                   ['P7', 'p7@zz.test', STRONG + 'P7'], ['ADMIN', ADMIN.email, ADMIN.password]]){
      out[who] = {partner: (await login(H.partner, email, pw)).status, company: (await login(H.company, email, pw)).status};
    }
    const want = {P1: {partner: 302, company: 403}, E1: {partner: 403, company: 302}, P7: {partner: 302, company: 302}, ADMIN: {partner: 302, company: 302}};
    if(JSON.stringify(out) !== JSON.stringify(want)) throw new Error(JSON.stringify(out));
    const page = await login(H.company, 'p1@zz.test', STRONG + 'P1');
    if(!/Partners sign in at/.test(page.text) || !/Company Platform/.test(page.text)) throw new Error('the refusal does not say where to go');
    const lp = await req('GET', H.partner, '/login');
    if(!/Partner Platform/.test(lp.text)) throw new Error('the partner sign-in page is not branded as such');
    return 'P1 partner-only, E1 company-only, L7 and admin both; each sign-in page says which platform it is';
  });

  t.section('what each level is handed');

  await t.step('L1 and L2 see only their own records; L3 adds the partners mapped below; L7 sees all', async () => {
    const v = {};
    for(const who of ['P1', 'P2', 'P3', 'P7']) v[who] = {leads: ids(await get(session[who], 'leads')), clients: ids(await get(session[who], 'clients'))};
    const want = {P1: {leads: 'L-P1', clients: 'C-P1'}, P2: {leads: 'L-P2', clients: ''}, P3: {leads: 'L-P1,L-P3', clients: 'C-P1'},
      P7: {leads: 'L-E1,L-E2,L-P1,L-P2,L-P3', clients: 'C-E2,C-P1'}};
    if(JSON.stringify(v) !== JSON.stringify(want)) throw new Error(JSON.stringify(v));
    const tasks = ids(await get(session.P1, 'tasks'));
    if(tasks !== 'T-P1') throw new Error('P1 tasks: ' + tasks);
    return 'P1 ' + v.P1.leads + ' · P2 ' + v.P2.leads + ' · P3 ' + v.P3.leads + ' · L7 all five; the task on P1’s lead travels with it';
  });

  await t.step('company HR, employee details and configuration stay closed to partners', async () => {
    const att = ids(await get(session.P1, 'hrAttendance'));
    if(att !== 'A-P1') throw new Error('attendance: ' + att);
    const ac = await get(session.P1, 'apiConnectors');
    if(ac.status !== 404) throw new Error('connectors were readable: ' + JSON.stringify(ac));
    const team = await get(session.P1, 'team');
    const e1 = team.find(x => x.id === 'E1'), self = team.find(x => x.id === 'P1');
    if(!e1 || e1.email || !e1.directoryOnly || e1.perms) throw new Error('employee row: ' + JSON.stringify(e1));
    if(!self || self.email !== 'p1@zz.test') throw new Error('own row cut down');
    const cfg = await get(session.P1, 'config');
    if(cfg.status) throw new Error('config should be readable for the screens: ' + JSON.stringify(cfg));
    return 'own attendance only, connectors 404, colleagues reduced to a name, config readable';
  });

  await t.step('employees: their scope plus the partners they are the RM of — not L1–L7 rules', async () => {
    const e1 = ids(await get(session.E1, 'leads')), e2 = ids(await get(session.E2, 'leads'));
    if(e1 !== 'L-E1,L-P1,L-P2,L-P3') throw new Error('E1 (own scope, RM of POB 1–3): ' + e1);
    if(e2 !== 'L-E1,L-E2,L-P1,L-P2,L-P3') throw new Error('E2 (all): ' + e2);
    const team = await get(session.E1, 'team');
    if(!team.find(x => x.id === 'E2' && x.email)) throw new Error('an employee lost the company directory');
    return 'E1 own + assigned partners (' + e1 + '); E2 everything';
  });

  t.section('what each may write');

  await t.step('nothing outside their reach, no self-promotion, no company configuration', async () => {
    const r = {};
    r.otherLead = (await patch(session.P1, 'leads', {changes: [{id: 'L-P2', set: {firstName: 'hacked'}}]})).status;
    r.addOverOther = (await patch(session.P1, 'leads', {adds: [{id: 'L-E2', firstName: 'hacked'}]})).status;
    r.removeOther = (await patch(session.P1, 'leads', {removed: ['L-E2']})).status;
    r.giveAway = (await patch(session.P1, 'leads', {changes: [{id: 'L-P1', set: {assignedTo: 'E2', partnerPobId: 'POB-2'}}]})).status;
    r.promote = (await patch(session.P1, 'team', {changes: [{id: 'P1', set: {partnerLevel: 'L7'}}]})).status;
    r.config = (await put(session.P1, 'config', {value: JSON.stringify({hacked: true})})).status;
    r.bulk = (await put(session.P1, 'leads', {value: '[]'}, H.combined, {'X-CRM-Bulk': '1'})).status;
    const want = {otherLead: 403, addOverOther: 403, removeOther: 403, giveAway: 403, promote: 403, config: 403, bulk: 403};
    if(JSON.stringify(r) !== JSON.stringify(want)) throw new Error(JSON.stringify(r));
    const all = await get(admin, 'leads');
    if(all.find(x => x.firstName === 'hacked') || ids(all) !== 'L-E1,L-E2,L-P1,L-P2,L-P3') throw new Error('a refused write landed: ' + ids(all));
    return 'seven attempts, seven refusals, store untouched';
  });

  await t.step('a whole-list save from a partner cannot wipe what they were never shown', async () => {
    const mine = await get(session.P1, 'leads');
    mine.push({id: 'L-P1-NEW', firstName: 'ZZ New from partner', assignedTo: 'P1', partnerPobId: 'POB-1'});
    const r = await put(session.P1, 'leads', {value: JSON.stringify(mine)}, H.partner);
    if(r.status !== 200) throw new Error(r.status + ' ' + r.text);
    const all = ids(await get(admin, 'leads'));
    if(all !== 'L-E1,L-E2,L-P1,L-P1-NEW,L-P2,L-P3') throw new Error('store now: ' + all);
    return 'P1 saved its own two, the other four are still there';
  });

  t.section('one record, both platforms');

  await t.step('a partner adds, company Ops updates, the partner sees the update — and L3 above sees it too', async () => {
    const seenByOps = (await get(session.E2, 'leads', H.company)).find(x => x.id === 'L-P1-NEW');
    if(!seenByOps) throw new Error('company Ops does not see the partner’s new lead');
    const u = await patch(session.E2, 'leads', {changes: [{id: 'L-P1-NEW', set: {opsNote: 'ZZ KYC checked by Ops'}}]}, H.company);
    if(u.status !== 200) throw new Error('ops update ' + u.status + ' ' + u.text);
    const back = (await get(session.P1, 'leads', H.partner)).find(x => x.id === 'L-P1-NEW');
    if(!back || back.opsNote !== 'ZZ KYC checked by Ops') throw new Error('the partner did not get the update');
    const up = (await get(session.P3, 'leads', H.partner)).find(x => x.id === 'L-P1-NEW');
    if(!up) throw new Error('the L3 above did not see it');
    if(back.id !== seenByOps.id) throw new Error('two records');
    return 'one record, one id, the same on both platforms';
  });

  t.section('teams, levels, and the log');

  await t.step('L5 builds a team of RMs and Operations; L3 cannot; nobody hands out company powers', async () => {
    const staff = {id: 'S5', name: 'ZZ Staff of P5', email: 's5@zz.test', partnerTeamOf: 'P5', partnerStaffRole: 'RM', parentUserId: 'P5',
      role: 'Relationship Manager', scope: 'own', status: 'Active', adminFlags: {}, hrAccess: {}};
    const r = {};
    r.l3 = (await patch(session.P3, 'team', {adds: [Object.assign({}, staff, {id: 'S3', email: 's3@zz.test', partnerTeamOf: 'P3', parentUserId: 'P3'})]})).status;
    r.power = (await patch(session.P5, 'team', {adds: [Object.assign({}, staff, {id: 'S5X', email: 's5x@zz.test', adminFlags: {manageUsers: 1}})]})).status;
    r.allScope = (await patch(session.P5, 'team', {adds: [Object.assign({}, staff, {id: 'S5Y', email: 's5y@zz.test', scope: 'all'})]})).status;
    r.ok = (await patch(session.P5, 'team', {adds: [staff]})).status;
    r.account = (await req('POST', H.partner, '/api/users/sync', {cookie: session.P5, json: {memberId: 'S5', email: 's5@zz.test', admin: true}})).json;
    r.otherAccount = (await req('POST', H.partner, '/api/users/sync', {cookie: session.P5, json: {memberId: 'E1', email: 'e1@zz.test'}})).status;
    if(r.l3 !== 403 || r.power !== 403 || r.allScope !== 403 || r.ok !== 200) throw new Error(JSON.stringify(r));
    if(!r.account || !r.account.ok || r.account.account.role !== 'user') throw new Error('staff account: ' + JSON.stringify(r.account));
    if(r.otherAccount !== 403) throw new Error('P5 managed an employee’s account');
    // The staff member signs in on the partner platform and works inside P5's business.
    const s = await login(H.partner, 's5@zz.test', r.account.password);
    if(s.status !== 302) throw new Error('staff sign-in ' + s.status);
    const c = await req('POST', H.partner, '/api/account/password', {cookie: s.cookie, json: {current: r.account.password, password: STRONG + 'S5', confirm: STRONG + 'S5'}});
    const acc = (await req('GET', H.partner, '/api/me/access', {cookie: c.cookie})).json;
    if(!acc || acc.kind !== 'staff' || acc.partnerTeamOf !== 'P5') throw new Error('staff access: ' + JSON.stringify(acc));
    return 'L3 refused, admin flags and company scope refused, S5 added with an ordinary account and signs in as P5’s staff';
  });

  await t.step('changing a partner’s level changes what the server allows at once', async () => {
    const before = (await req('GET', H.partner, '/api/me/access', {cookie: session.P2})).json;
    let r = await patch(admin, 'team', {changes: [{id: 'P2', set: {partnerLevel: 'L5', scope: 'team'}}]});
    if(r.status !== 200) throw new Error('admin change ' + r.status);
    const after = (await req('GET', H.partner, '/api/me/access', {cookie: session.P2})).json;
    if(before.level !== 'L2' || after.level !== 'L5' || !after.caps.includes('buildTeam')) throw new Error(JSON.stringify({before, after}));
    r = await patch(admin, 'team', {changes: [{id: 'P2', set: {partnerLevel: 'L2', scope: 'own'}}]});
    return 'L2 → L5: team building opened on the next request, no new sign-in';
  });

  await t.step('every write and every refusal is in the server’s log', async () => {
    const log = (await req('GET', H.combined, '/api/audit/writes?key=leads', {cookie: admin})).json;
    const rows = (log && log.rows) || [];
    const added = rows.find(x => x.by === 'p1@zz.test' && (x.added || []).includes('L-P1-NEW'));
    const refused = rows.find(x => x.by === 'p1@zz.test' && x.refused);
    const ops = rows.find(x => x.by === 'e2@zz.test' && (x.changed || []).includes('L-P1-NEW') && x.platform === 'company');
    if(!added || !refused || !ops) throw new Error(JSON.stringify(rows.slice(0, 6)));
    const denied = await req('GET', H.combined, '/api/audit/writes', {cookie: session.P1});
    if(denied.status !== 403) throw new Error('a partner read the log');
    return 'P1’s add and refusals, and Ops’ change on the company platform, each logged with who and where';
  });

  t.section('the partner’s own screen');

  await t.step('the Partner Platform draws with the partner’s records only, and no company menus', async () => {
    const ctx = await t.page.context().browser().newContext({viewport: {width: 1400, height: 900}});
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', e => errs.push(e.message));
    /* Every refusal the page meets, by address. A partner who is not on the
       payout team yet is told so by /api/payout (403); that is expected. */
    pg.on('response', r => { if(r.status() === 403 && !/\/api\/payout\//.test(r.url())) errs.push('403 ' + r.request().method() + ' ' + r.url()); });
    pg.on('console', m => { if(m.type() === 'error' && !/Failed to load resource|favicon|Push API|push AbortError|permission denied/.test(m.text())) errs.push(m.text()); });
    const base = 'http://' + H.partner + ':' + PORT;
    await pg.goto(base + '/login', {waitUntil: 'domcontentloaded'});
    await pg.fill('#email', 'p5@zz.test');
    await pg.fill('#password', STRONG + 'P5');
    await Promise.all([pg.waitForNavigation({waitUntil: 'domcontentloaded'}), pg.click('button[type=submit]')]);
    await require('../lib/ready')(pg);
    await pg.waitForTimeout(800);
    const r = await pg.evaluate(() => ({
      platform: window.BOSS_PLATFORM, tag: (document.querySelector('.platform-tag') || {}).textContent || '',
      title: document.title, leads: DB.leads.map(l => l.id).sort().join(','),
      nav: Array.from(document.querySelectorAll('.nav .nav-item, .nav [onclick*="navigate("]')).map(e => e.getAttribute('onclick') || '').join(' '),
      settings: isSettingsVisible(), team: pageOpenToMe('myteam'), hr: pageOpenToMe('hrattendance'),
    }));
    await pg.evaluate(() => navigate('myteam'));
    await pg.waitForTimeout(300);
    const teamPage = await pg.evaluate(() => (document.getElementById('ptTable') || {}).textContent || '');
    await ctx.close();
    if(r.platform !== 'partner' || !/Partner Platform/.test(r.tag) || !/Partner/.test(r.title)) throw new Error('branding: ' + JSON.stringify(r));
    if(r.leads !== '') throw new Error('P5 holds leads it does not own (or seeded samples): ' + r.leads);
    if(r.settings || r.hr || !r.team) throw new Error('menus: ' + JSON.stringify({settings: r.settings, hr: r.hr, team: r.team}));
    if(!/ZZ Staff of P5/.test(teamPage)) throw new Error('My Team does not list S5: ' + teamPage.slice(0, 200));
    if(errs.length) throw new Error('page errors: ' + errs.slice(0, 3).join(' | '));
    return 'branded "' + r.tag + '", no Setup or HR, My Team lists S5, no page errors';
  });
});
