/* A CLIENT OPENS THEIR FORM WITHOUT BEING SIGNED IN.

   A client is nobody in BOSS. Their link opened on a blank page with
   "maLoadRows is not defined — at loadAll": the page's own scripts sat
   behind the sign-in, so multi-asset.js (and every other script file) came
   back as the login page, never ran, and boot died calling a function it
   had never been given. Every earlier test opened the link from a browser
   that was already signed in, which is why nothing caught it.

   Here the link is opened from a browser with no cookie at all: every
   script loads as a script, the form draws, it can be filled and submitted,
   and the CRM itself and its data still ask for the sign-in. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  let token = '';
  await t.step('a C&T form link for a client', async () => {
    token = await t.eval(async ()=>{
      const c = {id:'CMS-ZZOUT1', cmsName:'ZZ Signed Out', mobile:'9800000081', email:'zzout@zz.in',
        rmName: currentUser, branch:'Varanasi', createdAt:new Date().toISOString()};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      const type = activeFormsInCategory('C&T')[0] || 'CT';
      return await createDocLink(c.id, type, {recordModule:'CMS', recordId:c.id});
    });
    if(!token) throw new Error('no link');
    return 'link made';
  });

  let ctx, p;
  const errors = [], scripts = [];
  await t.step('opened with no sign-in, every script loads and the form draws', async () => {
    ctx = await t.page.context().browser().newContext();
    p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    p.on('response', r => { if(r.request().resourceType() === 'script') scripts.push({url: r.url().replace(t.base, ''), status: r.status(), type: r.headers()['content-type'] || ''}); });
    await p.goto(t.base + '/?doc=' + token, {waitUntil: 'domcontentloaded'});
    await p.waitForSelector('#f_ct_references_r0_name', {timeout: 20000}).catch(() => {});
    const r = await p.evaluate(() => ({form: !!document.getElementById('f_ct_references_r0_name'), maLoadRows: typeof maLoadRows,
      text: document.body.innerText.slice(0, 200), crashed: /Something went wrong/.test(document.body.innerText)}));
    const bad = scripts.filter(s => s.status !== 200 || !/javascript/.test(s.type));
    if(bad.length) throw new Error('scripts not served as scripts: ' + JSON.stringify(bad));
    if(errors.length) throw new Error('page errors: ' + errors.join(' | '));
    if(r.crashed || !r.form) throw new Error('the form did not draw: ' + r.text);
    if(r.maLoadRows !== 'function') throw new Error('maLoadRows is ' + r.maLoadRows);
    return scripts.length + ' scripts served as JavaScript; the form is on the page';
  });

  await t.step('the client fills it in and submits it', async () => {
    const said = [];
    p.on('dialog', d => { said.push(d.message()); d.accept(); });
    await p.evaluate(()=>{
      const set = (id, v)=>{ const el = document.getElementById(id); if(el){ el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); } };
      set('f_ct_date', new Date().toISOString().slice(0,10));
      const ta = document.getElementById('f_ct_testimonial'); if(ta) ta.value = 'ZZ signed-out service';
      const yes = document.querySelector('input[name="f_ct_consent"][value="Yes"]') || document.querySelector('[id^="f_ct_consent"][value="Yes"]');
      if(yes) yes.checked = true;
      set('f_ct_references_r0_name', 'ZZ Outside Person'); set('f_ct_references_r0_mobile', '8887982971'); set('f_ct_references_r0_email', 'outside@zz.in');
    });
    await (await p.$('button:has-text("Submit")')).click();
    await p.waitForTimeout(3000);
    const bad = said.find(d => /could not|failed|error/i.test(d));
    if(bad) throw new Error('refused: ' + bad);
    if(errors.length) throw new Error('page errors: ' + errors.join(' | '));
    const got = await t.eval(async () => {
      const r = await fetch('/api/storage/leads', {headers: apiHeaders()});
      return JSON.parse((await r.json()).value).filter(l => /ZZ Outside/.test((l.firstName||'') + ' ' + (l.lastName||''))).length;
    });
    if(!got) throw new Error('the submission did not arrive');
    return 'submitted; the person named arrived in BOSS';
  });

  await t.step('the CRM page and its data still ask for the sign-in', async () => {
    const page = await p.goto(t.base + '/', {waitUntil: 'domcontentloaded'});
    const atLogin = /\/login/.test(p.url());
    const api = await p.evaluate(async () => (await fetch('/api/storage/clients')).status);
    await ctx.close();
    if(!atLogin) throw new Error('the CRM opened without a sign-in: ' + p.url() + ' ' + (page && page.status()));
    if(api !== 401) throw new Error('the data answered ' + api + ' without a sign-in');
    return 'the CRM redirects to /login and the store answers 401';
  });
});
