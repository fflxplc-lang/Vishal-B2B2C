/* A SIGN-IN ACCOUNT LEFT LINKED TO A TEAM MEMBER WHO IS GONE.

   A person deleted and added again (or imported a second time) gets a new
   team-member record, while their sign-in account stays linked to the old
   one. The profile found the account by email and showed "Can sign in",
   but Issue a new password looked it up by member id and answered "That
   team member has no sign-in account yet" — and creating one refused,
   because the address was taken. Now the account follows the person: it is
   relinked to the member who has that email and the password issued. One
   still linked to somebody on the team is theirs, and is left alone. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  const make = (name, email) => t.eval(async ({name, email}) => {
    const role = (DB.config.roles||[]).map(r=>r.name||r).find(r=>r && r !== ADMIN_ROLE);
    const now = new Date().toISOString();
    const m = {id: uid('USR'), name, email, role, status: 'Active', parentUserId: DB.team[0].id, branch: DB.team[0].branch,
      scope: 'own', perms: {}, adminFlags: {}, employeeId: nextEmployeeId(), joinedAt: now, createdAt: now, documents: [], notes: []};
    DB.team.push(m); await save('team');
    return m.id;
  }, {name, email});

  let oldId, newId;
  await t.step('an account made for a member who is then deleted and added again', async () => {
    oldId = await make('Guru Old', 'Guru.Relink@example.com');
    const r = await t.eval(async id => {
      const m = DB.team.find(x => x.id === id);
      const made = await syncMemberAccount(m);
      m.deletedAt = new Date().toISOString(); await save('team');
      return made.ok && made.created;
    }, oldId);
    if(!r) throw new Error('the first account was not made');
    newId = await make('Guru New', 'guru.relink@example.com');
    const card = await t.eval(async id => { await loadAccounts(); return memberAccountCardHtml(DB.team.find(x => x.id === id)); }, newId);
    if(!/Can sign in/.test(card)) throw new Error('the profile does not find the account by email');
    if(!/linked to a team member who is gone/.test(card) || !/Bring the account into step/.test(card)) throw new Error('the card does not say it is linked elsewhere');
    return 'the new record\'s profile shows the account, says it is linked to a member who is gone, and offers to bring it into step';
  });

  await t.step('Issue a new password relinks it to the member and issues the password', async () => {
    const r = await t.eval(async id => {
      const out = await regenerateMemberPassword(id);
      await loadAccounts();
      const a = accountFor(DB.team.find(x => x.id === id));
      return {ok: out.ok, message: out.message || '', password: !!out.password, linked: a && a.memberId};
    }, newId);
    if(!r.ok || !r.password) throw new Error('refused: ' + r.message);
    if(r.linked !== newId) throw new Error('still linked to ' + r.linked);
    return 'new password issued, and the account is now linked to the member on the team';
  });

  await t.step('Create / bring into step does the same for a member whose account was never relinked', async () => {
    const r = await t.eval(async () => {
      const role = (DB.config.roles||[]).map(r=>r.name||r).find(r=>r && r !== ADMIN_ROLE);
      const now = new Date().toISOString();
      const a = {id: uid('USR'), name: 'Asha First', email: 'asha.relink@example.com', role, status: 'Active', scope: 'own', perms: {}, adminFlags: {}, createdAt: now};
      DB.team.push(a); await save('team');
      await syncMemberAccount(a);
      a.deletedAt = now; await save('team');
      const b = Object.assign({}, a, {id: uid('USR'), name: 'Asha Again', deletedAt: undefined});
      delete b.deletedAt;
      DB.team.push(b); await save('team');
      const out = await syncMemberAccount(b);
      return {ok: out.ok, message: out.message || '', created: out.created, linked: out.account && out.account.memberId === b.id};
    });
    if(!r.ok || r.created || !r.linked) throw new Error(JSON.stringify(r));
    return 'the existing account adopted by the new record, not a second one made';
  });

  await t.step('an account still linked to somebody on the team is not taken from them', async () => {
    const otherId = await make('Same Mail', 'guru.relink@example.com');
    t.expectConsole(/status of 409/);
    const r = await t.eval(async id => {
      const out = await regenerateMemberPassword(id);
      const sync = await syncMemberAccount(DB.team.find(x => x.id === id));
      return {ok: out.ok, message: out.message || '', sync: sync.message || ''};
    }, otherId);
    if(r.ok || !/Guru New/.test(r.message) || !/different official email/.test(r.message)) throw new Error(JSON.stringify(r));
    if(!/Guru New/.test(r.sync)) throw new Error('sync message: ' + r.sync);
    return r.message;
  });

  await t.step('nothing was alerted', async () => {
    if(t.dialogs.length) throw new Error('alerts: ' + t.dialogs.join(' | ').slice(0, 200));
    return 'none';
  });
});
