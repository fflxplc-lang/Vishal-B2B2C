/* A COLLEAGUE WHO SIGNS IN NEVER SEES THE ADMIN'S SCREEN, NOT EVEN FOR A MOMENT.

   Boot used to run as whoever was first in the team list — the Admin — and
   only found out who had actually signed in at the very end. Any redraw in
   between (a save during the migrations schedules one) drew the Admin's
   name, rail and modules in front of an RM for a second or two on a slow
   server. And an account that matched no team member stayed the Admin for
   the whole session.

   So: every name the top bar ever shows, from the first frame, is recorded
   while the member signs in with the API slowed down to widen the window;
   and an account with no team member gets a page saying so, not the Admin. */
const {suite} = require('../lib/harness');

/* Every distinct name the top bar shows, frame by frame, from the very first
   paint. Installed before the page's own scripts run. */
const WATCH = () => {
  window._shown = []; let last = '';
  const tick = () => {
    const u = document.querySelector('.topnav-user-name span');
    const s = u ? u.textContent.trim() : '';
    if(s && s !== last){ window._shown.push(s); last = s; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

async function makeMember(t, name){
  return t.eval(async (name)=>{
    const role = (DB.config.roles||[]).map(r=>r.name||r).find(r=>r && r !== ADMIN_ROLE);
    const now = new Date().toISOString();
    const m = {id: uid('USR'), name, email: name.toLowerCase().replace(/\W+/g, '.') + '@finowise.test', role,
      status: 'Active', designation: 'RM', department: 'Sales', team: 'Sales', parentUserId: DB.team[0].id,
      branch: DB.team[0].branch, scope: 'own', perms: {}, adminFlags: {}, employeeId: nextEmployeeId(),
      joinedAt: now, createdAt: now, documents: [], notes: []};
    DB.team.push(m); await save('team');
    const r = await syncMemberAccount(m, {});
    return {id: m.id, email: m.email, role, password: r.password, ok: r.ok, admin: me().name};
  }, name);
}

/* Sign in as somebody in a context of their own, with every API call held
   back a little — the slow server the flash was seen on. */
async function signInAs(t, who){
  const ctx = await t.page.context().browser().newContext();
  await ctx.route('**/api/**', async r => { await new Promise(z=>setTimeout(z, 120)); r.continue(); });
  await ctx.addInitScript(WATCH);
  const p = await ctx.newPage();
  await p.goto(t.url('/login'), {waitUntil: 'domcontentloaded'});
  await p.fill('#email', who.email);
  await p.fill('#password', who.password);
  await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
  /* A new account signs in on a temporary password and is asked to choose
     its own before BOSS opens; that is done here, then the app loads. */
  /* The server may ask first, on its own page (password-management covers it). */
  if(new URL(p.url()).pathname === '/set-password'){
    await p.fill('#password', 'Chosen#Pass1'); await p.fill('#confirm', 'Chosen#Pass1');
    await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('button[type=submit]')]);
  }
  const first = await p.waitForSelector('#pw_new, .topnav-user-name, .public-card', {timeout: 60000}).catch(() => null);
  if(first && await p.$('#pw_new')){
    await p.fill('#pw_current', who.password);
    await p.fill('#pw_new', 'Zz!Strong-' + Date.now());
    await p.fill('#pw_confirm', await p.inputValue('#pw_new'));
    await Promise.all([p.waitForNavigation({waitUntil: 'domcontentloaded'}), p.click('#pw_go')]);
  }
  return {ctx, p};
}

suite(async t => {
  await t.home();
  let member, adminLabel;

  await t.step('an RM with a sign-in of their own', async () => {
    member = await makeMember(t, 'Ravi Member');
    if(!member.ok || !member.password) throw new Error('the account was not created: ' + JSON.stringify(member));
    adminLabel = member.admin;
    return member.email + ' as ' + member.role + '; the Admin is ' + adminLabel;
  });

  await t.step('signing in, the top bar only ever shows the RM — never the Admin', async () => {
    const {ctx, p} = await signInAs(t, member);
    await p.waitForFunction(() => window._shown.length && /Ravi Member/.test(window._shown[window._shown.length-1]),
      null, {timeout: 60000, polling: 100});
    await p.waitForTimeout(1500);       // the writes after the first draw land too
    const shown = await p.evaluate(() => window._shown);
    await ctx.close();
    const wrong = shown.filter(s => !/Ravi Member/.test(s));
    if(wrong.length) throw new Error('the screen showed ' + JSON.stringify(wrong) + ' before the RM: ' + JSON.stringify(shown));
    return 'shown: ' + shown.join(' → ');
  });

  await t.step('an account with no team member is told so, and is not let in as the Admin', async () => {
    const lost = await makeMember(t, 'Gone Member');
    await t.eval(async (id)=>{ DB.team = DB.team.filter(m=>m.id !== id); await save('team'); }, lost.id);
    const {ctx, p} = await signInAs(t, lost);
    await p.waitForFunction(() => /not linked to a team member/.test(document.body.innerText),
      null, {timeout: 60000, polling: 100}).catch(()=>{});
    await p.waitForTimeout(800);
    const r = await p.evaluate(() => ({text: document.body.innerText, shown: window._shown,
      signOut: !!document.querySelector('button[onclick="signOut()"]')}));
    await ctx.close();
    if(r.shown.length) throw new Error('the app was drawn as ' + JSON.stringify(r.shown));
    if(!/not linked to a team member/.test(r.text)) throw new Error('no explanation on the page: ' + r.text.slice(0, 200));
    if(!r.signOut) throw new Error('no way to sign out');
    return 'told it is not linked, with a Sign out button';
  });

  await t.step('added again under a new record, with the email typed differently, they still sign in as themselves', async () => {
    /* The account stays linked to the old record, which is deleted; the
       new record's email differs in case and carries a pasted
       non-breaking space. Sign-in finds them by email all the same, and
       the account is relinked to the new record. */
    const old = await makeMember(t, 'Guru Again');
    const fresh = await t.eval(async (old)=>{
      const was = DB.team.find(m=>m.id === old.id);
      was.deletedAt = new Date().toISOString();
      const m = Object.assign({}, was, {id: uid('USR'), name: 'Guru Again Two', email: ' ' + old.email.replace(/^g/, 'G') + ' '});
      delete m.deletedAt;
      DB.team.push(m); await save('team');
      return m.id;
    }, old);
    const {ctx, p} = await signInAs(t, old);
    await p.waitForFunction(() => window._shown.length || /not linked/.test(document.body.innerText), null, {timeout: 60000, polling: 100});
    await p.waitForTimeout(800);
    const r = await p.evaluate(() => ({shown: window._shown, text: document.body.innerText.slice(0, 160), member: window.CRM_MEMBER_ID}));
    await ctx.close();
    if(/not linked/.test(r.text)) throw new Error('turned away: ' + r.text);
    if(!r.shown.length || !/Guru Again Two/.test(r.shown[r.shown.length-1])) throw new Error('opened as ' + JSON.stringify(r.shown));
    if(r.member !== fresh) throw new Error('the account was not relinked: ' + r.member + ' vs ' + fresh);
    return 'signed in as Guru Again Two, and the account now points at the new record';
  });

  await t.step('the admin account with no team member of its own still opens as the Admin', async () => {
    await t.home();
    const label = await t.eval(() => document.querySelector('.topnav-user-name span').textContent.trim());
    if(label !== adminLabel) throw new Error('the admin opened as ' + label);
    return label;
  });
});
