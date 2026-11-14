/* PASSWORDS: CHOSEN BY THE PERSON, NEVER READABLE BY ANYBODY.

   - An issued password (new account, temporary) is emailed once, kept only
     as a hash, and must be replaced at the first sign-in.
   - Anybody signed in can change their own password from their profile, to
     one that meets the rules, knowing the current one.
   - An admin sees each member's password status, never the password, and
     can send a reset link that works once within a day. */
const {suite} = require('../lib/harness');

suite({mail: true}, async t => {
  await t.home();
  let m;

  const fresh = async () => {
    const ctx = await t.page.context().browser().newContext();
    const p = await ctx.newPage();
    p.on('dialog', d=>d.accept().catch(()=>{}));
    return {ctx, p};
  };
  const signIn = async (p, email, password) => {
    await p.goto(t.url('/login'), {waitUntil: 'domcontentloaded'});
    await p.fill('#email', email);
    await p.fill('#password', password);
    await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
    return new URL(p.url()).pathname;
  };

  await t.step('a new member\'s password is emailed once and kept only as a hash', async () => {
    m = await t.eval(async ()=>{
      const role = (DB.config.roles||[]).map(r=>r.name||r).find(r=>r && r !== ADMIN_ROLE);
      const now = new Date().toISOString();
      const mem = {id: uid('USR'), name: 'ZZ Pass Member', email: 'zz.pass.member@finowise.test', role, status: 'Active',
        parentUserId: DB.team[0].id, branch: DB.team[0].branch, scope: 'own', perms: {}, adminFlags: {}, employeeId: nextEmployeeId(),
        joinedAt: now, createdAt: now, documents: [], notes: []};
      DB.team.push(mem); await save('team');
      const r = await syncMemberAccount(mem, {});
      await loadAccounts();
      const a = accountFor(mem);
      return {id: mem.id, email: mem.email, password: r.password, account: a, keys: Object.keys(a || {})};
    });
    if(!m.password) throw new Error('no password came back to email');
    if(m.keys.some(k=>/password$/i.test(k) && k !== 'mustChange')) throw new Error('the account record carries a password: ' + m.keys.join(','));
    if(!m.account.mustChange) throw new Error('the issued password is not marked to be replaced');
    if(JSON.stringify(m.account).indexOf(m.password) >= 0) throw new Error('the password is readable from the account list');
    return 'returned once for the email; the account says "must choose their own"';
  });

  await t.step('signing in with it leads straight to choosing their own; nothing else opens first', async () => {
    const {ctx, p} = await fresh();
    const landed = await signIn(p, m.email, m.password);
    const api = await p.evaluate(async ()=>{ const r = await fetch('/api/storage/clients'); return r.status; });
    const app = await p.goto(t.url('/'), {waitUntil: 'domcontentloaded'}).then(()=>new URL(p.url()).pathname);
    /* A weak one is refused with the reason. */
    await p.fill('#password', 'alllowercase'); await p.fill('#confirm', 'alllowercase');
    await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
    const weak = await p.evaluate(()=>(document.querySelector('.error') || {}).textContent || '');
    await p.fill('#password', 'Sunrise#2026'); await p.fill('#confirm', 'Sunrise#2026');
    await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
    const after = new URL(p.url()).pathname;
    await ctx.close();
    if(landed !== '/set-password') throw new Error('signing in landed on ' + landed);
    if(api !== 403) throw new Error('the data answered ' + api + ' before a password was chosen');
    if(app !== '/set-password') throw new Error('the app opened before a password was chosen');
    if(!/capital and small letters/.test(weak)) throw new Error('a weak password was not refused with its reason: ' + weak);
    if(after === '/set-password' || after === '/login') throw new Error('choosing a good password did not let them in: ' + after);
    return 'sent to choose; data refused (403) until then; weak refused; strong accepted';
  });

  await t.step('the admin sees the status, never the password', async () => {
    const r = await t.eval(async (id)=>{
      await loadAccounts();
      const t = DB.team.find(x=>x.id === id);
      return {html: memberAccountCardHtml(t), a: accountFor(t)};
    }, m.id);
    if(!/Set by them/.test(r.html)) throw new Error('the card does not say they set it: ' + r.html.replace(/<[^>]+>/g, ' ').slice(0, 400));
    if(/Sunrise#2026|Reveal it/.test(r.html) || r.html.indexOf(m.password) >= 0) throw new Error('a password, or a way to reveal one, is on the card');
    if(r.a.mustChange || !r.a.passwordSetAt) throw new Error('the account status did not follow: ' + JSON.stringify(r.a));
    return 'card: "Set by them" with the date; nothing to reveal';
  });

  await t.step('changing it from the profile needs the current one and a good new one', async () => {
    const {ctx, p} = await fresh();
    await signIn(p, m.email, 'Sunrise#2026');
    await p.waitForFunction(()=>typeof openChangePassword === 'function' && typeof DB !== 'undefined' && DB.config, null, {timeout: 20000});
    const r = await p.evaluate(async ()=>{
      const post = async (current, password, confirm)=>{
        const res = await fetch('/api/me/password', {method: 'POST', headers: Object.assign({'Content-Type': 'application/json'}, apiHeaders()),
          body: JSON.stringify({current, password, confirm})});
        return Object.assign({status: res.status}, await res.json());
      };
      return {
        wrongCurrent: await post('not-it', 'Moonrise#2027', 'Moonrise#2027'),
        mismatch: await post('Sunrise#2026', 'Moonrise#2027', 'Moonrise#2028'),
        noSymbol: await post('Sunrise#2026', 'Moonrise2027', 'Moonrise2027'),
        good: await post('Sunrise#2026', 'Moonrise#2027', 'Moonrise#2027'),
      };
    });
    await ctx.close();
    if(r.wrongCurrent.ok || !/current password/.test(r.wrongCurrent.message)) throw new Error('a wrong current password was accepted: ' + JSON.stringify(r.wrongCurrent));
    if(r.mismatch.ok || !/do not match/.test(r.mismatch.message)) throw new Error('mismatched passwords were accepted');
    if(r.noSymbol.ok || !/symbol/.test(r.noSymbol.message)) throw new Error('a password with no symbol was accepted');
    if(!r.good.ok) throw new Error('a good change was refused: ' + r.good.message);
    const {ctx: c2, p: p2} = await fresh();
    const oldOne = await signIn(p2, m.email, 'Sunrise#2026');
    const newOne = await signIn(p2, m.email, 'Moonrise#2027');
    await c2.close();
    if(oldOne !== '/login') throw new Error('the old password still signs in');
    if(newOne === '/login' || newOne === '/set-password') throw new Error('the new password does not sign in: ' + newOne);
    return 'wrong current, mismatch and weak refused; changed; old one no longer works, new one does';
  });

  await t.step('the profile has a Change password button that opens the form', async () => {
    const r = await t.eval(async ()=>{
      navigate('profile');
      await new Promise(z=>setTimeout(z, 300));
      const b = [...document.querySelectorAll('button')].find(x=>/^change password$/i.test(x.textContent.trim()));
      if(!b) return {err: 'no Change password button on the profile'};
      b.click();
      await new Promise(z=>setTimeout(z, 150));
      const fields = ['pw_current', 'pw_new', 'pw_confirm'].every(id=>document.getElementById(id) && document.getElementById(id).type === 'password');
      document.getElementById('pw_new').value = 'Abc'; passwordRulesPaint();
      const rules = document.getElementById('pw_rules').innerText;
      closeModal();
      return {fields, rules};
    });
    if(r.err) throw new Error(r.err);
    if(!r.fields) throw new Error('the form is missing a password field');
    if(!/At least 8 characters/.test(r.rules)) throw new Error('the rules are not shown: ' + r.rules);
    return 'button, three password fields, rules shown as they are met';
  });

  await t.step('an admin\'s reset link reaches the member, works once, and sets their own password', async () => {
    t.mail.clear();
    const r = await t.eval(async (id)=>{
      await sendMemberResetLink(id);
      await loadAccounts();
      return {html: memberAccountCardHtml(DB.team.find(x=>x.id === id))};
    }, m.id);
    let letter = null;
    for(let i = 0; i < 20 && !letter; i++){ letter = t.mail.matching(/Set a new password/i)[0]; if(!letter) await t.wait(250); }
    if(!letter) throw new Error('no reset letter arrived (' + t.mail.received.length + ' in the box)');
    const link = (letter.text.match(/https?:\/\/\S+reset-password\?token=\S+/) || [])[0];
    if(!link) throw new Error('the letter has no link: ' + letter.text);
    if(!/Reset link sent/.test(r.html)) throw new Error('the card does not say a reset is pending');
    const {ctx, p} = await fresh();
    await p.goto(link, {waitUntil: 'domcontentloaded'});
    await p.fill('#password', 'Starlight$2028'); await p.fill('#confirm', 'Starlight$2028');
    await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
    const done = new URL(p.url()).search;
    const again = await p.goto(link, {waitUntil: 'domcontentloaded'}).then(x=>x.status());
    const signed = await signIn(p, m.email, 'Starlight$2028');
    await ctx.close();
    if(!/done=reset/.test(done)) throw new Error('setting it did not return to sign-in: ' + done);
    if(again !== 410) throw new Error('the link worked a second time (' + again + ')');
    if(signed === '/login' || signed === '/set-password') throw new Error('the new password does not sign in');
    return 'letter with link; card shows the pending reset; set once; second use refused (410); signs in';
  });

  await t.step('no admin screen can read a password', async () => {
    const r = await t.eval(async ()=>{
      const res = await fetch('/api/users', {headers: apiHeaders()});
      const j = await res.json();
      return JSON.stringify(j);
    });
    if(/issuedPassword|Starlight|Moonrise|Sunrise/.test(r) || r.indexOf(m.password) >= 0) throw new Error('the account list carries a password');
    return 'the account list holds statuses only';
  });
});
