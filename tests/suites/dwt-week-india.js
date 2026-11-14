/* THE DWT WEEK, ON AN INDIAN CLOCK.

   The tests ran on UTC, so nobody saw it: in India (UTC+5:30) every date
   BOSS added days to came back a day early, because local midnight was read
   back through toISOString() as the evening before. The week opened on the
   wrong day (Wednesday), the arrows moved six days, and a recurring slot
   missed the last column. This suite drives the app in Asia/Kolkata. */
const {suite} = require('../lib/harness');
const signIn = require('../lib/signin');
const ready = require('../lib/ready');

suite(async t => {
  const ctx = await t.page.context().browser().newContext({timezoneId: 'Asia/Kolkata', viewport: {width: 1500, height: 950}});
  const p = await ctx.newPage();
  p.on('dialog', d=>d.accept().catch(()=>{}));
  const errs = [];
  p.on('pageerror', e=>errs.push(e.message));
  await signIn(p, t.base);
  await p.goto(t.url('/'), {waitUntil: 'domcontentloaded'});
  await ready(p);

  await t.step('the browser is on Indian time', async () => {
    const off = await p.evaluate(()=>new Date().getTimezoneOffset());
    if(off !== -330) throw new Error('offset ' + off);
    return 'UTC+5:30';
  });

  await t.step('adding days lands on the right date', async () => {
    const r = await p.evaluate(()=>({d1: addInterval('2026-11-13', 1, 'Days'), w: addInterval('2026-11-13', 1, 'Weeks'),
      m: addInterval('2026-01-31', 1, 'Months'), y: addInterval('2026-11-13', 1, 'Years')}));
    if(r.d1 !== '2026-11-14' || r.w !== '2026-11-20' || r.m !== '2026-02-28' || r.y !== '2027-11-13') throw new Error(JSON.stringify(r));
    return JSON.stringify(r);
  });

  await t.step('the week runs Monday to Sunday', async () => {
    const r = await p.evaluate(()=>{
      const start = weekStartOf('2026-11-13');
      const days = weekDates(start).map(d=>['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d + 'T00:00:00').getDay()] + ' ' + d);
      return {start, days};
    });
    if(r.start !== '2026-11-09') throw new Error('the week of Fri 13 Nov starts on ' + r.start);
    if(!/^Mon /.test(r.days[0]) || !/^Sun /.test(r.days[6]) || r.days[6] !== 'Sun 2026-11-15') throw new Error(r.days.join(', '));
    return r.days.join(' · ');
  });

  await t.step('the arrows move a whole week, and the screen shows Mon to Sun', async () => {
    const r = await p.evaluate(async ()=>{
      window._dwt = null;
      navigate('dwt');
      await new Promise(z=>setTimeout(z, 200));
      const st = dwtState();
      st.weekStart = weekStartOf('2026-11-13'); render();
      const a = st.weekStart;
      dwtShiftWeek(1); const b = dwtState().weekStart;
      dwtShiftWeek(-1); const c = dwtState().weekStart;
      await new Promise(z=>setTimeout(z, 150));
      const heads = document.getElementById('content').innerText.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g) || [];
      return {a, b, c, heads: heads.slice(0, 7)};
    });
    if(r.b !== '2026-11-16' || r.c !== '2026-11-09') throw new Error(JSON.stringify(r));
    if(r.heads[0] !== 'Mon' || r.heads[6] !== 'Sun') throw new Error('columns: ' + r.heads.join(' '));
    return '9 Nov → 16 Nov → 9 Nov; columns ' + r.heads.join(' ');
  });

  await t.step('a Monday-to-Friday slot is on all five weekdays, Tuesday included', async () => {
    const r = await p.evaluate(async ()=>{
      const st = dwtState();
      st.weekStart = weekStartOf('2026-11-13');
      const a = {id: uid('WA'), userId: st.userId, date: '2026-11-09', activityType: 'Blocked / recurring', title: 'ZZ DD Meeting',
        plannedStart: '09:00', plannedEnd: '09:30', days: [1, 2, 3, 4, 5], repeatWeekly: true, status: 'Planned', sourceType: 'manual', createdAt: new Date().toISOString()};
      DB.workActivities.push(a); await save('workActivities');
      return dwtBlocks(st.userId, weekDates(st.weekStart)).filter(b=>b.id === a.id).map(b=>b.date);
    });
    if(r.join() !== '2026-11-09,2026-11-10,2026-11-11,2026-11-12,2026-11-13') throw new Error(r.join());
    return r.join(', ');
  });

  await t.step('nothing went wrong on the page', async () => {
    await ctx.close();
    if(errs.length) throw new Error(errs.join(' | '));
    return 'no page errors';
  });
});
