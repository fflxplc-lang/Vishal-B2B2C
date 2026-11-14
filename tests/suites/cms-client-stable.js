/* AN UPLOADED CLIENT OPENS ONCE AND STAYS STILL.

   Opening a client with uploaded holdings in CMS made the whole site
   flicker, looked like a hard refresh, and needed every click pressed two
   or three times. The live NAV lookup is asked from inside a draw and its
   answer draws again; when the answer did not account for the holdings —
   AMFI down, a timeout — they still looked unasked, so the next draw asked
   again: about seventy-five redraws and seventy-five requests a second, a
   screen replaced faster than a click could land on it.

   Here the client is opened with the NAV source failing and with it
   answering, and the screen is counted: one draw (two when NAVs arrive),
   one request, and a tab that opens on the first click. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  let id;
  await t.step('a client with uploaded mutual fund holdings', async () => {
    id = await t.eval(async () => {
      const c = {id: uid('CMS'), cmsName: 'ZZ Stable Client', pan: 'ZZSTB1234S', branch: (DB.config.branches || ['Varanasi'])[0], rmName: currentUser,
        createdAt: new Date().toISOString(), createdBy: currentUser, createdVia: 'Platform upload'};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      const now = new Date().toISOString();
      ['ZZ Flexi Cap Fund - Growth', 'ZZ Liquid Fund - Growth'].forEach((name, i) => DB.platformHoldings.push({id: uid('PHD'), key: 'zz|' + c.id + '|' + i,
        clientId: c.id, platform: 'finowise', product: 'MF', report: 'AUM', schemeName: name, isin: 'INF000ZZ000' + i, units: 100 + i,
        invested: 10000, current: 12000, asOf: now, firstSeenAt: now}));
      await save('platformHoldings');
      return c.id;
    });
    return id;
  });

  const watch = async (navAnswer) => {
    await t.page.unroute('**/api/market/nav').catch(() => {});
    let navCalls = 0;
    await t.page.route('**/api/market/nav', r => { navCalls++; return navAnswer(r); });
    const r = await t.eval(async id => {
      lexiNav.at = 0; lexiNav.asked = {}; lexiNav.map = {}; lexiNav.failedAt = 0; lexiNav.error = '';
      window._draws = 0;
      if(!window._renderWrapped){ const r0 = window.render; window.render = function(){ window._draws++; return r0.apply(this, arguments); }; window._renderWrapped = true; }
      navigate('dashboard');
      window._draws = 0;
      navigate('cms', id);
      await new Promise(res => setTimeout(res, 5000));
      return {draws: window._draws};
    }, id);
    return Object.assign(r, {navCalls});
  };

  await t.step('with the NAV source failing: one draw, one request, then still', async () => {
    const r = await watch(route => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: false, message: 'AMFI did not answer in time'})}));
    if(r.draws > 2 || r.navCalls > 1) throw new Error(r.draws + ' draws and ' + r.navCalls + ' NAV requests in five seconds');
    const note = await t.eval(() => document.getElementById('content').textContent);
    return r.draws + ' draw(s), ' + r.navCalls + ' NAV request';
  });

  await t.step('with the NAV source answering: the values arrive with one more draw, then still', async () => {
    const r = await watch(route => {
      const items = JSON.parse(route.request().postData() || '{}').items || [];
      route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, fetchedAt: new Date().toISOString(),
        results: items.map(q => ({name: q.name, isin: q.isin, code: '1', scheme: q.name, nav: 130, date: '12-Nov-2026'}))})});
    });
    if(r.draws > 3 || r.navCalls > 1) throw new Error(r.draws + ' draws and ' + r.navCalls + ' NAV requests in five seconds');
    return r.draws + ' draw(s), ' + r.navCalls + ' NAV request';
  });

  await t.step('a tab opens on the first click', async () => {
    await t.page.unroute('**/api/market/nav').catch(() => {});
    await t.page.route('**/api/market/nav', r => r.fulfill({status: 200, contentType: 'application/json', body: '{"ok":false,"message":"down"}'}));
    await t.eval(id => { lexiNav.at = 0; lexiNav.asked = {}; lexiNav.failedAt = 0; navigate('cms', id); }, id);
    await t.wait(600);
    const tab = await t.page.$('.tab:has-text("Portfolio")');
    if(!tab) throw new Error('no Portfolio tab');
    await tab.click();
    await t.wait(400);
    const on = await t.eval(() => { const a = document.querySelector('.tab.active'); return a ? a.textContent.trim() : ''; });
    await t.page.unroute('**/api/market/nav').catch(() => {});
    if(!/Portfolio/.test(on)) throw new Error('after one click the active tab is "' + on + '"');
    return 'Portfolio open after one click';
  });

  await t.step('nothing was alerted', async () => {
    if(t.dialogs.length) throw new Error('alerts: ' + t.dialogs.join(' | ').slice(0, 200));
    return 'none';
  });
});
