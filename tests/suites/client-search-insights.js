/* CLIENT SEARCH BY NAME, CLIENT ID OR MOBILE — AND ACTION NEEDED / LEXI THAT OPEN ON A CLICK.

   Changes 13-11-2026. Typing an RM's name into the client list used to list
   every client of that RM; the search now reads three fields and nothing
   else. And the client page's Action Needed and LEXI Insights stay compact
   until an item is clicked, each opening on its own. */
const {suite} = require('../lib/harness');

suite(async t => {
  let ids;
  await t.step('two clients, one of them looked after by an RM whose name is searched for', async () => {
    ids = await t.eval(async ()=>{
      const rm = {id: uid('USR'), name: 'Zzshubham Zzseth', email: 'zz.rm.search@finowise.test', role: DB.team[0].role, status: 'Active', perms: {}, adminFlags: {}, createdAt: new Date().toISOString(), documents: [], notes: []};
      DB.team.push(rm); await save('team');
      const mk = (name, mobile, rmName)=>{ const c = {id: uid('CMS'), cmsName: name, mobile, rmName, branch: 'Varanasi', createdAt: new Date().toISOString(), createdBy: currentUser}; initState('CMS', c); DB.clients.push(c); return c; };
      const a = mk('ZZ Aaditya Maurya', '7380572744', rm.id), b = mk('Zzshubham Zzseth Junior', '9988776655', currentUser);
      await save('clients');
      return {a: a.id, b: b.id};
    });
    return 'set up';
  });
  const search = q => t.eval(async q=>{ window._cmsSearch = q; navigate('cms'); await new Promise(z=>setTimeout(z, 200));
    return [...document.querySelectorAll('#content tbody tr')].map(r=>r.innerText).join('\n'); }, q);

  await t.step('the RM\'s name finds only the client called that, not the RM\'s clients', async () => {
    const r = await search('zzshubham zzseth');
    if(/ZZ Aaditya Maurya/.test(r)) throw new Error('matched on the RM column');
    if(!/Zzshubham Zzseth Junior/.test(r)) throw new Error('the client of that name is missing');
    return 'name only';
  });
  await t.step('part of a name, part of a client ID, and part of a mobile number each find the client', async () => {
    const byName = await search('aadit');
    const byId = await search(ids.a.slice(-6).toLowerCase());
    const byMobile = await search('057274');
    const byPlus = await search('+91 73805 72744');
    const bad = [['name', byName], ['client ID', byId], ['mobile', byMobile], ['+91 mobile', byPlus]].filter(([, r])=>!/ZZ Aaditya Maurya/.test(r)).map(([k])=>k);
    if(bad.length) throw new Error('not found by ' + bad.join(', '));
    const branch = await search('varanasi');
    if(/ZZ Aaditya Maurya/.test(branch)) throw new Error('still matches the branch');
    return 'name, ID and mobile; branch no longer matches';
  });

  await t.step('Action Needed and LEXI Insights: compact, and each item opens on its own with a click', async () => {
    const r = await t.eval(async (id)=>{
      window._cmsSearch = '';
      window._clientTab = 'overview'; navigate('cms', id); await new Promise(z=>setTimeout(z, 300));
      const gaps = [...document.querySelectorAll('.cp-gap')], ins = [...document.querySelectorAll('.boss-ins-row')];
      const openAtStart = gaps.concat(ins).filter(d=>d.open).length;
      gaps[0].querySelector('summary').click(); ins[0].querySelector('summary').click();
      await new Promise(z=>setTimeout(z, 50));
      const text = ins[0].querySelector('.boss-ins-text'), more = gaps[0].querySelector('.cp-gap-more');
      const res = {gaps: gaps.length, ins: ins.length, openAtStart, gapOpen: gaps[0].open, othersShut: gaps.slice(1).every(d=>!d.open) && ins.slice(1).every(d=>!d.open),
        detail: more ? more.innerText : '', wraps: getComputedStyle(text).whiteSpace !== 'nowrap',
        cutBefore: getComputedStyle(ins[1] ? ins[1].querySelector('.boss-ins-text') : text).textOverflow};
      gaps[0].querySelector('summary').click(); await new Promise(z=>setTimeout(z, 50)); res.closedAgain = !gaps[0].open;
      return res;
    }, ids.a);
    if(!r.gaps || !r.ins) throw new Error('no items: ' + JSON.stringify(r));
    if(r.openAtStart) throw new Error(r.openAtStart + ' open before any click');
    if(!r.gapOpen || !/Needed:/.test(r.detail)) throw new Error('an Action Needed item did not open to its details');
    if(!r.othersShut) throw new Error('opening one opened others');
    if(!r.wraps || r.cutBefore !== 'ellipsis') throw new Error('LEXI text is not shortened until opened');
    if(!r.closedAgain) throw new Error('a second click did not close it');
    return r.gaps + ' actions, ' + r.ins + ' insights; one opens at a time, a second click closes';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
