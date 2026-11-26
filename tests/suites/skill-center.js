/* SKILL DEVELOPMENT CENTER (public/skill-center.js, skill-center-server.js).

   Video-first courses with admin-controlled access:
   · the library opens with the sample courses — and no quizzes anywhere;
   · search, category, difficulty and status filters, grid and list;
   · a course opens to its banner, the HTML5 player and the playlist; the
     accordion folds; lessons unlock in order; Mark as Complete saves;
   · a video recorded in the browser is uploaded straight into a lesson from
     the builder (with its length and a thumbnail taken from the file),
     served back with byte ranges, plays in the page's own <video>, and
     completes the lesson when it reaches the end;
   · per-course access: everyone / employees / partners / specific people,
     set from the builder and from ⋯ › Manage Access, and enforced by the
     server for the library and for the video files;
   · Duplicate and Delete; a partner's page sees only what was given to it. */
const http = require('http');
const {suite, PORT} = require('../lib/harness');

function req(method, path, opts){
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({Host: 'localhost:' + PORT}, opts.headers || {});
    let body = null;
    if(opts.json !== undefined){ body = JSON.stringify(opts.json); headers['Content-Type'] = 'application/json'; }
    if(opts.form){ body = new URLSearchParams(opts.form).toString(); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
    if(opts.raw){ body = opts.raw; }
    if(opts.cookie) headers.Cookie = opts.cookie;
    if(body !== null) headers['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({host: '127.0.0.1', port: PORT, method, path, headers}, res => {
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks), data = buf.toString();
        const set = [].concat(res.headers['set-cookie'] || []).map(c => c.split(';')[0]).find(c => c.startsWith('finowise_session='));
        let json = null; try { json = JSON.parse(data); } catch(e) {}
        resolve({status: res.statusCode, headers: res.headers, json, text: data, bytes: buf.length, cookie: set || opts.cookie || ''});
      });
    });
    r.on('error', reject);
    if(body !== null) r.write(body);
    r.end();
  });
}
async function signInAs(admin, member){
  const a = await req('POST', '/api/users/sync', {cookie: admin, json: {memberId: member.id, email: member.email}});
  if(!a.json || !a.json.ok) throw new Error('account for ' + member.id + ': ' + a.text);
  const s = await req('POST', '/login', {form: {email: member.email, password: a.json.password}});
  const pw = 'Zz!learner-' + member.id;
  const c = await req('POST', '/api/account/password', {cookie: s.cookie, json: {current: a.json.password, password: pw, confirm: pw}});
  return {cookie: c.cookie, password: pw};
}
const titles = v => (Array.isArray(v) ? v.map(c => c.title).sort() : []);

