/* A CLIENT'S PORTFOLIO, EDITED PLATFORM BY PLATFORM — AND EVERY SCREEN FOLLOWS.

   On the Portfolio tab an investment is added or corrected platform by
   platform, with its category, invested, current value, XIRR, date and
   monthly SIP. The platform lines are what the book AUM, the dashboard and
   the review report add up, so the change is the figure everywhere.

   An imported line is not edited in place (an upload rebuilds it): the
   change is a line of its own, and the newer one counts — the hand entry
   sets the imported figures aside, a file uploaded after it sets the hand
   entry aside, and removing the hand entry brings the import back. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  let id;
  const book = () => t.eval(id => {
    const c = DB.clients.find(x => x.id === id);
    const dash = mdBookRows().filter(r => r.clientId === id).reduce((s, r) => s + (r.aum || 0), 0);
    return {book: clientBookAum(c), sip: clientBookSip(c), platform: pfPlatformValue(id), dash,
      lines: pfPlatformHoldings(id).map(h => impPlatformLabel(h.platform) + ' ' + (h.product || 'MF') + ' ' + h.current + (h.source === 'manual' ? ' (entered)' : ''))};
  }, id);

  await t.step('a client with an imported Finowise mutual fund line', async () => {
    id = await t.eval(async () => {
      const c = {id: uid('CMS'), cmsName: 'ZZ Portfolio Edit', pan: 'ZZPED1234E', branch: (DB.config.branches || ['Varanasi'])[0], rmName: currentUser,
        createdAt: new Date().toISOString()};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      DB.platformHoldings.push({id: uid('PHD'), key: 'finowise|' + c.id, clientId: c.id, platform: 'finowise', report: 'AUM', format: 'finowise_aum',
        invested: 87000, current: 87494, xirr: 0.72, asOf: new Date(Date.now() - 86400000).toISOString(), firstSeenAt: new Date().toISOString()});
      await save('platformHoldings');
      return c.id;
    });
    const b = await book();
    if(b.book !== 87494) throw new Error(JSON.stringify(b));
    return 'book AUM ' + b.book;
  });

  await t.step('the Portfolio tab offers to add and to edit, line by line', async () => {
    const r = await t.eval(id => { navigate('cms', id); window._clientTab = 'portfolio';
      const tab = [...document.querySelectorAll('.tab')].find(x => /Portfolio/.test(x.textContent)); if(tab) tab.click();
      const c = document.getElementById('content');
      return {add: !!document.getElementById('pfAddBtn'), edit: [...c.querySelectorAll('.pf-line button')].map(b => b.textContent.trim())}; }, id);
    if(!r.add || !r.edit.includes('Edit')) throw new Error(JSON.stringify(r));
    return 'Add / Update Investment, and Edit on the Finowise line';
  });

  await t.step('a Stocks investment at Motilal Oswal is added: the book, the dashboard and the SIP follow', async () => {
    await t.eval(id => pfOpenEditor(id), id);
    await t.page.fill('#pf_platform', 'Motilal Oswal');
    await t.page.selectOption('#pf_product', 'Stocks');
    await t.page.fill('#pf_invested', '40000');
    await t.page.fill('#pf_current', '50000');
    await t.page.fill('#pf_sip', '5000');
    await t.page.click('#pf_save');
    await t.wait(500);
    const b = await book();
    if(b.book !== 137494 || b.dash !== 137494 || b.platform !== 137494) throw new Error(JSON.stringify(b));
    if(b.sip !== 5000) throw new Error('SIP ' + b.sip);
    return 'book, dashboard and platform total all 1,37,494; SIP 5,000/month';
  });

  await t.step('the imported Finowise line is corrected: the entry counts, the import is set aside, not doubled', async () => {
    const line = await t.eval(id => pfPlatformHoldings(id).find(h => h.platform === 'finowise').id, id);
    await t.eval(([id, line]) => pfOpenEditor(id, line), [id, line]);
    await t.page.fill('#pf_current', '95000');
    await t.page.fill('#pf_xirr', '9.5');
    await t.page.click('#pf_save');
    await t.wait(500);
    const b = await book();
    const shadow = await t.eval(id => DB.platformHoldings.filter(h => h.clientId === id && h.platform === 'finowise').map(h => ({s: h.source || 'import', del: !!h.deletedAt, sh: !!h.manualShadowed})), id);
    if(b.book !== 145000 || b.dash !== 145000) throw new Error(JSON.stringify({b, shadow}));
    if(!shadow.some(x => x.s === 'import' && x.del && x.sh)) throw new Error('the import was not set aside: ' + JSON.stringify(shadow));
    const audit = await t.eval(id => DB.auditLog.filter(a => a.recordId === id && /Portfolio Updated|Investment Added/.test(a.action)).length, id);
    if(audit < 2) throw new Error('the changes are not in the audit trail');
    return 'Finowise now 95,000 (entered) + Motilal 50,000 = 1,45,000; the import set aside; both changes audited';
  });

  await t.step('a Finowise file uploaded later is fresher: it counts again, and the entry is set aside', async () => {
    const b = await t.eval(async id => {
      const h = DB.platformHoldings.find(x => x.clientId === id && x.platform === 'finowise' && x.source !== 'manual');
      Object.assign(h, {current: 99000, invested: 88000, asOf: new Date(Date.now() + 1000).toISOString()});
      await save('platformHoldings');
      return {aum: clientBookAum(DB.clients.find(x => x.id === id)), manual: DB.platformHoldings.find(x => x.clientId === id && x.source === 'manual' && pfPlatKey(x.platform) === 'finowise')};
    }, id);
    if(b.aum !== 149000 || !b.manual.deletedAt) throw new Error(JSON.stringify(b));
    return 'the new file 99,000 + Motilal 50,000 = 1,49,000; the older entry set aside';
  });

  await t.step('removing the Motilal entry takes it out of the book', async () => {
    await t.eval(async id => {
      window.confirm = () => true;
      const m = DB.platformHoldings.find(x => x.clientId === id && x.source === 'manual' && pfPlatKey(x.platform) === 'motilaloswal');
      await pfRemoveManual(m.id);
    }, id);
    const b = await book();
    if(b.book !== 99000 || b.sip !== 0) throw new Error(JSON.stringify(b));
    return 'book back to 99,000, SIP 0';
  });

  await t.step('nothing was alerted', async () => {
    if(t.dialogs.length) throw new Error('alerts: ' + t.dialogs.join(' | ').slice(0, 200));
    return 'none';
  });
});
