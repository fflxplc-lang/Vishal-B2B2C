/* A DELETION GOES TO THE REPORTING MANAGER FIRST.

   Somebody deleting their task, a record, a sub-task, a goal or a document
   does not delete it: a request goes to the person they report to, and the
   thing stays where it is until that person approves. Approved, it goes to
   the Recycle Bin, marked with who asked and who approved; rejected, it
   stays, and the person who asked hears why. An administrator, and anybody
   with nobody above them, deletes as before. */
const {suite} = require('../lib/harness');

suite(async t => {
  await t.home();

  let ids;
  await t.step('an RM who reports to a manager, and some of the RM\'s work', async () => {
    ids = await t.eval(async () => {
      window._adminId = currentUser;
      const role = (DB.config.roles||[]).map(r=>r.name||r).find(r=>r && r !== ADMIN_ROLE);
      const now = new Date().toISOString();
      const mk = (id, name, parent) => ({id, name, email: id.toLowerCase() + '@finowise.test', role, status: 'Active', parentUserId: parent,
        branch: DB.team[0].branch, scope: 'all', perms: fullPerms(true), adminFlags: {}, createdAt: now});
      DB.team.push(mk('TM-DEL-MGR', 'Mona Manager', DB.team[0].id), mk('TM-DEL-RM', 'Ravi Rm', 'TM-DEL-MGR'));
      await save('team');
      const task = {id: 'TSK-DEL-1', taskType: 'ZZ Delete Me', description: 'ZZ duplicate task', assignTo: 'TM-DEL-RM', createdBy: 'TM-DEL-RM', overallStatus: 'Not Started', createdAt: now};
      const task2 = {id: 'TSK-DEL-2', taskType: 'ZZ Keep Me', description: 'ZZ second task', assignTo: 'TM-DEL-RM', createdBy: 'TM-DEL-RM', overallStatus: 'Not Started', createdAt: now};
      const sub = {id: 'TSK-DEL-SUB', parentTaskId: 'TSK-DEL-1', taskType: 'ZZ Sub', description: 'ZZ a sub-task', assignTo: 'TM-DEL-RM', createdBy: 'TM-DEL-RM', overallStatus: 'Not Started', createdAt: now};
      DB.tasks.push(task, task2, sub); await save('tasks');
      return {task: task.id, task2: task2.id, sub: sub.id};
    });
    return 'Ravi Rm reports to Mona Manager; three tasks of Ravi\'s';
  });

  const as = id => t.eval(id => { currentUser = id; }, id);
  const said = () => t.eval(() => window._said || []);
  const stubs = (answer) => t.eval(answer => { window._said = []; window.alert = m => window._said.push(m); window.confirm = () => true; window.prompt = () => answer; }, answer);

  await t.step('the RM deletes a task: it becomes a request to the manager, and the task stays', async () => {
    await as('TM-DEL-RM'); await stubs('a duplicate of another task');
    const r = await t.eval(async ids => {
      await softDeleteRecord('DST', ids.task);
      const task = DB.tasks.find(x => x.id === ids.task);
      const req = deleteRequests().find(x => x.args[1] === ids.task);
      const note = DB.notifications.find(n => n.userId === 'TM-DEL-MGR' && n.kind === 'delete-request');
      await softDeleteRecord('DST', ids.task);   // a second press
      return {deleted: !!task.deletedAt, req: req && {status: req.status, approver: req.approverId, reason: req.reason, by: req.requestedBy},
        note: note && note.title, said: window._said};
    }, ids);
    if(r.deleted) throw new Error('the task was deleted without approval');
    if(!r.req || r.req.status !== 'Pending' || r.req.approver !== 'TM-DEL-MGR' || r.req.by !== 'TM-DEL-RM' || !/duplicate/.test(r.req.reason)) throw new Error(JSON.stringify(r.req));
    if(!r.note) throw new Error('the manager was not told');
    if(!/Sent to Mona Manager/.test(r.said[0] || '') || !/already with Mona Manager/.test(r.said[1] || '')) throw new Error(JSON.stringify(r.said));
    return 'request with Mona Manager, reason kept, task still there; pressing again says it is already with her';
  });

  await t.step('a sub-task and a bulk delete go the same way', async () => {
    const r = await t.eval(async ids => {
      await deleteSubTaskRow(ids.task, ids.sub);
      bulkSelection.DST = new Set([ids.task2]);
      await bulkDelete('DST');
      return {sub: !!DB.tasks.find(x => x.id === ids.sub).deletedAt, bulk: !!DB.tasks.find(x => x.id === ids.task2).deletedAt,
        reqs: deleteRequests().filter(x => x.status === 'Pending').map(x => x.fn).sort()};
    }, ids);
    if(r.sub || r.bulk) throw new Error('deleted without approval: ' + JSON.stringify(r));
    if(r.reqs.join() !== 'bulkDelete,deleteSubTaskRow,softDeleteRecord') throw new Error(JSON.stringify(r.reqs));
    return 'three requests waiting; nothing deleted';
  });

  await t.step('the manager sees them under Approvals waiting on you', async () => {
    await as('TM-DEL-MGR');
    const r = await t.eval(() => { navigate('dashboard'); const c = document.getElementById('deleteRequestsCard');
      return {card: !!c, rows: c ? c.querySelectorAll('.del-req').length : 0, text: c ? c.textContent : ''}; });
    if(!r.card || r.rows !== 3) throw new Error(JSON.stringify(r).slice(0, 300));
    if(!/Ravi Rm/.test(r.text) || !/duplicate/.test(r.text)) throw new Error('who asked and why are not shown');
    return r.rows + ' requests, each with who asked and why';
  });

  await t.step('approved: the task goes to the Recycle Bin, marked with who asked and who approved', async () => {
    await stubs('');
    const r = await t.eval(async ids => {
      const req = deleteRequests().find(x => x.fn === 'softDeleteRecord' && x.args[1] === ids.task);
      await decideDeletion(req.id, true);
      const task = DB.tasks.find(x => x.id === ids.task);
      return {at: task.deletedAt, by: task.deletedBy, approved: task.deleteApprovedBy, status: req.status,
        told: DB.notifications.some(n => n.userId === 'TM-DEL-RM' && n.kind === 'delete-decided' && /approved/i.test(n.title))};
    }, ids);
    if(!r.at || r.by !== 'TM-DEL-RM' || r.approved !== 'TM-DEL-MGR' || r.status !== 'Approved' || !r.told) throw new Error(JSON.stringify(r));
    return 'deleted by Ravi Rm, approved by Mona Manager; Ravi told';
  });

  await t.step('rejected: the sub-task stays, and the RM hears why', async () => {
    await stubs('still needed for the audit');
    const r = await t.eval(async ids => {
      const req = deleteRequests().find(x => x.fn === 'deleteSubTaskRow');
      await decideDeletion(req.id, false);
      return {kept: !DB.tasks.find(x => x.id === ids.sub).deletedAt, status: req.status, note: req.note,
        told: (DB.notifications.find(n => n.userId === 'TM-DEL-RM' && /rejected/i.test(n.title)) || {}).body || ''};
    }, ids);
    if(!r.kept || r.status !== 'Rejected' || !/audit/.test(r.told)) throw new Error(JSON.stringify(r));
    return 'kept; Ravi told: ' + r.told;
  });

  await t.step('only the manager (or an administrator) decides', async () => {
    await as('TM-DEL-RM'); await stubs('');
    const r = await t.eval(async ids => {
      const req = deleteRequests().find(x => x.fn === 'bulkDelete');
      await decideDeletion(req.id, true);
      return {status: req.status, deleted: !!DB.tasks.find(x => x.id === ids.task2).deletedAt, said: window._said[0] || ''};
    }, ids);
    if(r.status !== 'Pending' || r.deleted || !/for Mona Manager to decide/.test(r.said)) throw new Error(JSON.stringify(r));
    return 'the RM cannot approve their own request';
  });

  await t.step('an administrator deletes straight away, as before', async () => {
    await t.eval(() => { currentUser = window._adminId; });
    await stubs('');
    const r = await t.eval(async ids => { await softDeleteRecord('DST', ids.task2); return !!DB.tasks.find(x => x.id === ids.task2).deletedAt; }, ids);
    if(!r) throw new Error('the administrator\'s delete did not happen');
    return 'deleted at once';
  });
});
