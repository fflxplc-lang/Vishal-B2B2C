/* A REVIEW'S PORTFOLIO SHOWS THE HOLDINGS THAT WERE UPLOADED.

   The firm opened an RMS review for a client whose money came in on a
   platform upload and saw Live AUM ₹0 and "No completed transactions, so
   there is no portfolio yet": the panel counted only BOSS's own
   transactions. It shows the book now — the platform's figures where a
   report is in — with the product split and the schemes, the same figures
   as the client's own page. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();
  let ids;

  await t.step('a client whose holdings came only from a platform upload, and a review for them', async () => {
    ids = await t.eval(async ()=>{
      const now = new Date().toISOString();
      const c = {id: uid('CMS'), cmsName: 'ZZ Sapna Upload', pan: 'ZZSAP1234U', rmName: currentUser, clientCategory: 'Alpha', createdAt: now, createdBy: currentUser};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      await maCreateUpload({uploadType: 'client', clientName: c.cmsName, clientId: c.id, platform: 'Finowise', product: 'MF', kind: 'aum',
        file: 'finowise-Investor-Wise-AUM-Report.xlsx', rows: [
          {client_name: c.cmsName, security_name: 'ZZ Flexi Cap Fund', isin: 'INF000ZZS001', invested: 50000, current_value: 52494},
          {client_name: c.cmsName, security_name: 'ZZ Liquid Fund', isin: 'INF000ZZS002', invested: 37000, current_value: 35000}]});
      await maCreateUpload({uploadType: 'client', clientName: c.cmsName, clientId: c.id, platform: 'Finowise', product: 'MF', kind: 'sip',
        file: 'finowise-SIP.xlsx', rows: [{client_name: c.cmsName, security_name: 'ZZ Flexi Cap Fund', sip_amount: 2000, frequency: 'Monthly', status: 'Active', monthly_amount: 2000, live: true}]});
      await maSyncCrm({});
      const r = {id: uid('RMS'), clientId: c.id, reviewType: 'Portfolio Review', meetingDate: '2027-02-11'};
      initState('RMS', r); DB.reviews.push(r); await save('reviews');
      return {client: c.id, review: r.id, book: clientBookAum(c), sip: clientBookSip(c)};
    });
    if(ids.book !== 87494) throw new Error('the client\'s book AUM is ' + ids.book);
    return 'book AUM 87,494, SIP ' + ids.sip;
  });

  await t.step('the review\'s Portfolio Review tab shows the uploaded figures, not ₹0', async () => {
    const r = await t.eval(async (ids)=>{
      window._rmsTab = 'portfolio'; window._rmsPfSection = 'portfolio';
      navigate('rms', ids.review);
      await new Promise(z=>setTimeout(z, 300));
      return document.getElementById('content').innerText;
    }, ids);
    const flat = r.replace(/\s+/g, ' ');
    if(/Live AUM ₹0\b/i.test(flat)) throw new Error('Live AUM still reads ₹0');
    if(!/Live AUM ₹87,494/i.test(flat)) throw new Error('Live AUM is not the uploaded figure: ' + flat.slice(flat.search(/Live AUM/i), flat.search(/Live AUM/i) + 200));
    if(!/2,000\/month/.test(flat)) throw new Error('Live SIP does not show the uploaded SIP');
    if(/No completed transactions, so there is no portfolio yet/.test(flat)) throw new Error('it still says there is no portfolio');
    if(!/Mutual Fund/.test(flat) || !/ZZ Flexi Cap Fund/.test(flat) || !/ZZ Liquid Fund/.test(flat)) throw new Error('the product split or the schemes are missing');
    if(/No transaction platform is connected/.test(flat)) throw new Error('it still says the figures are only what was invested');
    return 'Live AUM 87,494 · SIP 2,000/month · Mutual Fund · both schemes listed';
  });

  await t.step('a client with neither transactions nor uploads still says so plainly', async () => {
    const r = await t.eval(async ()=>{
      const c = {id: uid('CMS'), cmsName: 'ZZ Empty Book', createdAt: new Date().toISOString()};
      initState('CMS', c); DB.clients.push(c); await save('clients');
      return pfClientHtml(c, pfPerformanceNote()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    });
    if(!/no portfolio yet/.test(r)) throw new Error(r.slice(0, 400));
    return 'says there is no portfolio yet';
  });
});