suite(async t => {
  const ids = {};

  await t.step('the library opens with the sample video courses — and no quizzes anywhere', async () => {
    const r = await t.eval(async () => {
      navigate('skills'); await new Promise(r => setTimeout(r, 200));
      const all = sdcCourses();
      const fp = all.find(c => c.title === 'Financial Planning Foundations');
      const lessons = all.flatMap(c => sdcLessons(c).map(x => x.l));
      return {title: (document.querySelector('.sdc-head h1') || {}).textContent, cards: document.querySelectorAll('.sdc-card').length,
        published: all.filter(c => c.status === 'Published').length, drafts: all.filter(c => c.status === 'Draft').length,
        fp: fp && sdcMetaText(fp), types: Object.keys(SDC_TYPES).join(','), quizLessons: lessons.filter(l => l.type === 'Quiz' || l.quiz).length,
        quizFns: ['sdcQuizHtml', 'sdcQuizCheck', 'sdcQuizPick'].filter(f => typeof window[f] === 'function').length,
        videos: lessons.filter(l => l.type === 'Video').length, accessChips: document.querySelectorAll('.sdc-card .sdc-chip.dark').length,
        playMarks: document.querySelectorAll('.sdc-card .sdc-cover-len').length};
    });
    if(r.title !== 'Skill Development Center' || r.cards !== 6 || r.published !== 5 || r.drafts !== 1) throw new Error(JSON.stringify(r));
    if(r.types !== 'Video,Article,Resource' || r.quizLessons || r.quizFns) throw new Error('quizzes remain: ' + JSON.stringify(r));
    if(!/^3 Modules • 10 Lessons • /.test(r.fp) || r.videos < 20 || r.accessChips !== 6 || r.playMarks !== 6) throw new Error(JSON.stringify(r));
    return r.cards + ' cards, ' + r.videos + ' video lessons, types ' + r.types + '; every card shows who can open it';
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
    return 'search keeps focus; Technical 2, Advanced 2, Draft 1; list shows 6 rows';
  });

  await t.step('a course opens to its banner, player and playlist; modules fold; lessons unlock in order; Mark as Complete saves', async () => {
    const r = await t.eval(async () => {
      const c = sdcCourses().find(x => x.title === 'Financial Planning Foundations');
      sdcOpen(c.id); await new Promise(r => setTimeout(r, 100));
      const out = {crumbs: (document.querySelector('.sdc-crumbs') || {}).textContent.replace(/\s*›\s*/g, ' › ').replace(/\s+/g, ' ').trim(),
        lesson: (document.querySelector('.sdc-viewer-head h2') || {}).textContent,
        player: !!document.querySelector('.sdc-player'), placeholder: !!document.querySelector('.sdc-player.empty'),
        thumbs: document.querySelectorAll('.sdc-mod.open .sdc-lthumb').length, now: !!document.querySelector('.sdc-les.active .now'),
        locked: document.querySelectorAll('.sdc-les.locked').length, openMods: document.querySelectorAll('.sdc-mod.open').length};
      const m2 = c.modules[1].id;
      sdcToggleModule(m2); out.afterOpen = document.querySelectorAll('.sdc-mod.open').length;
      sdcToggleModule(m2); out.afterClose = document.querySelectorAll('.sdc-mod.open').length;
      const first = c.modules[0].lessons[0], second = c.modules[0].lessons[1];
      await sdcToggleDone(first.id);
      const stored = (await sget('sdcProgress', [])).find(p => p.courseId === c.id && p.userId === currentUser);
      out.pct = sdcPct(c); out.unlocked = !sdcLocked(c, second.id); out.stored = !!(stored && stored.done[first.id]);
      document.querySelector('.sdc-viewer-foot .sdc-btn.primary').click();
      out.next = sdcState().lessonId === second.id;
      await sdcToggleDone(first.id);
      return out;
    });
    if(r.crumbs !== 'Skill Development Center › Technical › Financial Planning Foundations') throw new Error('crumbs: ' + r.crumbs);
    if(r.lesson !== 'Why goal-based planning works' || !r.player || !r.placeholder || r.thumbs !== 3 || !r.now) throw new Error(JSON.stringify(r));
    if(r.locked < 2 || r.openMods !== 1 || r.afterOpen !== 2 || r.afterClose !== 1) throw new Error(JSON.stringify(r));
    if(r.pct !== 10 || !r.unlocked || !r.stored || !r.next) throw new Error(JSON.stringify(r));
    return '"Video coming soon" until uploaded; playlist thumbnails and Now playing; accordion folds; complete → 10%, next unlocked';
  });

  await t.step('a video is uploaded straight into a lesson from the builder, with its length and a thumbnail', async () => {
    const r = await t.eval(async () => {
      // A real two-second WEBM, recorded here from a canvas.
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      const g = cv.getContext('2d'); let f = 0;
      const timer = setInterval(() => { g.fillStyle = 'hsl(' + (f * 9 % 360) + ',70%,45%)'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#fff'; g.font = '40px sans-serif'; g.fillText('ZZ ' + f++, 90, 105); }, 40);
      const rec = new MediaRecorder(cv.captureStream(25), {mimeType: 'video/webm;codecs=vp8'});
      const parts = []; rec.ondataavailable = e => parts.push(e.data);
      const stopped = new Promise(r => rec.onstop = r);
      rec.start(); await new Promise(r => setTimeout(r, 2200)); rec.stop(); await stopped; clearInterval(timer);
      const file = new File(parts, 'zz-intro-clip.webm', {type: 'video/webm'});
      sdcHome(); sdcNewCourse();
      sdcDraftSet('title', 'ZZ Video Course'); sdcDraftSet('description', 'ZZ A course built around one uploaded video.');
      sdcStepTo(2);
      sdcLesSet(0, 0, 'title', '');
      sdcExpand(window._sdcDraft.modules[0].lessons[0].id);
      const typeOptions = [...document.querySelectorAll('.sdc-blesson-row select option')].map(o => o.value);
      const hasDrop = !!document.querySelector('.sdc-drop input[type=file]');
      const up = await sdcAttachVideo(0, 0, file);
      const l = window._sdcDraft.modules[0].lessons[0];
      return {typeOptions, hasDrop, uploaded: !!up, videoId: l.videoId, posterId: l.posterId, seconds: l.videoSeconds, minutes: l.minutes,
        title: l.title, size: l.videoSize, editor: (document.querySelector('.sdc-vup.has .who b') || {}).textContent || ''};
    });
    if(r.typeOptions.indexOf('Quiz') >= 0 || r.typeOptions.join() !== 'Video,Article,Resource' || !r.hasDrop) throw new Error('builder: ' + JSON.stringify(r));
    if(!r.uploaded || !/^SDM-[0-9a-f]{32}$/.test(r.videoId) || !/^SDM-/.test(r.posterId)) throw new Error('upload: ' + JSON.stringify(r));
    if(!(r.seconds >= 2 && r.seconds <= 3) || r.minutes !== 1 || r.title !== 'zz intro clip' || r.editor !== 'zz-intro-clip.webm') throw new Error(JSON.stringify(r));
    ids.videoId = r.videoId; ids.posterId = r.posterId;
    return 'no Quiz type; ' + Math.round(r.size / 1024) + ' KB WEBM uploaded, ' + r.seconds + 's read from the file, thumbnail made from a frame';
  });

  await t.step('the file is served back with byte ranges; only managers may upload, and only real video or images', async () => {
    const admin = (await req('POST', '/login', {form: {email: 'test@finowise.test', password: 'testpassword1'}})).cookie;
    ids.admin = admin;
    const whole = await req('GET', '/api/sdc/media/' + ids.videoId, {cookie: admin});
    const part = await req('GET', '/api/sdc/media/' + ids.videoId, {cookie: admin, headers: {Range: 'bytes=0-99'}});
    const poster = await req('GET', '/api/sdc/media/' + ids.posterId, {cookie: admin});
    const wrongType = await req('POST', '/api/sdc/media?kind=video', {cookie: admin, raw: 'not a video', headers: {'Content-Type': 'text/plain'}});
    const anon = await req('GET', '/api/sdc/media/' + ids.videoId);
    if(whole.status !== 200 || whole.headers['content-type'] !== 'video/webm' || whole.headers['accept-ranges'] !== 'bytes') throw new Error('whole ' + JSON.stringify(whole.headers));
    if(part.status !== 206 || part.bytes !== 100 || !/^bytes 0-99\//.test(part.headers['content-range'] || '')) throw new Error('range ' + part.status + ' ' + part.headers['content-range']);
    if(poster.status !== 200 || poster.headers['content-type'] !== 'image/jpeg') throw new Error('poster ' + poster.status);
    if(wrongType.status !== 415 || anon.status !== 401) throw new Error(JSON.stringify({wrongType: wrongType.status, anon: anon.status}));
    return 'video/webm with Accept-Ranges; 206 for a range; JPEG thumbnail; text refused (415); signed-out refused (401)';
  });

  await t.step('the course is published to specific people and plays in the page’s own player, completing at the end', async () => {
    const r = await t.eval(async () => {
      DB.team.push({id: 'ZE1', name: 'ZZ Employee One', email: 'ze1@zz.test', role: 'Relationship Manager', scope: 'own', status: 'Active', perms: {}},
                   {id: 'ZE2', name: 'ZZ Employee Two', email: 'ze2@zz.test', role: 'Relationship Manager', scope: 'own', status: 'Active', perms: {}},
                   {id: 'ZP1', name: 'ZZ Partner One', email: 'zp1@zz.test', partnerPobId: 'ZPOB-1', partnerLevel: 'L1', scope: 'own', status: 'Active'});
      await save('team');
      sdcStepTo(3);
      const steps = [...document.querySelectorAll('.sdc-step')].map(b => b.textContent.replace(/^\s*[\d✓]\s*/, '').trim());
      const modes = [...document.querySelectorAll('.sdc-acc-mode input')].map(i => i.value);
      sdcAccMode('selected');
      const blocked = sdcPublishProblems(window._sdcDraft).join('|');
      sdcAccSearch('ZZ Employee One');
      const shown = document.querySelectorAll('#sdcAccList .sdc-acc-person').length;
      document.querySelector('#sdcAccList input[value="ZE1"]').click();
      sdcAccToggle(currentUser, true);
      await sdcSaveCourse('Published');
      const c = sdcCourses().find(x => x.title === 'ZZ Video Course');
      // Let the redraw that follows a save land before taking hold of the player.
      await new Promise(r => setTimeout(r, 900));
      const v = document.getElementById('sdcVideo');
      const meta = await new Promise(res => { if(v.readyState >= 1) return res(true); v.addEventListener('loadedmetadata', () => res(true), {once: true}); setTimeout(() => res(false), 8000); });
      const poster = v.getAttribute('poster') || '';
      v.muted = true;
      // A browser-recorded WEBM has no length in its header: the player ends it at the length measured on upload.
      const ended = new Promise(res => { const ok = () => res(true); v.addEventListener('ended', ok, {once: true}); v.addEventListener('sdcend', ok, {once: true}); setTimeout(() => res(false), 15000); });
      await v.play();
      const playing = document.getElementById('sdcPlayer').classList.contains('playing');
      await save('sdcProgress'); await new Promise(r => setTimeout(r, 300));
      const survived = document.getElementById('sdcVideo') === v && !v.paused;
      const finished = await ended;
      await new Promise(r => setTimeout(r, 400));
      const lid = c.modules[0].lessons[0].id;
      const stored = (await sget('sdcProgress', [])).find(p => p.courseId === c.id && p.userId === currentUser);
      return {steps, modes, blocked, shown, access: c.access, status: c.status, id: c.id, src: v.getAttribute('src'), poster, meta, playing, survived, finished,
        overlay: !document.getElementById('sdcEnded').hidden, done: sdcIsDone(c, lid), stored: !!(stored && stored.done[lid]),
        btn: (document.querySelector('.sdc-done-btn') || {}).textContent, playlistDone: !!document.querySelector('.sdc-les.is-done .sdc-lmark.done')};
    });
    if(r.steps.join('|') !== 'Basic Info|Curriculum|Access & Publish' || r.modes.join() !== 'all,employees,partners,selected') throw new Error(JSON.stringify(r));
    if(!/person to give it to/.test(r.blocked) || r.shown !== 1) throw new Error('picker: ' + JSON.stringify(r));
    if(r.status !== 'Published' || r.access.mode !== 'selected' || r.access.users.indexOf('ZE1') < 0) throw new Error('saved: ' + JSON.stringify(r));
    if(r.src !== '/api/sdc/media/' + ids.videoId || r.poster !== '/api/sdc/media/' + ids.posterId || !r.meta || !r.playing || !r.survived) throw new Error('player: ' + JSON.stringify(r));
    if(!r.finished || !r.overlay || !r.done || !r.stored || !/Completed/.test(r.btn) || !r.playlistDone) throw new Error('completion: ' + JSON.stringify(r));
    ids.course = r.id;
    return 'Access & Publish step; given to ZZ Employee One; plays with its thumbnail, ends, completes itself and offers Replay';
  });

  await t.step('Manage Access from ⋯ changes who can open a course', async () => {
    const r = await t.eval(async () => {
      sdcHome();
      const c = sdcCourses().find(x => x.title === 'Consultative Client Conversations');
      const card = [...document.querySelectorAll('.sdc-card')].find(e => e.textContent.includes('Consultative Client Conversations'));
      const items = [...card.querySelectorAll('.sdc-menu-list button')].map(b => b.textContent.trim().replace(/^\S+\s/, ''));
      sdcManageAccess(c.id);
      const modal = !!document.querySelector('#modalBody .sdc-acc-modes');
      sdcAccMode('partners');
      await sdcSaveAccess(c.id);
      const conv = sdcCourses().find(x => x.title === 'Consultative Client Conversations');
      const lead = sdcCourses().find(x => x.title === 'Leading High-Performance Advisory Teams');
      sdcManageAccess(lead.id); sdcAccMode('employees'); await sdcSaveAccess(lead.id);
      const chip = [...document.querySelectorAll('.sdc-card')].find(e => e.textContent.includes('Consultative Client Conversations')).querySelector('.sdc-chip.dark').textContent.trim();
      return {items, modal, conv: conv.access.mode, lead: sdcAccessOf(sdcCourses().find(x => x.title === 'Leading High-Performance Advisory Teams')).mode, chip};
    });
    if(r.items.join('|') !== 'Edit|Manage Access|Preview|Duplicate|Delete' || !r.modal) throw new Error(JSON.stringify(r));
    if(r.conv !== 'partners' || r.lead !== 'employees' || r.chip !== 'Partners only') throw new Error(JSON.stringify(r));
    return 'menu has Manage Access; Conversations → Partners only, Leadership → Employees only';
  });

  await t.step('the server sends each person only the courses given to them, and guards the video files the same way', async () => {
    const admin = ids.admin;
    const e1 = await signInAs(admin, {id: 'ZE1', email: 'ze1@zz.test'});
    const e2 = await signInAs(admin, {id: 'ZE2', email: 'ze2@zz.test'});
    const p1 = await signInAs(admin, {id: 'ZP1', email: 'zp1@zz.test'});
    const lib = async who => titles(JSON.parse((await req('GET', '/api/storage/sdcCourses', {cookie: who.cookie || who})).json.value));
    const everyone = ['Designing Client-Ready Reports', 'Financial Planning Foundations', 'SEBI & AMFI Compliance Essentials'];
    const want = {
      e1: everyone.concat(['Leading High-Performance Advisory Teams', 'ZZ Video Course']).sort(),
      e2: everyone.concat(['Leading High-Performance Advisory Teams']).sort(),
      p1: everyone.concat(['Consultative Client Conversations']).sort(),
    };
    const got = {e1: await lib(e1), e2: await lib(e2), p1: await lib(p1)};
    if(JSON.stringify(got) !== JSON.stringify(want)) throw new Error(JSON.stringify(got));
    const all = await lib(admin);
    if(all.length !== 7 || all.indexOf('Mutual Fund Product Deep Dive') < 0) throw new Error('admin sees ' + all.length);
    // Who else was given a course is not handed to learners.
    const seenByE1 = JSON.parse((await req('GET', '/api/storage/sdcCourses', {cookie: e1.cookie})).json.value).find(c => c.title === 'ZZ Video Course');
    if(seenByE1.access.users) throw new Error('the people list reached a learner');
    const media = {e1: (await req('GET', '/api/sdc/media/' + ids.videoId, {cookie: e1.cookie, headers: {Range: 'bytes=0-9'}})).status,
      e2: (await req('GET', '/api/sdc/media/' + ids.videoId, {cookie: e2.cookie})).status,
      p1: (await req('GET', '/api/sdc/media/' + ids.posterId, {cookie: p1.cookie})).status};
    if(media.e1 !== 206 || media.e2 !== 403 || media.p1 !== 403) throw new Error('media ' + JSON.stringify(media));
    const writes = {e1: (await req('PUT', '/api/storage/sdcCourses', {cookie: e1.cookie, json: {value: '[]'}})).status,
      upload: (await req('POST', '/api/sdc/media?kind=video', {cookie: e1.cookie, raw: Buffer.from('x'), headers: {'Content-Type': 'video/webm'}})).status,
      ownProgress: (await req('PUT', '/api/storage/sdcProgress', {cookie: p1.cookie, json: {patch: {kind: 'rows', adds: [{id: 'ZP1|x', userId: 'ZP1', courseId: 'x', done: {}}]}}})).status};
    if(writes.e1 !== 403 || writes.upload !== 403 || writes.ownProgress !== 200) throw new Error('writes ' + JSON.stringify(writes));
    ids.p1 = p1;
    return 'E1 5, E2 4, partner 4 (each their own set), admin all 7; video 206 for E1, 403 for E2 and the partner; learners cannot save or upload';
  });

  await t.step('Duplicate makes a draft copy; Delete takes a course out of the library', async () => {
    const r = await t.eval(async () => {
      window.confirm = () => true;
      const c = sdcCourses().find(x => x.title === 'ZZ Video Course');
      await sdcDuplicate(c.id);
      const copy = sdcCourses().find(x => x.title === 'ZZ Video Course (Copy)');
      const sharesVideo = copy && copy.modules[0].lessons[0].videoId === c.modules[0].lessons[0].videoId;
      const ownIds = copy && copy.modules[0].lessons[0].id !== c.modules[0].lessons[0].id;
      await sdcDelete(copy.id);
      return {copyDraft: copy && copy.status, sharesVideo, ownIds, gone: !sdcCourse(copy.id)};
    });
    if(r.copyDraft !== 'Draft' || !r.sharesVideo || !r.ownIds || !r.gone) throw new Error(JSON.stringify(r));
    return 'copy is a Draft sharing the uploaded video with ids of its own; delete hides it';
  });

  await t.step('a partner’s page shows only the courses given to it, with no Add Course and no access controls', async () => {
    const ctx = await t.page.context().browser().newContext();
    const pg = await ctx.newPage();
    await pg.goto(t.base + '/login', {waitUntil: 'domcontentloaded'});
    await pg.fill('#email', 'zp1@zz.test'); await pg.fill('#password', ids.p1.password);
    await Promise.all([pg.waitForNavigation({waitUntil: 'domcontentloaded'}), pg.click('button[type=submit]')]);
    await require('../lib/ready')(pg);
    const v = await pg.evaluate(async (vid) => { navigate('skills'); await new Promise(r => setTimeout(r, 200));
      return {open: pageOpenToMe('skills'), cards: [...document.querySelectorAll('.sdc-card .sdc-title')].map(e => e.textContent).sort(),
        drafts: document.querySelectorAll('.sdc-chip.draft').length, add: !!document.querySelector('.sdc-head .sdc-btn.primary'),
        accessChips: document.querySelectorAll('.sdc-card .sdc-chip.dark').length,
        menu: [...document.querySelectorAll('.sdc-menu-list button')].map(b => b.textContent.trim().replace(/^\S+\s/, '')).filter((x, i, a) => a.indexOf(x) === i),
        sub: (document.querySelector('.sdc-head p') || {}).textContent }; });
    await ctx.close();
    const want = ['Consultative Client Conversations', 'Designing Client-Ready Reports', 'Financial Planning Foundations', 'SEBI & AMFI Compliance Essentials'];
    if(!v.open || JSON.stringify(v.cards) !== JSON.stringify(want) || v.drafts || v.add || v.accessChips || v.menu.join() !== 'Preview') throw new Error('partner page: ' + JSON.stringify(v));
    return '4 courses (incl. the partners-only one), no drafts, no Add Course, menu is Preview only';
  });
});
