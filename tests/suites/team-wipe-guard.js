/* THE TEAM IS NOT REPLACED BY A PAGE THAT FAILED TO LOAD IT.

   A read that failed — the server restarting under a deploy — used to come
   back as an empty list. Boot then seeded a lone Admin as the whole team and
   saved it, and a tab re-reading after a restart held an empty team that its
   next save wrote back. Either way every team member was gone.

   Now a failed read is retried, then reported: boot stops with a page that
   says so and changes nothing; a loaded page keeps what it holds; and the
   server refuses a team write that drops most of the people still on it,
   unless it is a reset, a restore or Delete Imported Data saying so. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  const teamOnServer = () => t.eval(async () => {
    const r = await fetch('/api/storage/team', {headers: apiHeaders()});
    return JSON.parse((await r.json()).value).map(m => m.id);
  });

  let ids;
  await t.step('a team of five', async () => {
    ids = await t.eval(async () => {
      const now = new Date().toISOString();
      for(const n of ['Ana', 'Ben', 'Cal', 'Dee']){
        DB.team.push({id: 'TM-GUARD-' + n, name: n + ' Guard', email: n.toLowerCase() + '.guard@example.com', role: defaultRole(),
          status: 'Active', scope: 'own', perms: {}, adminFlags: {}, createdAt: now});
      }
      await save('team');
      return DB.team.map(m => m.id);
    });
    if(ids.length < 5) throw new Error(ids.length + ' members');
    return ids.length + ' members on the server';
  });

  await t.step('the server refuses a write that would leave one of them', async () => {
    t.expectConsole(/status of 409/);
    const r = await t.eval(async () => {
      const res = await fetch('/api/storage/team', {method: 'PUT', headers: Object.assign({'Content-Type': 'application/json'}, apiHeaders()),
        body: JSON.stringify({value: JSON.stringify([DB.team[0]])})});
      return {status: res.status, error: (await res.json()).error || ''};
    });
    /* Either guard holds: the team guard refuses it (409), or the record
       merge keeps everybody the write did not say it removed (200). */
    if(!(r.status === 409 && /would remove/.test(r.error)) && r.status !== 200) throw new Error(JSON.stringify(r));
    const now = await teamOnServer();
    if(now.length !== ids.length) throw new Error('the team on the server is now ' + now.length);
    return r.error || 'kept: nobody the write did not name as removed was dropped';
  });

  await t.step('removing one person, or marking several deleted, still saves', async () => {
    const r = await t.eval(async () => {
      DB.team = DB.team.filter(m => m.id !== 'TM-GUARD-Dee');
      const one = await sset('team', DB.team);
      DB.team.filter(m => /^TM-GUARD-(Ana|Ben|Cal)$/.test(m.id)).forEach(m => { m.deletedAt = new Date().toISOString(); });
      const marked = await sset('team', DB.team);
      return {one, marked};
    });
    const now = await teamOnServer();
    if(r.one === false || r.marked === false || now.includes('TM-GUARD-Dee') || now.length !== ids.length - 1) throw new Error(JSON.stringify({r, now}));
    return 'Dee removed; Ana, Ben and Cal marked deleted — both saved';
  });

  await t.step('a reset or restore, which says so, may replace the team', async () => {
    const r = await t.eval(async () => {
      const keep = DB.team.slice();
      DB.team.forEach(m => { delete m.deletedAt; });
      await sset('team', DB.team);                        // the three back
      ssetBulkWrite = true;
      try { await sset('team', [keep[0]]); } finally { ssetBulkWrite = false; }
      const after = JSON.parse((await (await fetch('/api/storage/team', {headers: apiHeaders()})).json()).value).length;
      DB.team = keep; ssetBulkWrite = true;
      try { await sset('team', DB.team); } finally { ssetBulkWrite = false; }
      return after;
    });
    if(r !== 1) throw new Error('the bulk write left ' + r);
    return 'with X-CRM-Bulk the write goes through';
  });

  await t.step('a page whose team does not load says so and writes nothing', async () => {
    const before = await teamOnServer();
    const ctx = await t.page.context().browser().newContext({storageState: await t.page.context().storageState()});
    const p = await ctx.newPage();
    await p.route('**/api/storage/team', r => r.request().method() === 'GET' ? r.fulfill({status: 503, body: 'restarting'}) : r.continue());
    p.on('console', () => {});
    await p.goto(t.url('/'), {waitUntil: 'domcontentloaded'});
    await p.waitForFunction(() => /could not load everything/.test(document.body.innerText) || document.querySelector('.topnav-user-name'),
      null, {timeout: 60000, polling: 200});
    const text = await p.evaluate(() => document.body.innerText);
    await ctx.close();
    if(!/could not load everything/.test(text) || !/team/.test(text)) throw new Error('the page went on: ' + text.slice(0, 200));
    const after = await teamOnServer();
    if(after.join() !== before.join()) throw new Error('the team changed: ' + before.length + ' → ' + after.length);
    return 'told the team did not load, with Try again; the team on the server untouched';
  });

  await t.step('a loaded page whose re-read fails keeps the team it has', async () => {
    const ctx = await t.page.context().browser().newContext({storageState: await t.page.context().storageState()});
    const p = await ctx.newPage();
    await p.goto(t.url('/'), {waitUntil: 'domcontentloaded'});
    await p.waitForFunction(() => document.querySelector('.topnav-user-name') && sgetTrustMemory === true, null, {timeout: 60000});
    await p.route('**/api/storage/team', r => r.request().method() === 'GET' ? r.fulfill({status: 502, body: 'bad gateway'}) : r.continue());
    p.on('console', () => {});
    const r = await p.evaluate(async () => {
      const had = DB.team.length;
      DB.team = await sget('team', []);
      return {had, now: DB.team.length, failed: sgetFailures.includes('team')};
    });
    await ctx.close();
    if(r.now !== r.had || !r.failed) throw new Error(JSON.stringify(r));
    return 'the failed re-read kept all ' + r.had + ' members in memory';
  });

  await t.step('nothing was alerted', async () => {
    if(t.dialogs.length) throw new Error('alerts: ' + t.dialogs.join(' | ').slice(0, 200));
    return 'none';
  });
});
