/* A CLIENT'S LINK OPENS FOR A CLIENT — WHO IS NOT SIGNED IN.

   The other form suites open the link in the adviser's own browser, which is
   signed in, so they never met the bug the firm did: the page's helper
   scripts (multi-asset.js, client-merge.js, the review report's) sat behind
   the sign-in, a client's browser got the sign-in page instead of the code,
   and the form died on "maLoadRows is not defined". Here every link is
   opened in a fresh browser with no session at all. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  let links;

  await t.step('three links an adviser sends: a lead\'s form, a client\'s CIF, a client\'s support desk', async () => {
    links = await t.eval(async ()=>{
      const now = new Date().toISOString();
      const l = {id: uid('LMS'), firstName: 'ZZ Public', lastName: 'Lead', mobile: '9800011111', email: 'zz.pub@zz.in',
        assignedTo: currentUser, branch: DB.config.branches[0], createdAt: now};
      initState('LMS', l); DB.leads.push(l); await save('leads');
      const c = {id: uid('CMS'), cmsName: 'ZZ Public Client', rmName: currentUser, createdAt: now, createdBy: currentUser};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      const lead = await createDocLink(l.id, 'SEVENEVENTS', {iseqType: 'ISEQ_UNDER50'});
      const cif = await createDocLink(null, 'CIF', {recordModule: 'CMS', recordId: c.id});
      const support = await clientSupportToken(c.id);
      return {lead, cif, support};
    });
    return Object.entries(links).filter(([, v])=>v).map(([k])=>k).join(', ');
  });

  const openSignedOut = async (query) => {
    const ctx = await t.page.context().browser().newContext();
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', e=>errors.push(e.message));
    p.on('console', m=>{ if(m.type() === 'error' && !/favicon|push|Registration failed/i.test(m.text())) errors.push(m.text()); });
    const scripts = [];
    p.on('response', r=>{ if(/\.js(\?|$)/.test(r.url())) scripts.push(r.status() + ' ' + r.url().replace(t.base, '')); });
    await p.goto(t.url('/?' + query), {waitUntil: 'domcontentloaded'});
    await p.waitForTimeout(2500);
    const r = await p.evaluate(()=>({
      url: location.pathname,
      text: (document.body.innerText || '').slice(0, 3000),
      inputs: document.querySelectorAll('#root input, #root textarea, #root select').length,
      crashed: !!document.querySelector('.screen-error, #screenError') || /Something went wrong on this screen/.test(document.body.innerText || ''),
    }));
    await ctx.close();
    return Object.assign(r, {errors, scripts});
  };

  for(const [name, label] of [['lead', 'the lead\'s form'], ['cif', 'the client\'s CIF'], ['support', 'the client\'s support desk']]){
    await t.step(label + ' opens signed out, with no error, and shows its fields', async () => {
      const tok = links[name];
      if(!tok) return 'no such link on this build — skipped';
      const r = await openSignedOut((name === 'support' ? 'support=' : 'doc=') + encodeURIComponent(tok));
      if(r.url === '/login') throw new Error('the link was sent to the sign-in page');
      const blocked = r.scripts.filter(s=>!/^200 /.test(s) && !/^304 /.test(s));
      if(blocked.length) throw new Error('scripts did not load: ' + blocked.join(', '));
      if(r.errors.length) throw new Error(r.errors.join(' | '));
      if(r.crashed) throw new Error('the page shows an error: ' + r.text.slice(0, 300));
      if(!r.inputs) throw new Error('no fields on the page: ' + r.text.slice(0, 300));
      return r.inputs + ' fields, ' + r.scripts.length + ' scripts loaded, no errors';
    });
  }

  await t.step('signed out, the data and the app itself still ask for a sign-in', async () => {
    const ctx = await t.page.context().browser().newContext();
    const p = await ctx.newPage();
    const st = async (path) => (await p.request.get(t.url(path), {maxRedirects: 0})).status();
    const r = {api: await st('/api/storage/clients'), app: await st('/'), server: await st('/server.js'), sheet: await st('/review/client-review.xlsx')};
    await ctx.close();
    if(r.api !== 401) throw new Error('the data API answered ' + r.api);
    if(r.app !== 302 || r.server !== 302 || r.sheet !== 302) throw new Error('something else opened without a sign-in: ' + JSON.stringify(r));
    return JSON.stringify(r);
  });
});
