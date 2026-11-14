/* A PERSON'S OWN PASSWORD, AND WHAT AN ADMINISTRATOR SEES OF IT.

   Users set and change their own password after signing in, with the
   rules shown and enforced and the new one typed twice. A new account, and
   an account an administrator resets, gets a temporary password that is
   emailed and lets them in once: BOSS asks them to choose their own before
   it opens. The administrator sees where each password stands — temporary,
   or set by the person — and can reset one, but never sees a password: no
   plain copy is kept, only a hash. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  let who;
  await t.step('an administrator makes an account: a temporary password, never kept readable', async () => {
    who = await t.eval(async ()=>{
      const role = (DB.config.roles||[]).map(r=>r.name||r).find(r=>r && r !== ADMIN_ROLE);
      const now = new Date().toISOString();
      const m = {id: uid('USR'), name: 'Pia Password', email: 'pia.password@finowise.test', role, status: 'Active',
        parentUserId: DB.team[0].id, branch: DB.team[0].branch, scope: 'own', perms: {}, adminFlags: {}, createdAt: now};
      DB.team.push(m); await save('team');
      const r = await syncMemberAccount(m, {});
      const list = await accountsApi('', {method: 'GET'});
      const a = (list.users || []).find(u => u.memberId === m.id) || {};
      return {id: m.id, email: m.email, temp: r.password, account: a, leaks: JSON.stringify(list).includes(r.password)};
    });
    if(!who.temp) throw new Error('no temporary password was made');
    if(who.leaks) throw new Error('the account list hands out the password');
    if(!who.account.mustChange || who.account.passwordSetBy !== 'system') throw new Error(JSON.stringify(who.account));
    return 'temporary, set by the system; the account list carries no password';
  });

  const signIn = async (email, password) => {
    const ctx = await t.page.context().browser().newContext();
    const p = await ctx.newPage();
    await p.goto(t.url('/login'), {waitUntil: 'domcontentloaded'});
    await p.fill('#email', email); await p.fill('#password', password);
    await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
    /* An issued password goes to the server's own "choose your password" page. */
    if(new URL(p.url()).pathname === '/set-password') return {ctx, p, state: 'must-change'};
    const where = await p.waitForSelector('#pw_new, .topnav-user-name, .login-error, .error', {timeout: 60000}).catch(() => null);
    const state = !where ? 'nothing' : await p.$('#pw_new') ? 'must-change' : await p.$('.topnav-user-name') ? 'app' : 'refused';
    return {ctx, p, state};
  };
  const typeNew = async (p, current, next, confirm) => {
    await p.fill('#pw_current', current); await p.fill('#pw_new', next); await p.fill('#pw_confirm', confirm === undefined ? next : confirm);
  };

  let mine = 'Pia!Chosen-2026';
  await t.step('signing in on it opens only "choose your own password"; weak and mismatched ones are refused', async () => {
    const {ctx, p, state} = await signIn(who.email, who.temp);
    if(state !== 'must-change') { await ctx.close(); throw new Error('signed in to: ' + state); }
    const app = await p.$('.topnav-user-name');
    const submit = async (pw, confirm) => {
      await p.fill('#password', pw); await p.fill('#confirm', confirm === undefined ? pw : confirm);
      await p.evaluate(() => { document.querySelectorAll('input[minlength]').forEach(i => i.removeAttribute('minlength')); });
      await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
      return (await p.$('.error')) ? await p.textContent('.error') : '';
    };
    const weak = await submit('short1A');
    const mismatch = await submit(mine, mine + 'x');
    const server = await p.evaluate(async () => (await (await fetch('/api/account/password', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify({current: 'x', password: 'abc', confirm: 'abc'})})).json()).message);
    await submit(mine);
    await p.waitForSelector('.topnav-user-name', {timeout: 60000});
    await ctx.close();
    if(app) throw new Error('the app was drawn behind the form');
    if(!/at least 8 characters/.test(weak)) throw new Error('a weak password: ' + weak);
    if(!/do not match/.test(mismatch)) throw new Error('mismatched confirmation: ' + mismatch);
    if(!/current password is not right/.test(server)) throw new Error('the server took a wrong current password: ' + server);
    return 'weak refused, mismatch refused, the server checks too; a good one opens BOSS';
  });

  await t.step('the administrator now sees "set by them" — and still no password', async () => {
    const r = await t.eval(async id => { await loadAccounts(); const a = accountFor(DB.team.find(x => x.id === id));
      navigate('settings', 'usermanagement'); settingsTab = 'usermanagement'; render();
      return {a, row: (document.getElementById('content').textContent.match(/Pia Password[\s\S]{0,400}/) || [''])[0]}; }, who.id);
    if(r.a.mustChange || r.a.passwordSetBy !== 'user' || !r.a.passwordSetAt) throw new Error(JSON.stringify(r.a));
    return 'set by the user on ' + r.a.passwordSetAt;
  });

  await t.step('from My Profile they change it: the current one is asked for, and only the new one works after', async () => {
    const {ctx, p, state} = await signIn(who.email, mine);
    if(state !== 'app') { await ctx.close(); throw new Error('signed in to: ' + state); }
    await p.evaluate(() => navigate('profile'));
    await p.click('#pwChangeBtn');
    await typeNew(p, 'Wrong!Pass1', 'Pia!Newer-2027'); await p.click('#pw_go');
    await p.waitForFunction(() => /not right/.test((document.getElementById('pw_error')||{}).textContent || ''), null, {timeout: 10000})
      .catch(async e => { const d = await p.evaluate(() => ({err: (document.getElementById('pw_error')||{}).textContent, modal: !!document.getElementById('pw_new'),
        title: (document.querySelector('.modal h3, .modal-title')||{}).textContent})); throw new Error('wrong-current: ' + JSON.stringify(d)); });
    await typeNew(p, mine, 'Pia!Newer-2027');
    p.on('dialog', d => d.accept());
    await p.click('#pw_go');
    await p.waitForFunction(() => !document.getElementById('overlay').classList.contains('show'), null, {timeout: 10000})
      .catch(async e => { const d = await p.evaluate(() => ({err: (document.getElementById('pw_error')||{}).textContent, btn: (document.getElementById('pw_go')||{}).textContent})); throw new Error('change: ' + JSON.stringify(d)); });
    await ctx.close();
    const old = await signIn(who.email, mine); await old.ctx.close();
    const fresh = await signIn(who.email, 'Pia!Newer-2027'); await fresh.ctx.close();
    if(old.state === 'app') throw new Error('the old password still signs in');
    if(fresh.state !== 'app') throw new Error('the new password does not sign in: ' + fresh.state);
    mine = 'Pia!Newer-2027';
    return 'wrong current refused; changed; the old password no longer signs in, the new one does';
  });

  await t.step('an administrator resets it: the old one stops, a temporary one is mailed and must be replaced', async () => {
    const r = await t.eval(async id => { const out = await regenerateMemberPassword(id); await loadAccounts();
      return {temp: out.password, a: accountFor(DB.team.find(x => x.id === id))}; }, who.id);
    if(!r.a.mustChange || r.a.passwordSetBy !== 'admin-reset') throw new Error(JSON.stringify(r.a));
    const old = await signIn(who.email, mine); await old.ctx.close();
    const temp = await signIn(who.email, r.temp); await temp.ctx.close();
    if(old.state === 'app') throw new Error('the password from before the reset still signs in');
    if(temp.state !== 'must-change') throw new Error('the temporary password opened: ' + temp.state);
    return 'reset by an administrator; the old password refused; the temporary one asks for a new password first';
  });
});
