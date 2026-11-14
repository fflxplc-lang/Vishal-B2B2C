/* Export Active Partners on PMS: an .xlsx of every Active Partner the
   person can see. Its first columns are Import Active Partners' own, in
   that order, so the sheet goes straight back in and updates the same
   partners; what BOSS knows beyond that follows. A partner who is not yet
   active is not on it. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  await t.step('two partners imported as active, one still onboarding', async () => {
    const r = await t.eval(async () => {
      window.alert = () => {};
      pobOpenImportActive();
      const sheet = 'Full Name,Partner Code,Access Email,Employee/ARN Code,Level,Reports To,Role,Sharing %,Additional Levels,GSTIN,PAN,Account Holder,Bank Name,Branch,Account Number,IFSC,Street,City,State,Pincode,Mapped Clients,Mobile\n'
        + 'Kavya Exp,OUR-101,kavya.exp@example.com,ARN-111,L3,,Partner,75,L2,27ABCDE1234F1Z5,ABCDE1234F,Kavya Exp,HDFC Bank,Andheri,50100099,HDFC0001234,12 MG Road,Mumbai,Maharashtra,400001,,9876511111\n'
        + 'Nikhil Exp,,nikhil.exp@example.com,EMP-22,L1,kavya.exp@example.com,Partner,25,,,,,,,,,,Pune,Maharashtra,,,\n';
      const input = document.getElementById('pobImpFile');
      const dt = new DataTransfer(); dt.items.add(new File([sheet], 'p.csv', {type: 'text/csv'})); input.files = dt.files;
      await pobImportRead(input);
      await pobImportApply();
      const p = {id: uid('PMS'), firstName: 'Not', lastName: 'Yet', mobile: '9876522222', email: 'not.yet@example.com', assignedTo: currentUser, createdAt: new Date().toISOString()};
      initState('PMS', p); p.pmsStage = 'onboarded'; pjPartners().push(p); await save('pjPartners');
      await pobStart(p.id, {quiet: true});
      return pobLive().map(x => pjName(x) + ':' + stateOf('POB', x)).sort().join(', ');
    });
    if(!/Kavya Exp:active/.test(r) || !/Nikhil Exp:active/.test(r) || /Not Yet:active/.test(r)) throw new Error(r);
    return r;
  });

  let rows;
  await t.step('PMS offers Export Active Partners, and it writes the active ones only', async () => {
    const r = await t.eval(async () => {
      window._pobTab = 'partners'; navigate('pob');
      const button = /Export Active Partners/.test(document.getElementById('content').textContent);
      let got = null; const real = window.downloadXlsx;
      window.downloadXlsx = (sheets, name) => { got = {sheets, name}; return 1; };
      await pobExportActive();
      window.downloadXlsx = real;
      const bytes = got ? xlsxWrite(got.sheets).length : 0;
      return {button, bytes, name: got && got.name, sheet: got && got.sheets[0].name, rows: got && got.sheets[0].rows};
    });
    if(!r.button) throw new Error('no Export Active Partners button');
    if(!/^Active_Partners_\d{8}\.xlsx$/.test(r.name) || r.sheet !== 'Active Partners') throw new Error(r.name + ' / ' + r.sheet);
    rows = r.rows;
    if(!(r.bytes > 1000)) throw new Error('the .xlsx was not written: ' + r.bytes + ' bytes');
    if(rows.length !== 3) throw new Error(rows.length - 1 + ' partners exported: ' + rows.map(x => x[0]).join(', '));
    return rows.length - 1 + ' active partners in ' + r.name + '; Not Yet left out';
  });

  await t.step('the columns are the import\'s, then the rest, and the values are right', async () => {
    const head = rows[0];
    const want = ['Full Name','Partner Code','Access Email','Employee/ARN Code','Level','Reports To','Role','Sharing %','Additional Levels','GSTIN','PAN',
      'Account Holder','Bank Name','Branch','Account Number','IFSC','Street','City','State','Pincode','Mapped Clients'];
    if(head.slice(0, want.length).join('|') !== want.join('|')) throw new Error(head.join('|'));
    for(const c of ['Mobile', 'Application ID', 'Level Name', 'Owner', 'Login Status']) if(!head.includes(c)) throw new Error('no ' + c + ' column');
    const row = n => { const r = rows.find(x => x[0] === n); return k => r[head.indexOf(k)]; };
    const k = row('Kavya Exp'), n = row('Nikhil Exp');
    const bad = [['Partner Code', k('Partner Code'), 'OUR-101'], ['Access Email', k('Access Email'), 'kavya.exp@example.com'], ['Level', k('Level'), 'L3'],
      ['ARN', k('Employee/ARN Code'), 'ARN-111'], ['Sharing', String(k('Sharing %')), '75'], ['Extra', k('Additional Levels'), 'L2'], ['IFSC', k('IFSC'), 'HDFC0001234'],
      ['Account', k('Account Number'), '50100099'], ['City', k('City'), 'Mumbai'], ['Mobile', k('Mobile'), '9876511111'], ['Login', k('Login Status'), 'Activated'],
      ['Nikhil reports to', n('Reports To'), 'kavya.exp@example.com'], ['Nikhil level', n('Level'), 'L1']].filter(([, got, want]) => got !== want);
    if(!/^FLX-P-\d{4}$/.test(n('Partner Code'))) bad.push(['Nikhil code', n('Partner Code'), 'FLX-P-…']);
    if(bad.length) throw new Error(JSON.stringify(bad));
    return 'Kavya OUR-101 L3 with ARN, bank and address; Nikhil ' + n('Partner Code') + ' L1 reporting to Kavya';
  });

  await t.step('the exported sheet reads straight back into Import Active Partners as updates', async () => {
    const r = await t.eval(rows => {
      pobOpenImportActive();
      const plan = pobImportPlan(pobImportTable({headers: rows[0], rows: rows.slice(1)}));
      closeModal();
      return plan.map(p => ({name: p.x.name, update: !!p.pob, skip: p.skip, why: p.problems.concat(p.warn).join('; ')}));
    }, rows);
    if(r.length !== 2 || r.some(p => !p.update || p.skip || p.why)) throw new Error(JSON.stringify(r));
    return 'both rows match their partners, with nothing to correct';
  });

  await t.step('nothing was alerted', async () => {
    if(t.dialogs.length) throw new Error('alerts: ' + t.dialogs.join(' | ').slice(0, 200));
    return 'none';
  });
});
