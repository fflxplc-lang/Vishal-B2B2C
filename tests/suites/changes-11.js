/* CHANGES 11 — four requests from the firm's document of that name.

   1. DWT slot editor: no client/lead dropdown on the label, it is typed.
   2. DWT Actual: completing one day of a recurring slot (the Daily
      Declaration Meeting, Monday to Friday) completes that day only, and
      that block turns green; the other days keep their own status.
   3. DST: a Task Time column on sub-tasks for the time spent, and every
      date and time field opens its calendar when clicked.
   4. QMS: Raise a Ticket takes images. */
const {suite} = require('../lib/harness');

/* A tiny real PNG (1x1), so the browser treats it as an image. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

suite(async t => {
  await t.home();

  t.section('1 · DWT slot editor');

  await t.step('the label is typed by hand: no dropdown of clients and leads', async () => {
    const r = await t.eval(async ()=>{
      navigate('dwt');
      const today = new Date().toISOString().slice(0, 10);
      openDwtSlotEditor(today, '09:00');
      await new Promise(z=>setTimeout(z, 150));
      const el = document.getElementById('f_slotLabel');
      const out = {list: el.getAttribute('list'), datalists: document.querySelectorAll('#modalBody datalist').length, ph: el.placeholder};
      closeModal();
      return out;
    });
    if(r.list || r.datalists) throw new Error('the label still has a dropdown: ' + JSON.stringify(r));
    return 'plain text box — "' + r.ph + '"';
  });

  t.section('2 · DWT Actual: one day at a time');

  let act;
  await t.step('a slot Monday to Friday, every week', async () => {
    act = await t.eval(async ()=>{
      const st = dwtState();
      const dates = weekDates(st.weekStart);
      const dow = d => new Date(d + 'T00:00:00').getDay();
      const mon = dates.find(d=>dow(d) === 1), tue = dates.find(d=>dow(d) === 2), wed = dates.find(d=>dow(d) === 3);
      const a = {id: uid('WA'), userId: st.userId, date: mon, activityType: 'Blocked / recurring', title: 'ZZ Daily Declaration Meeting',
        plannedStart: '09:00', plannedEnd: '09:30', days: [1, 2, 3, 4, 5], repeatWeekly: true, status: 'Planned', sourceType: 'manual',
        createdAt: new Date().toISOString(), createdBy: currentUser};
      a.sourceId = a.id;
      DB.workActivities.push(a); await save('workActivities');
      return {id: a.id, mon, tue, wed};
    });
    return 'Mon ' + act.mon + ', Tue ' + act.tue;
  });

  const statuses = () => t.eval((act)=>{
    const st = dwtState();
    const bs = dwtBlocks(st.userId, weekDates(st.weekStart)).filter(b=>b.id === act.id);
    const o = {}; bs.forEach(b=>{ o[b.date] = b.status; }); return o;
  }, act);

  await t.step('marking Monday completed completes Monday only', async () => {
    const r = await t.eval(async (act)=>{
      window._dwt.mode = 'actual'; navigate('dwt');
      openDwtActualEditor(act.id, act.mon);
      await new Promise(z=>setTimeout(z, 100));
      const btn = [...document.querySelectorAll('.modal button')].find(b=>/Mark Completed/.test(b.textContent));
      btn.click();
      await new Promise(z=>setTimeout(z, 400));
      return true;
    }, act);
    const s = await statuses();
    if(s[act.mon] !== 'Completed') throw new Error('Monday is not completed: ' + JSON.stringify(s));
    const others = Object.entries(s).filter(([d, v])=>d !== act.mon && v === 'Completed');
    if(others.length) throw new Error('other days were completed too: ' + JSON.stringify(s));
    return JSON.stringify(s);
  });

  await t.step('the completed block is green; Tuesday\'s is not', async () => {
    const r = await t.eval(async (act)=>{
      window._dwt.mode = 'actual'; navigate('dwt');
      await new Promise(z=>setTimeout(z, 150));
      const blocks = [...document.querySelectorAll('.dwt-block')].filter(b=>(b.getAttribute('onclick') || '').indexOf(act.id) >= 0);
      const at = d => blocks.find(b=>(b.getAttribute('onclick') || '').indexOf(d) >= 0);
      const bg = el => el ? getComputedStyle(el).backgroundColor : '';
      return {mon: bg(at(act.mon)), tue: bg(at(act.tue)), monDone: !!(at(act.mon) && at(act.mon).classList.contains('dwt-done')),
        tueDone: !!(at(act.tue) && at(act.tue).classList.contains('dwt-done'))};
    }, act);
    const green = c => { const m = c.match(/\d+/g); return m && Number(m[1]) > Number(m[0]) && Number(m[1]) > Number(m[2]); };
    if(!r.monDone || !green(r.mon)) throw new Error('Monday is not shown green: ' + JSON.stringify(r));
    if(r.tueDone || green(r.tue)) throw new Error('Tuesday is shown completed: ' + JSON.stringify(r));
    return 'Monday ' + r.mon + ', Tuesday ' + r.tue;
  });

  await t.step('Tuesday completed as well keeps Monday; reopening Monday leaves Tuesday', async () => {
    await t.eval(async (act)=>{
      for(const [d, done] of [[act.tue, true], [act.mon, false]]){
        openDwtActualEditor(act.id, d);
        await new Promise(z=>setTimeout(z, 100));
        if(done) [...document.querySelectorAll('.modal button')].find(b=>/Mark Completed/.test(b.textContent)).click();
        else await dwtReopenBlock();
        await new Promise(z=>setTimeout(z, 300));
      }
    }, act);
    const s = await statuses();
    if(s[act.tue] !== 'Completed' || s[act.mon] === 'Completed') throw new Error(JSON.stringify(s));
    const rec = await t.eval((act)=>DB.workActivities.find(a=>a.id === act.id).status, act);
    if(rec !== 'Planned') throw new Error('the slot itself was marked ' + rec + '; only its days should be');
    return JSON.stringify(s);
  });

  await t.step('a slot completed before this change counts on the day it was marked, not every day', async () => {
    const r = await t.eval(async (act)=>{
      const st = dwtState();
      const a = {id: uid('WA'), userId: st.userId, date: act.mon, activityType: 'Blocked / recurring', title: 'ZZ Old completed',
        plannedStart: '10:00', plannedEnd: '10:30', days: [1, 2, 3, 4, 5], repeatWeekly: true, status: 'Completed',
        completedOn: act.wed, sourceType: 'manual', createdAt: new Date().toISOString(), createdBy: currentUser};
      DB.workActivities.push(a); await save('workActivities');
      const bs = dwtBlocks(st.userId, weekDates(st.weekStart)).filter(b=>b.id === a.id);
      return bs.filter(b=>b.status === 'Completed').map(b=>b.date);
    }, act);
    if(r.length !== 1 || r[0] !== act.wed) throw new Error('completed on: ' + JSON.stringify(r));
    return 'only ' + r[0];
  });

  t.section('3 · DST Task Time, and calendars');

  let parent;
  await t.step('Task Time on a sub-task is a time picker, saved as HH:MM (24-hour)', async () => {
    parent = await t.eval(async ()=>{
      const p = {id: uid('DST'), taskType: 'Send Portfolio Statement', description: 'ZZ share portfolio report', overallStatus: 'Not Started',
        assignTo: currentUser, createdBy: currentUser, createdAt: new Date().toISOString(),
        assignedDate: new Date().toISOString().slice(0, 10), dueDate: new Date().toISOString().slice(0, 10)};
      DB.tasks.push(p); await save('tasks');
      return p.id;
    });
    const r = await t.eval(async (pid)=>{
      let kind = '';
      const add = async (desc, time)=>{
        openSubTaskModal(pid);
        await new Promise(z=>setTimeout(z, 80));
        const el = document.getElementById('f_subTime');
        kind = el.tagName + ':' + el.type;
        document.getElementById('f_subDesc').value = desc;
        el.value = time;
        await saveSubTaskRow(pid);
        await new Promise(z=>setTimeout(z, 200));
      };
      await add('ZZ prepare report', '14:30');
      await add('ZZ call client', '09:05');
      const subs = DB.tasks.filter(x=>x.parentTaskId === pid && !x.deletedAt);
      navigate('dst', pid);
      await new Promise(z=>setTimeout(z, 200));
      const table = [...document.querySelectorAll('table')].find(tb=>/Task Time/i.test(tb.innerText));
      const shown = table ? [...table.querySelectorAll('input[type=time]')].map(x=>x.value) : [];
      return {kind, times: subs.map(s=>s.taskTime), shown};
    }, parent);
    if(r.kind !== 'INPUT:time') throw new Error('Task Time is ' + r.kind + ', not a time picker');
    if(r.times.join(',') !== '14:30,09:05') throw new Error('stored: ' + r.times.join(','));
    if(r.shown.join(',') !== '14:30,09:05') throw new Error('the rows show ' + r.shown.join(','));
    return 'any minute (09:05 as well as 14:30), stored and shown as HH:MM';
  });

  await t.step('the picker in a row saves straight away, and is audited', async () => {
    const r = await t.eval(async (pid)=>{
      const sub = DB.tasks.find(x=>x.parentTaskId === pid && x.description === 'ZZ call client');
      const el = document.getElementById('tt_' + sub.id);
      el.value = '17:45';
      el.dispatchEvent(new Event('change', {bubbles: true}));
      const audited = ()=>DB.auditLog.some(a=>a.recordId === pid && (a.details || []).some(d=>d.field === 'Task Time' && d.newValue === '17:45'));
      for(let i = 0; i < 30 && !(sub.taskTime === '17:45' && audited()); i++) await new Promise(z=>setTimeout(z, 100));
      const audit = audited();
      return {now: sub.taskTime, audit};
    }, parent);
    if(r.now !== '17:45' || !r.audit) throw new Error(JSON.stringify(r));
    return 'saved 17:45 from the row; audited';
  });

  await t.step('the task itself has a Task Time, shown in its details, the DST list and DWT', async () => {
    const r = await t.eval(async (pid)=>{
      /* Through the Edit Task form, the way a person sets it. */
      openTaskForm(pid);
      await new Promise(z=>setTimeout(z, 100));
      const el = document.getElementById('f_taskTime');
      const kind = el ? el.tagName + ':' + el.type : 'missing';
      if(el){ el.value = '11:15'; await saveTask(pid); }
      await new Promise(z=>setTimeout(z, 200));
      const t = DB.tasks.find(x=>x.id === pid);
      navigate('dst', pid);
      await new Promise(z=>setTimeout(z, 150));
      const info = document.getElementById('content').innerText;
      navigate('dst');
      await new Promise(z=>setTimeout(z, 150));
      const row = [...document.querySelectorAll('#dstTable tbody tr')].find(tr=>/ZZ share portfolio report/.test(tr.innerText));
      const st = dwtState();
      const block = dwtBlocks(currentUser, weekDates(weekStartOf(t.dueDate))).find(b=>b.sourceId === pid);
      return {kind, saved: t.taskTime, info, row: row ? row.innerText : '', dwt: block ? block.plannedStart : 'none'};
    }, parent);
    if(r.kind !== 'INPUT:time') throw new Error('the task form\'s Task Time is ' + r.kind);
    if(r.saved !== '11:15') throw new Error('saved ' + r.saved);
    if(!/Task Time\s+11:15/i.test(r.info)) throw new Error('the DST information does not show 11:15');
    if(!/, 11:15/.test(r.row)) throw new Error('the DST list does not show the time beside the due date: ' + r.row);
    if(r.dwt !== '11:15') throw new Error('DWT puts the task at ' + r.dwt);
    return 'saved 11:15; shown in details, list ("…, 11:15") and at 11:15 in DWT';
  });

  await t.step('clicking a date or time field opens its calendar', async () => {
    const r = await t.eval(async (pid)=>{
      let opened = [];
      const real = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.showPicker = function(){ opened.push(this.type + '#' + this.id); };
      try {
        openSubTaskModal(pid);
        await new Promise(z=>setTimeout(z, 80));
        document.getElementById('f_subDate').click();
        document.getElementById('f_subDesc').click();
        closeModal();
        const st = dwtState();
        const a = DB.workActivities.find(x=>x.userId === st.userId && x.plannedStart);
        openDwtActualEditor(a.id, a.date);
        await new Promise(z=>setTimeout(z, 80));
        document.getElementById('f_acStart').click();
        const types = [document.getElementById('f_acStart').type, document.getElementById('f_acEnd').type];
        closeModal();
        /* A date of birth is typed, so its calendar does not jump open. */
        openModal('ZZ', '<div class="field"><label>Date of Birth</label><input type="date" id="f_zzDob"></div>', '');
        await new Promise(z=>setTimeout(z, 80));
        document.getElementById('f_zzDob').click();
        closeModal();
        return {opened, types};
      } finally { HTMLInputElement.prototype.showPicker = real; }
    }, parent);
    if(r.opened.join() !== 'date#f_subDate,time#f_acStart') throw new Error('pickers opened: ' + JSON.stringify(r));
    if(r.types.join() !== 'time,time') throw new Error('DWT actual times are not time fields: ' + r.types);
    return r.opened.join(', ') + '; date of birth left for typing';
  });

  t.section('4 · QMS images');

  await t.step('Raise a Ticket takes an image, and refuses a file that is not one', async () => {
    await t.eval(()=>{ navigate('queries'); openQueryForm(); });
    await t.wait(150);
    await t.page.setInputFiles('#f_qImages', {name: 'error-screen.png', mimeType: 'image/png', buffer: PNG});
    await t.wait(200);
    await t.page.setInputFiles('#f_qImages', {name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello')});
    await t.wait(200);
    const r = await t.eval(async ()=>{
      const thumbs = document.querySelectorAll('#qAttachList img').length;
      document.getElementById('f_qSubject').value = 'ZZ App shows an error';
      document.getElementById('f_qDescription').value = 'See the screenshot.';
      await saveQuery('');
      await new Promise(z=>setTimeout(z, 300));
      const q = DB.queries.find(x=>x.subject === 'ZZ App shows an error');
      const file = q && q.attachments && q.attachments[0] ? await sget(qFileKey(q.attachments[0].id), null) : null;
      return {thumbs, n: q ? (q.attachments || []).length : -1, name: q && q.attachments[0] && q.attachments[0].name,
        stored: !!(file && /^data:image\/png;base64,/.test(file.dataUrl)), inStore: JSON.stringify(q).indexOf('base64') >= 0, id: q && q.id};
    });
    if(r.thumbs !== 1) throw new Error('the form shows ' + r.thumbs + ' thumbnails');
    if(r.n !== 1 || r.name !== 'error-screen.png') throw new Error('the ticket lists ' + r.n + ' images');
    if(!r.stored) throw new Error('the image is not on the server');
    if(r.inStore) throw new Error('the picture itself was written into the ticket list');
    if(!t.dialogs.some(d=>/is not an image/.test(d))) throw new Error('the text file was not refused');
    return 'saved under its own key; the text file refused';
  });

  await t.step('the ticket page shows the image', async () => {
    const r = await t.eval(async ()=>{
      const q = DB.queries.find(x=>x.subject === 'ZZ App shows an error');
      for(const k in qImgCache) delete qImgCache[k];          // as a fresh page would
      navigate('queries', q.id);
      for(let i = 0; i < 30 && !document.querySelector('.q-thread .q-img img'); i++) await new Promise(z=>setTimeout(z, 100));
      const img = document.querySelector('.q-thread .q-img img');
      return img ? img.getAttribute('src').slice(0, 22) : '';
    });
    if(!/^data:image\/png/.test(r)) throw new Error('no image on the ticket page');
    return 'shown';
  });

  await t.step('nothing went wrong on the page', async () => {
    if(t.errors.length) throw new Error(t.errors.join(' | '));
    return 'no page errors';
  });
});
