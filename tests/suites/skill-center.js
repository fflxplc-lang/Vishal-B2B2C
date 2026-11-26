/* SKILL DEVELOPMENT CENTER (public/skill-center.js).

   The library opens with the firm's sample courses; search, category,
   difficulty and status filters and the grid / list toggle all narrow it;
   a course opens to its overview and lesson player, with the syllabus as an
   accordion, lessons that unlock in order, a quiz that completes its lesson,
   and progress that is saved; + Add Course walks Basic info → Curriculum →
   Preview & Publish with a live card; Duplicate and Delete do what they say;
   a partner learns from published courses only and keeps their own progress. */
const http = require('http');
const {suite, PORT} = require('../lib/harness');

function req(method, path, opts){
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = {Host: 'localhost:' + PORT};
    let body = null;
    if(opts.json !== undefined){ body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    if(opts.form){ body = new URLSearchParams(opts.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if(opts.cookie) headers.Cookie = opts.cookie;
    if(body !== null) headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({host: '127.0.0.1', port: PORT, method, path, headers}, res => {
      let data = ''; res.on('data', d => data += d);
      res.on('end', () => {
        const set = [].concat(res.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('finowise_session='));
        let json = null; try { json = JSON.parse(data); } catch(e) {}
        resolve({status: res.statusCode, json, text: data, cookie: set || opts.cookie || ''});
      });
    });
    r.on('error', reject);
    if(body !== null) r.write(body);
    r.end();
  });
}

suite(async t => {
  await t.step('the library opens with the sample courses, one of them a full multi-module course', async () => {
    const r = await t.eval(async () => {
      navigate('skills'); await new Promise(r => setTimeout(r, 200));
      const cards = [...document.querySelectorAll('.sdc-card')];
      const fp = sdcCourses().find(c => c.title === 'Financial Planning Foundations');
      return {title: (document.querySelector('.sdc-head h1') || {}).textContent, cards: cards.length,
        published: sdcCourses().filter(c => c.status === 'Published').length, drafts: sdcCourses().filter(c => c.status === 'Draft').length,
        fp: fp && sdcMetaText(fp), add: !!document.querySelector('.sdc-head .sdc-btn.primary'),
        meta: (document.querySelector('.sdc-card .sdc-meta') || {}).textContent || ''};
    });
    if(r.title !== 'Skill Development Center') throw new Error('heading: ' + r.title);
    if(r.cards !== 6 || r.published !== 5 || r.drafts !== 1) throw new Error(JSON.stringify(r));
    if(!/^3 Modules • 10 Lessons • 1h 47m$/.test(r.fp)) throw new Error('detailed course: ' + r.fp);
    if(!r.add || !/Modules • \d+ Lessons •/.test(r.meta)) throw new Error(JSON.stringify(r));
    return r.cards + ' cards (5 published + a draft the admin sees); ' + r.fp;
  });

  await t.step('search by title, tag and instructor; category, level and status filters; grid and list', async () => {
    const r = await t.eval(async () => {
      const n = () => document.querySelectorAll('#sdcResults .sdc-card, #sdcResults .sdc-list-row').length;
      const out = {};
      const box = document.getElementById('sdcSearch');
      box.focus(); box.value = 'SEBI'; box.dispatchEvent(new Event('input', {bubbles: true}));
      out.byTitle = n(); out.focusKept = document.activeElement === box;
      box.value = 'pipeline'; box.dispatchEvent(new Event('input', {bubbles: true})); out.byTag = n();
      box.value = 'ananya'; box.dispatchEvent(new Event('input', {bubbles: true})); out.byInstructor = n();
      box.value = 'zzz nothing'; box.dispatchEvent(new Event('input', {bubbles: true})); out.empty = !!document.querySelector('#sdcResults .sdc-empty');
      sdcClearFilters();
      sdcSet('cat', 'Technical'); out.technical = n();
      sdcSet('cat', 'All'); sdcSet('level', 'Advanced'); out.advanced = n();
      sdcSet('level', ''); sdcSet('status', 'Draft'); out.draft = n();
      sdcSet('status', 'All'); sdcSet('layout', 'list'); out.rows = document.querySelectorAll('.sdc-list-row').length;
      sdcSet('layout', 'grid');
      return out;
    });
    const want = {byTitle: 1, focusKept: true, byTag: 1, byInstructor: 1, empty: true, technical: 2, advanced: 2, draft: 1, rows: 6};
    if(JSON.stringify(r) !== JSON.stringify(want)) throw new Error(JSON.stringify(r));
    return 'search keeps focus; title/tag/instructor 1 each; Technical 2, Advanced 2, Draft 1; list shows 6 rows';
  });

  await t.step('a course opens to its banner, lesson player and syllabus; modules fold; lessons unlock in order', async () => {
    const r = await t.eval(async () => {
      const c = sdcCourses().find(x => x.title === 'Financial Planning Foundations');
      sdcOpen(c.id); await new Promise(r => setTimeout(r, 100));
      const out = {crumbs: (document.querySelector('.sdc-crumbs') || {}).textContent.replace(/\s*›\s*/g, ' › ').replace(/\s+/g, ' ').trim(),
        hero: (document.querySelector('.sdc-hero h1') || {}).textContent, cta: [...document.querySelectorAll('.sdc-hero .sdc-btn')].map(b => b.textContent.trim())[0],
        lesson: (document.querySelector('.sdc-viewer-head h2') || {}).textContent, type: (document.querySelector('.sdc-viewer-head .sdc-type') || {}).textContent.trim(),
        openMods: document.querySelectorAll('.sdc-mod.open').length, locked: document.querySelectorAll('.sdc-les.locked').length,
        takeaways: !!document.querySelector('.sdc-callout'), media: !!document.querySelector('.sdc-media'), resources: document.querySelectorAll('.sdc-res').length};
      const m2 = c.modules[1].id;
      sdcToggleModule(m2); out.afterOpen = document.querySelectorAll('.sdc-mod.open').length;
      sdcToggleModule(m2); out.afterClose = document.querySelectorAll('.sdc-mod.open').length;
      // As a learner (not a course manager), a locked lesson stays shut.
      const was = window.CRM_IS_ADMIN; const team = DB.team; const me0 = me();
      out.learnerLocked = sdcLocked(c, c.modules[0].lessons[1].id);
      return out;
    });
    if(r.crumbs !== 'Skill Development Center › Technical › Financial Planning Foundations') throw new Error('crumbs: ' + r.crumbs);
    if(r.hero !== 'Financial Planning Foundations' || !/Start Course|Continue Learning/.test(r.cta)) throw new Error(JSON.stringify(r));
    if(r.lesson !== 'Why goal-based planning works' || !/Video/.test(r.type)) throw new Error(JSON.stringify(r));
    if(r.openMods !== 1 || r.afterOpen !== 2 || r.afterClose !== 1) throw new Error('accordion ' + JSON.stringify(r));
    if(r.locked < 2 || !r.learnerLocked) throw new Error('locking ' + JSON.stringify(r));
    if(!r.takeaways || !r.media || r.resources < 2) throw new Error('lesson content ' + JSON.stringify(r));
    return 'banner, breadcrumb, video + notes + takeaways + resources; accordion folds; ' + r.locked + ' lessons locked';
  });

  await t.step('Mark as Complete saves progress, unlocks the next lesson, and Next moves on', async () => {
    const r = await t.eval(async () => {
      const S = sdcState(), c = sdcCourse(S.courseId), first = c.modules[0].lessons[0], second = c.modules[0].lessons[1];
      await sdcToggleDone(first.id);
      const stored = (await sget('sdcProgress', [])).find(p => p.courseId === c.id && p.userId === currentUser);
      const out = {pct: sdcPct(c), unlocked: !sdcLocked(c, second.id), stored: !!(stored && stored.done && stored.done[first.id]),
        btn: (document.querySelector('.sdc-done-btn') || {}).textContent.trim(), ring: (document.querySelector('.sdc-mod.open .sdc-mod-ring text') || {}).textContent};
      document.querySelector('.sdc-viewer-foot .sdc-btn.primary').click();
      out.now = sdcState().lessonId === second.id;
      await sdcToggleDone(first.id); out.undo = sdcPct(c);
      await sdcToggleDone(first.id);
      return out;
    });
    if(r.pct !== 10 || !r.unlocked || !r.stored || r.btn !== '✓ Completed' || r.ring !== '33%' || !r.now || r.undo !== 0) throw new Error(JSON.stringify(r));
    return '10% after one of ten, saved on the server, next lesson unlocked; Next moves on; toggling back undoes it';
  });

  await t.step('a quiz checks answers, explains, and passing completes the lesson', async () => {
    const r = await t.eval(async () => {
      const S = sdcState(), c = sdcCourse(S.courseId);
      const q = c.modules[0].lessons[2];
      await sdcToggleDone(c.modules[0].lessons[1].id);
      sdcGo(q.id);
      sdcQuizPick(q.id, 0, 0); sdcQuizPick(q.id, 1, 0); sdcQuizPick(q.id, 2, 2);
      await sdcQuizCheck(q.id);
      const fail = (document.querySelector('.sdc-score') || {}).textContent || '';
      const wrongShown = document.querySelectorAll('.sdc-opt.wrong').length;
      sdcQuizReset(q.id);
      q.quiz.forEach((x, i) => sdcQuizPick(q.id, i, x.answer));
      await sdcQuizCheck(q.id);
      return {fail, wrongShown, pass: (document.querySelector('.sdc-score') || {}).textContent || '', done: sdcIsDone(c, q.id), pct: sdcPct(c)};
    });
    if(!/2 of 3 correct/.test(r.fail) || r.wrongShown !== 1 || !/All 3 correct/.test(r.pass) || !r.done || r.pct !== 30) throw new Error(JSON.stringify(r));
    return '2/3 shows the wrong answer and explanations; 3/3 completes the lesson (30%)';
  });

  await t.step('+ Add Course: Basic info → Curriculum → Preview & Publish, with a live card', async () => {
    const r = await t.eval(async () => {
      sdcHome(); sdcNewCourse();
      const out = {step1: !!document.querySelector('.sdc-step.on') && document.querySelector('.sdc-step.on').textContent.includes('Basic Info')};
      sdcStepTo(2); out.blocked = sdcState().step;          // no title yet
      sdcDraftSet('title', 'ZZ Onboarding for New RMs');
      out.live = (document.querySelector('#sdcLivePreview .sdc-title') || {}).textContent;
      sdcDraftSet('description', 'ZZ What a new RM needs in their first fortnight.');
      sdcDraftSet('category', 'Communication'); sdcDraftSet('level', 'Intermediate'); sdcDraftSet('instructor.name', 'ZZ Trainer');
      sdcDraftSet('color', '#BE185D', true); sdcDraftSet('icon', '🚀', true);
      sdcStepTo(2);
      sdcLesSet(0, 0, 'title', 'ZZ Welcome'); sdcLesSet(0, 0, 'minutes', 5);
      sdcAddLesson(0); sdcLesSet(0, 1, 'title', 'ZZ Tools tour'); sdcLesSet(0, 1, 'type', 'Article', true); sdcLesSet(0, 1, 'minutes', 15);
      sdcAddModule(); sdcModSet(1, 'ZZ First week'); sdcLesSet(1, 0, 'title', 'ZZ Shadow a call'); sdcLesSet(1, 0, 'minutes', 30);
      sdcLesSet(1, 0, 'takeaways', 'Listen first\nAsk one question');
      sdcMoveLesson(0, 1, -1); out.moved = window._sdcDraft.modules[0].lessons[0].title;
      sdcStepTo(3);
      out.checks = document.querySelectorAll('.sdc-check li:not(.no)').length;
      out.preview = (document.querySelector('#sdcLivePreview .sdc-meta') || {}).textContent;
      await sdcSaveCourse('Published');
      const c = sdcCourses().find(x => x.title === 'ZZ Onboarding for New RMs');
      const stored = ((await sget('sdcCourses', [])) || []).find(x => x.title === 'ZZ Onboarding for New RMs');
      out.saved = !!(c && stored && stored.status === 'Published');
      out.opened = sdcState().mode === 'course' && sdcState().courseId === (c && c.id);
      out.takeaways = c && c.modules[1].lessons[0].takeaways.length;
      return out;
    });
    if(!r.step1 || r.blocked !== 1 || r.live !== 'ZZ Onboarding for New RMs') throw new Error(JSON.stringify(r));
    if(r.moved !== 'ZZ Tools tour' || r.checks !== 5 || r.preview !== '2 Modules • 3 Lessons • 50m') throw new Error(JSON.stringify(r));
    if(!r.saved || !r.opened || r.takeaways !== 2) throw new Error(JSON.stringify(r));
    return 'title required to move on; live card follows typing; reorder works; published and opened (' + r.preview + ')';
  });

  await t.step('Duplicate makes a draft copy; Delete takes a course out of the library', async () => {
    const r = await t.eval(async () => {
      window.confirm = () => true;
      const c = sdcCourses().find(x => x.title === 'ZZ Onboarding for New RMs');
      await sdcDuplicate(c.id);
      const copy = sdcCourses().find(x => x.title === 'ZZ Onboarding for New RMs (Copy)');
      const sameIds = copy && copy.modules[0].lessons[0].id === c.modules[0].lessons[0].id;
      await sdcDelete(copy.id);
      const stored = ((await sget('sdcCourses', [])) || []).find(x => x.id === copy.id);
      return {copyDraft: copy && copy.status, sameIds, gone: !sdcCourse(copy.id), keptDeleted: !!(stored && stored.deletedAt)};
    });
    if(r.copyDraft !== 'Draft' || r.sameIds || !r.gone || !r.keptDeleted) throw new Error(JSON.stringify(r));
    return 'copy is a Draft with its own ids; delete hides it (kept with deletedAt)';
  });

  await t.step('a partner learns from published courses only, keeps their own progress, and cannot change the library', async () => {
    const admin = (await req('POST', '/login', {form: {email: 'test@finowise.test', password: 'testpassword1'}})).cookie;
    const team = JSON.parse((await req('GET', '/api/storage/team', {cookie: admin})).json.value);
    team.push({id: 'ZP1', name: 'ZZ Learner Partner', email: 'zlp@zz.test', partnerPobId: 'ZPOB-1', partnerLevel: 'L1', scope: 'own', status: 'Active'});
    let r = await req('PUT', '/api/storage/team', {cookie: admin, json: {value: JSON.stringify(team)}});
    if(r.status !== 200) throw new Error('team ' + r.text);
    const a = await req('POST', '/api/users/sync', {cookie: admin, json: {memberId: 'ZP1', email: 'zlp@zz.test'}});
    const s = await req('POST', '/login', {form: {email: 'zlp@zz.test', password: a.json.password}});
    const c = await req('POST', '/api/account/password', {cookie: s.cookie, json: {current: a.json.password, password: 'Zz!learner-1', confirm: 'Zz!learner-1'}});
    const p = c.cookie;
    const courses = JSON.parse((await req('GET', '/api/storage/sdcCourses', {cookie: p})).json.value);
    const progAdmin = JSON.parse((await req('GET', '/api/storage/sdcProgress', {cookie: admin})).json.value);
    const progPartner = JSON.parse((await req('GET', '/api/storage/sdcProgress', {cookie: p})).json.value);
    const write = await req('PUT', '/api/storage/sdcCourses', {cookie: p, json: {value: '[]'}});
    const mine = await req('PUT', '/api/storage/sdcProgress', {cookie: p, json: {patch: {kind: 'rows', adds: [{id: 'ZP1|x', userId: 'ZP1', courseId: 'x', done: {}}]}}});
    const notMine = await req('PUT', '/api/storage/sdcProgress', {cookie: p, json: {patch: {kind: 'rows', changes: [{id: progAdmin[0].id, set: {done: {}}}]}}});
    if(!courses.length || progAdmin.length < 1 || progPartner.length !== 0) throw new Error(JSON.stringify({courses: courses.length, progAdmin: progAdmin.length, progPartner: progPartner.length}));
    if(write.status !== 403 || mine.status !== 200 || notMine.status !== 403) throw new Error(JSON.stringify({write: write.status, mine: mine.status, notMine: notMine.status}));
    // The partner's page draws the library with published courses only and no Add Course.
    const ctx = await t.page.context().browser().newContext();
    const pg = await ctx.newPage();
    await pg.goto(t.base + '/login', {waitUntil: 'domcontentloaded'});
    await pg.fill('#email', 'zlp@zz.test'); await pg.fill('#password', 'Zz!learner-1');
    await Promise.all([pg.waitForNavigation({waitUntil: 'domcontentloaded'}), pg.click('button[type=submit]')]);
    await require('../lib/ready')(pg);
    const v = await pg.evaluate(async () => { navigate('skills'); await new Promise(r => setTimeout(r, 200));
      return {open: pageOpenToMe('skills'), cards: document.querySelectorAll('.sdc-card').length, drafts: document.querySelectorAll('.sdc-chip.draft').length,
        add: !!document.querySelector('.sdc-head .sdc-btn.primary')}; });
    await ctx.close();
    if(!v.open || v.cards !== 6 || v.drafts !== 0 || v.add) throw new Error('partner page: ' + JSON.stringify(v));
    return 'courses readable, others’ progress not; library write refused, own progress saved, another’s refused; page shows 6 published, no drafts, no Add Course';
  });
});
