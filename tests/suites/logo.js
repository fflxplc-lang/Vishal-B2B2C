/* THE FIRM'S MARK, AND THE COPY OF IT SITTING IN THE DATABASE.

   The logo is a default on DB.config.company, which is the trap: an
   install that has ever saved its company settings holds a COPY of
   the data URL in data.json. Redrawing the constant changes a fresh
   install and leaves every existing one showing the old mark, which
   is exactly the bug a logo change invites.

   So two things are checked here. The mark the code carries is the
   new one — not the previous drawing, which is identified by its
   length and both of its ends. And a database still holding that
   previous drawing is brought to the new one when the app boots,
   while a firm that uploaded a logo of its own in Setup keeps it. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  t.expectConsole(/storage (get|set) failed/);

  t.section('the mark the code carries');

  await t.step('is a PNG, and is not the drawing it replaced', async () => {
    const r = await t.eval(()=>({
      prefix: FREEDOM_LIFEX_LOGO.slice(0, 21),
      len: FREEDOM_LIFEX_LOGO.length,
      was: FREEDOM_LIFEX_LOGO_WAS,
      sameAsOld: FREEDOM_LIFEX_LOGO.length === FREEDOM_LIFEX_LOGO_WAS.len
        && FREEDOM_LIFEX_LOGO.slice(0, FREEDOM_LIFEX_LOGO_WAS.head.length) === FREEDOM_LIFEX_LOGO_WAS.head,
      onDefault: (DB.config.company || {}).logoDataUrl === FREEDOM_LIFEX_LOGO,
    }));
    if(r.prefix !== 'data:image/png;base64') throw new Error('the logo reads ' + r.prefix);
    if(r.sameAsOld) throw new Error('the constant is still the drawing it was supposed to replace');
    if(!r.len) throw new Error('there is no logo at all');
    return 'a ' + Math.round(r.len / 1024) + 'KB PNG, and the company default points at it';
  });

  await t.step('and it is what the pages draw', async () => {
    const r = await t.eval(()=>{
      navigate('settings');
      const shown = Array.from(document.querySelectorAll('img'))
        .map(i=>i.getAttribute('src') || '').filter(s=>s.indexOf('data:image/png') === 0);
      return {shown: shown.length, allNew: shown.every(s=>s === FREEDOM_LIFEX_LOGO)};
    });
    if(!r.allNew) throw new Error('a page is drawing a different logo from the one in the code');
    return r.shown + ' logo image(s) on Setup, all the new mark';
  });

  t.section('every other place the mark appears');

  await t.step('the sign-in door carries it, before any settings are saved', async () => {
    /* The door is rendered by the server, not the app: it reads the
       logo out of the data file, and on a fresh install there is none
       to read. What it drew then was a gold monogram belonging to
       nobody. */
    const html = await (await fetch(t.base + '/login')).text();
    if(/logo-svg/.test(html))
      throw new Error('the door is still drawing the old monogram');
    if(!/class="logo-img"/.test(html) || !/data:image\/png;base64,iVBOR/.test(html))
      throw new Error('the door shows no mark at all');
    return 'the mark, inline, on a page nobody has signed in to yet';
  });

  await t.step('and the tab icon is the wings from the first paint', async () => {
    const r = await t.eval(()=>{
      const link = document.getElementById('favicon');
      return {type: link.getAttribute('type'), href: (link.getAttribute('href') || '').slice(0, 30),
              /* once BOSS has booted it follows the firm's own logo */
              afterBoot: (setFavicon(), (link.getAttribute('href') === FREEDOM_LIFEX_LOGO))};
    });
    if(!/^data:image\/png/.test(r.href))
      throw new Error('the tab icon before boot is ' + r.href);
    if(!r.afterBoot) throw new Error('setFavicon no longer follows the company logo');
    return 'a PNG of the wings in the tab, swapped for the firm\u2019s own logo at boot';
  });

  t.section('and the copy an existing install is holding');

  await t.step('whatever it is holding is replaced, once', async () => {
    /* The live install was not holding the old built-in: it was
       holding a logo somebody had uploaded, which is why the first
       version of this \u2014 which stepped around uploads \u2014 changed
       nothing on the site it was written for. */
    const r = await t.eval(async ()=>{
      const theirs = 'data:image/png;base64,' + 'Z'.repeat(400);
      DB.config.company.logoDataUrl = theirs;
      DB.config.company.logoUrl = 'https://example.test/old-mark.png';
      delete DB.config.company.logoResetId;
      await save('config');
      const n = await migrateBuiltInLogo();
      return {n, now: DB.config.company.logoDataUrl === FREEDOM_LIFEX_LOGO,
              url: DB.config.company.logoUrl,
              stamped: DB.config.company.logoResetId === LOGO_RESET_ID,
              again: await migrateBuiltInLogo()};
    });
    if(!r.n) throw new Error('it left the old logo where it was');
    if(!r.now) throw new Error('it changed something, but not to the new mark');
    if(r.url) throw new Error('logoUrl still points at ' + r.url
      + ' \u2014 the report header reads that one first, so the old mark would come back on '
      + 'the one document a client actually receives');
    if(!r.stamped) throw new Error('it did not record that it had run');
    if(r.again) throw new Error('it ran again on a database it had already changed');
    return 'replaced once, logoUrl cleared with it, and a no-op on the next boot';
  });

  await t.step('and a logo uploaded after that stands', async () => {
    const r = await t.eval(async ()=>{
      const mine = 'data:image/png;base64,' + 'Y'.repeat(400);
      DB.config.company.logoDataUrl = mine;      // the firm uploads their own, later
      await save('config');
      const n = await migrateBuiltInLogo();      // and the app is restarted
      const kept = DB.config.company.logoDataUrl === mine;
      DB.config.company.logoDataUrl = FREEDOM_LIFEX_LOGO;
      await save('config');
      return {n, kept};
    });
    if(r.n) throw new Error('it ran a second time');
    if(!r.kept) throw new Error('an upload made after the change was overwritten');
    return 'the one-time swap does not come back for it';
  });
});
