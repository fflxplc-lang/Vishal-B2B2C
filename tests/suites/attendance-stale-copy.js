/* "ATTENDANCE IS APPEND-ONLY: ATTENDANCE … WAS DROPPED" — NEVER FOR A COLLEAGUE'S ROW.

   Every open tab of somebody who is punched in writes attendance in the
   background (the activity heartbeat). The store is one list for everybody,
   and a tab's copy can be a moment behind: a colleague punched in a second
   ago and the change has not reached this tab yet. Sending that copy dropped
   the colleague's row; the server refused it, and the refusal popped up in
   front of whoever was punched in. A tab now writes its own person's rows
   into the list as the server holds it. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  await t.step('punched in', async () => {
    /* Open the punch clock all day, as attendance-rules does: the test must
       not depend on the hour it happens to run at. */
    const r = await t.eval(async ()=>{ const c = hrCfg(); c.day.punchInFrom = '00:00'; c.day.punchOutUntil = '23:59'; DB.hrConfig = c; await save('hrConfig');
      await hrPunchIn(); await new Promise(z=>setTimeout(z, 300));
      return !!hrOpenSession(hrAttendanceOf(currentUser, hrToday())); });
    if(!r) throw new Error('the punch did not land: ' + t.dialogs.join(' / '));
    return 'open session today';
  });

  await t.step('a colleague punches in elsewhere; this tab, a moment behind, writes its heartbeat', async () => {
    const r = await t.eval(async ()=>{
      /* The colleague's row goes straight to the server, as their own device
         would send it; this tab's copy does not have it. */
      const server = (await sget('hrAttendance', [])) || [];
      const theirs = {id: uid('HRA'), userId: 'USR-ZZCOLLEAGUE', date: hrToday(),
        sessions: [{in: new Date().toISOString()}], createdAt: new Date().toISOString()};
      await fetch('/api/storage/hrAttendance', {method: 'PUT',
        headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json', 'X-Client-Id': 'colleague-phone'}),
        body: JSON.stringify({value: JSON.stringify(server.concat([theirs]))})});
      if((DB.hrAttendance || []).some(x=>x.id === theirs.id)) DB.hrAttendance = DB.hrAttendance.filter(x=>x.id !== theirs.id);
      const dialogsBefore = window._zzDialogs = 0;
      const realAlert = window.alert; window.alert = m=>{ window._zzDialogs++; realAlert.call(window, m); };
      try {
        hrAct.savedAt = 0;
        await hrActBeat(true);
        await new Promise(z=>setTimeout(z, 300));
      } finally { window.alert = realAlert; }
      const after = (await sget('hrAttendance', [])) || [];
      const mine = after.find(x=>x.userId === currentUser && x.date === hrToday());
      return {alerts: window._zzDialogs, colleagueKept: after.some(x=>x.id === theirs.id),
        mineSaved: !!(mine && mine.updatedAt), localHasColleague: (DB.hrAttendance || []).some(x=>x.id === theirs.id)};
    });
    if(r.alerts) throw new Error('somebody was shown a refusal for a background write');
    if(!r.colleagueKept) throw new Error('the colleague\'s punch was dropped');
    if(!r.mineSaved) throw new Error('this person\'s heartbeat did not save');
    if(!r.localHasColleague) throw new Error('this tab still does not hold the colleague\'s row');
    return 'no alert; the colleague\'s punch kept; this heartbeat saved; this tab caught up';
  });

  await t.step('the server still refuses a write that would drop a row, from anywhere', async () => {
    t.expectConsole(/409/);              // the refusal is the point
    const r = await t.eval(async ()=>{
      const server = (await sget('hrAttendance', [])) || [];
      const res = await fetch('/api/storage/hrAttendance', {method: 'PUT',
        headers: Object.assign({}, apiHeaders(), {'Content-Type': 'application/json'}),
        body: JSON.stringify({value: JSON.stringify(server.slice(1)), removed: [server[0].id]})});
      return {status: res.status, body: await res.text()};
    });
    if(r.status !== 409 || !/was dropped/.test(r.body)) throw new Error('the guard did not refuse: ' + r.status + ' ' + r.body);
    return 'refused with 409';
  });
});
