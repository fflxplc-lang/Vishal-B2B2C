/* =====================================================================
   SKILL DEVELOPMENT CENTER — the firm's learning library.

   One route, `skills`, with three faces:
     library   every course as a card or a row, with search (title, tag,
               instructor), category pills, difficulty and status filters
     course    a course's overview banner, then the lesson viewer beside a
               collapsible syllabus: modules as an accordion, lessons with
               done / current / unread / locked marks, Mark as Complete and
               Previous / Next
     builder   + Add Course (or Edit): Basic info → Curriculum → Preview &
               Publish, with a live card preview the whole way

   Two stores, read by loadAll() in index.html:
     sdcCourses   the courses, each with its modules and lessons
     sdcProgress  one row per person per course: which lessons they have
                  finished and where they were (userId is the owner, so a
                  partner's page only receives their own — access.js)

   Anybody signed in learns from published courses; admins (and whoever
   holds Manage Module Settings on the company side) build and edit them.
   Styling is skill-center.css, scoped under .sdc.
   ===================================================================== */

const SDC_CATEGORIES = ['Technical', 'Communication', 'Leadership', 'Design', 'Compliance'];
const SDC_LEVELS = ['Beginner', 'Intermediate', 'Advanced'];
const SDC_TYPES = {
  Video:    {label: 'Video',          icon: '▶'},
  Article:  {label: 'Reading',        icon: '📄'},
  Resource: {label: 'PDF / Resource', icon: '📎'},
  Quiz:     {label: 'Quiz',           icon: '❓'},
  Exercise: {label: 'Exercise',       icon: '✍️'},
};
const SDC_COLORS = ['#164B5E', '#1E6B85', '#0E7490', '#047857', '#4D7C0F', '#B45309', '#F25C2A', '#BE185D', '#6D28D9', '#4338CA', '#334155'];
const SDC_ICONS = ['📈', '💬', '🧭', '🎨', '🛡️', '🧮', '📚', '🎯', '🤝', '💡', '🏦', '🧠', '📊', '🚀'];

/* ---------- reading the stores ---------- */
function sdcAll(){ return Array.isArray(DB.sdcCourses) ? DB.sdcCourses : []; }
function sdcCourses(){ return sdcAll().filter(c=>c && !c.deletedAt); }
function sdcCourse(id){ return sdcCourses().find(c=>c.id===id) || null; }
/* Who builds and edits courses: an admin, or a company person with Manage
   Module Settings. Partners learn; they do not write the company's library. */
function sdcMayManage(){
  if(typeof bossPartnerSide === 'function' && bossPartnerSide()) return false;
  return isAdmin() || (typeof canAdmin === 'function' && canAdmin('manageModuleSettings'));
}
/* What a learner sees: published courses; a manager sees drafts too. */
function sdcVisible(){ return sdcCourses().filter(c=>c.status==='Published' || sdcMayManage()); }
function sdcLessons(c){
  const out = [];
  (c && c.modules || []).forEach((m, mi)=>(m.lessons || []).forEach((l, li)=>out.push({l, m, mi, li})));
  return out;
}
function sdcStats(c){
  const ls = sdcLessons(c);
  return {modules: (c.modules || []).length, lessons: ls.length, minutes: ls.reduce((n, x)=>n + (Number(x.l.minutes) || 0), 0)};
}
function sdcDur(min){
  min = Math.round(Number(min) || 0);
  if(min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h' + (min % 60 ? ' ' + (min % 60) + 'm' : '');
}
function sdcMetaText(c){
  const s = sdcStats(c);
  return s.modules + ' Module' + (s.modules===1?'':'s') + ' • ' + s.lessons + ' Lesson' + (s.lessons===1?'':'s') + ' • ' + sdcDur(s.minutes);
}

/* ---------- progress, one row per person per course ---------- */
function sdcProgAll(){ return Array.isArray(DB.sdcProgress) ? DB.sdcProgress : (DB.sdcProgress = []); }
function sdcProg(courseId, create){
  const id = currentUser + '|' + courseId;
  let p = sdcProgAll().find(x=>x && x.id===id);
  if(!p && create){
    p = {id, userId: currentUser, courseId, done: {}, lastLessonId: '', startedAt: new Date().toISOString()};
    sdcProgAll().push(p);
  }
  return p || null;
}
function sdcIsDone(c, lessonId){ const p = sdcProg(c.id); return !!(p && p.done && p.done[lessonId]); }
function sdcPct(c){
  const ls = sdcLessons(c);
  if(!ls.length) return 0;
  const p = sdcProg(c.id);
  if(!p) return 0;
  return Math.round(100 * ls.filter(x=>p.done && p.done[x.l.id]).length / ls.length);
}
function sdcLearnState(c){
  const p = sdcProg(c.id), pct = sdcPct(c);
  if(pct >= 100) return 'Completed';
  if(p && (pct > 0 || p.lastLessonId)) return 'In Progress';
  return 'Not started';
}
/* A sequential course opens a lesson once every lesson before it is done. */
function sdcLocked(c, lessonId){
  if(!c.sequential) return false;
  const ls = sdcLessons(c);
  const i = ls.findIndex(x=>x.l.id===lessonId);
  return i > 0 && ls.slice(0, i).some(x=>!sdcIsDone(c, x.l.id));
}

/* ---------- small pieces ---------- */
function sdcHexRgb(hex){
  const h = String(hex || '#164B5E').replace('#', '');
  const n = parseInt(h.length===3 ? h.split('').map(x=>x+x).join('') : h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function sdcShade(hex, k){
  const [r, g, b] = sdcHexRgb(hex);
  const f = v => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k)));
  return '#' + [f(r), f(g), f(b)].map(v=>v.toString(16).padStart(2, '0')).join('');
}
/* The course's colour, as the custom properties skill-center.css reads. */
function sdcVars(c){
  const col = (c && c.color) || SDC_COLORS[0];
  const [r, g, b] = sdcHexRgb(col);
  return `--c:${col};--c-2:${sdcShade(col, -0.35)};--c-soft:rgba(${r},${g},${b},.09);--c-line:rgba(${r},${g},${b},.22);--c-ink:${col}`;
}
function sdcInitials(name){ return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w=>w[0].toUpperCase()).join('') || '?'; }
function sdcLevelHtml(level){
  const n = Math.max(1, SDC_LEVELS.indexOf(level) + 1);
  return `<span class="sdc-level ${esc(level)}"><i>${[1,2,3].map(k=>`<b class="${k<=n?'on':''}"></b>`).join('')}</i>${esc(level || 'Beginner')}</span>`;
}
const SDC_SVG = {
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  chev: '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 6 6 6-6 6"/></svg>',
  play: '<svg width="28" height="28" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>',
  side: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
};
function sdcRing(pct){
  const r = 12, c = 2 * Math.PI * r, off = c * (1 - (pct || 0) / 100);
  return `<svg class="sdc-mod-ring" viewBox="0 0 30 30"><circle cx="15" cy="15" r="${r}" fill="none" stroke="var(--edge)" stroke-width="3"/>
    <circle cx="15" cy="15" r="${r}" fill="none" stroke="${pct>=100?'var(--ok)':'var(--c,var(--navy))'}" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 15 15)"/>
    <text x="15" y="18.5" text-anchor="middle" font-size="8.5" font-weight="700" fill="currentColor">${pct>=100?'✓':pct+'%'}</text></svg>`;
}
/* A lesson's notes: paragraphs, "## " headings, "- " bullets, "> " tips and **bold**. */
function sdcRich(text){
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  String(text || '').split('\n').forEach(raw=>{
    const line = raw.trimEnd();
    if(/^\s*-\s+/.test(line)){ (list = list || []).push('<li>' + inline(line.replace(/^\s*-\s+/, '')) + '</li>'); return; }
    if(list){ out.push('<ul>' + list.join('') + '</ul>'); list = null; }
    if(!line.trim()) return;
    if(/^##\s+/.test(line)) out.push('<h3>' + inline(line.replace(/^##\s+/, '')) + '</h3>');
    else if(/^>\s?/.test(line)) out.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>');
    else out.push('<p>' + inline(line) + '</p>');
  });
  if(list) out.push('<ul>' + list.join('') + '</ul>');
  return out.join('');
}

/* ---------- state ---------- */
function sdcState(){
  if(!window._sdc) window._sdc = {mode: 'library', q: '', cat: 'All', level: '', status: 'All', layout: 'grid',
    courseId: null, lessonId: null, preview: false, side: true, open: {}, quiz: {}, step: 1, expand: {}};
  return window._sdc;
}

/* =====================================================================
   THE ROUTE
   ===================================================================== */
function viewSkillCenter(){
  const S = sdcState();
  // navigate('skills', courseId) opens that course.
  if(window._sdcArg){ const id = window._sdcArg; window._sdcArg = null; if(sdcCourse(id)) sdcOpenState(id); }
  if(S.mode === 'builder' && window._sdcDraft) return `<div class="sdc">${sdcBuilderHtml()}</div>`;
  if(S.mode === 'course' && sdcCourse(S.courseId)) return `<div class="sdc">${sdcCourseHtml(sdcCourse(S.courseId))}</div>`;
  S.mode = 'library';
  return `<div class="sdc">${sdcLibraryHtml()}</div>`;
}
function sdcHome(){ const S = sdcState(); S.mode = 'library'; S.courseId = null; S.preview = false; window._sdcDraft = null; render(); }

/* =====================================================================
   LIBRARY
   ===================================================================== */
function sdcFiltered(){
  const S = sdcState(), q = S.q.trim().toLowerCase();
  return sdcVisible().filter(c=>{
    if(S.cat !== 'All' && c.category !== S.cat) return false;
    if(S.level && c.level !== S.level) return false;
    if(S.status === 'Published' && c.status !== 'Published') return false;
    if(S.status === 'Draft' && c.status !== 'Draft') return false;
    if(S.status === 'In Progress' && sdcLearnState(c) !== 'In Progress') return false;
    if(S.status === 'Completed' && sdcLearnState(c) !== 'Completed') return false;
    if(q){
      const hay = [c.title, c.subtitle, (c.tags || []).join(' '), c.instructor && c.instructor.name, c.category].join(' ').toLowerCase();
      if(!q.split(/\s+/).every(w=>hay.indexOf(w) >= 0)) return false;
    }
    return true;
  }).sort((a, b)=>{
    // What somebody is in the middle of comes first, then the newest.
    const w = c => sdcLearnState(c) === 'In Progress' ? 0 : 1;
    return w(a) - w(b) || String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  });
}
function sdcLibraryHtml(){
  const S = sdcState();
  const all = sdcVisible();
  const mine = all.filter(c=>c.status==='Published');
  const inProg = mine.filter(c=>sdcLearnState(c)==='In Progress').length;
  const done = mine.filter(c=>sdcLearnState(c)==='Completed').length;
  const hours = mine.reduce((n, c)=>n + sdcStats(c).minutes, 0);
  const count = k => all.filter(c=>k==='All' || c.category===k).length;
  const statuses = ['All', 'Published', 'Draft', 'In Progress', 'Completed'].filter(s=>sdcMayManage() || s !== 'Draft');
  return `
    <div class="sdc-head">
      <div><h1>Skill Development Center</h1><p>Browse, manage, and learn structured skill courses.</p></div>
      <div class="sdc-head-actions">
        <label class="sdc-search">${SDC_SVG.search}<input id="sdcSearch" type="search" placeholder="Search courses by title, tag, or instructor" value="${esc(S.q)}"
          oninput="sdcSearch(this.value)" aria-label="Search courses"></label>
        ${sdcMayManage() ? `<button class="sdc-btn primary" onclick="sdcNewCourse()">+ Add Course</button>` : ''}
      </div>
    </div>
    ${all.length ? `<div class="sdc-stats">
      <div class="sdc-stat"><b>${mine.length}</b><span>Courses available</span></div>
      <div class="sdc-stat"><b>${inProg}</b><span>In progress</span></div>
      <div class="sdc-stat"><b>${done}</b><span>Completed</span></div>
      <div class="sdc-stat"><b>${sdcDur(hours)}</b><span>Of learning in the library</span></div>
    </div>` : ''}
    <div class="sdc-filters">
      <div class="sdc-pills" role="tablist">${['All'].concat(SDC_CATEGORIES).map(k=>`<button class="sdc-pill ${S.cat===k?'on':''}" role="tab" aria-selected="${S.cat===k}"
        onclick="sdcSet('cat','${k}')">${esc(k)}<span class="n">${count(k)}</span></button>`).join('')}</div>
      <div class="sdc-controls">
        <select class="sdc-select" aria-label="Difficulty" onchange="sdcSet('level', this.value)">
          <option value="">All levels</option>${SDC_LEVELS.map(l=>`<option ${S.level===l?'selected':''}>${l}</option>`).join('')}</select>
        <select class="sdc-select" aria-label="Status" onchange="sdcSet('status', this.value)">
          ${statuses.map(s=>`<option value="${s}" ${S.status===s?'selected':''}>${s==='All'?'All statuses':s}</option>`).join('')}</select>
        <div class="sdc-toggle" role="group" aria-label="Layout">
          <button class="${S.layout==='grid'?'on':''}" title="Grid view" onclick="sdcSet('layout','grid')">${SDC_SVG.grid}</button>
          <button class="${S.layout==='list'?'on':''}" title="List view" onclick="sdcSet('layout','list')">${SDC_SVG.list}</button>
        </div>
      </div>
    </div>
    <div id="sdcResults">${sdcResultsHtml()}</div>`;
}
function sdcResultsHtml(){
  const S = sdcState(), list = sdcFiltered();
  if(!sdcVisible().length){
    return `<div class="sdc-empty"><div class="sdc-empty-art">📚</div><h3>Your library is empty</h3>
      <p>${sdcMayManage() ? 'Create the first course: give it a title and a cover, build its modules and lessons, and publish it to the team.' : 'No courses have been published yet. They will appear here as soon as they are.'}</p>
      ${sdcMayManage() ? `<button class="sdc-btn primary" onclick="sdcNewCourse()">+ Add Course</button>` : ''}</div>`;
  }
  if(!list.length){
    return `<div class="sdc-empty"><div class="sdc-empty-art">🔍</div><h3>No courses match</h3>
      <p>Nothing in the library fits ${S.q ? '“' + esc(S.q) + '” and ' : ''}these filters.</p>
      <button class="sdc-btn" onclick="sdcClearFilters()">Clear search and filters</button></div>`;
  }
  const head = `<p class="sdc-count">${list.length} course${list.length===1?'':'s'}</p>`;
  if(S.layout === 'list') return head + `<div class="sdc-list">${list.map(sdcRowHtml).join('')}</div>`;
  return head + `<div class="sdc-grid">${list.map(c=>sdcCardHtml(c)).join('')}</div>`;
}
function sdcMenuHtml(c){
  const items = [['👁', 'Preview', `sdcOpen('${c.id}', true)`]];
  if(sdcMayManage()) items.unshift(['✏️', 'Edit', `sdcEdit('${c.id}')`]);
  if(sdcMayManage()) items.push(['⧉', 'Duplicate', `sdcDuplicate('${c.id}')`], ['🗑', 'Delete', `sdcDelete('${c.id}')`, 'danger']);
  return `<details class="sdc-menu" onclick="event.stopPropagation()" ontoggle="sdcMenuToggle(this)"><summary aria-label="Course actions">⋯</summary>
    <div class="sdc-menu-list">${items.map(([i, l, fn, cls])=>`<button class="${cls||''}" onclick="event.stopPropagation(); this.closest('details').open=false; ${fn}">${i} ${l}</button>`).join('')}</div></details>`;
}
function sdcMenuToggle(el){ if(el.open) document.querySelectorAll('.sdc-menu[open]').forEach(d=>{ if(d !== el) d.open = false; }); }
function sdcActionHtml(c, compact){
  const st = sdcLearnState(c), pct = sdcPct(c);
  if(c.status === 'Draft' && !sdcLessons(c).length) return `<button class="sdc-btn sm" onclick="event.stopPropagation(); sdcEdit('${c.id}')">Continue building</button>`;
  if(st === 'In Progress') return `<div class="sdc-progress"><div class="sdc-progress-top"><span>Progress</span><b>${pct}%</b></div>
    <div class="sdc-bar"><i style="width:${pct}%"></i></div></div>${compact ? '' : `<button class="sdc-btn sm primary" onclick="event.stopPropagation(); sdcOpen('${c.id}')">Resume</button>`}`;
  if(st === 'Completed') return `<span class="sdc-chip done">✓ Completed</span><span style="flex:1"></span><button class="sdc-btn sm" onclick="event.stopPropagation(); sdcOpen('${c.id}')">Open Course</button>`;
  return `<span style="flex:1"></span><button class="sdc-btn sm primary" onclick="event.stopPropagation(); sdcOpen('${c.id}')">Start Learning</button>`;
}
function sdcCardHtml(c, opts){
  opts = opts || {};
  const ins = c.instructor || {};
  return `<article class="sdc-card" style="${sdcVars(c)}" tabindex="0" ${opts.preview ? '' : `onclick="sdcOpen('${c.id}')" onkeydown="if(event.key==='Enter') sdcOpen('${c.id}')"`}
      aria-label="${esc(c.title || 'Untitled course')}">
    <div class="sdc-cover">
      <div class="sdc-badges"><span class="sdc-chip">${esc(c.category || 'Technical')}</span>${c.status==='Draft' ? '<span class="sdc-chip draft">Draft</span>' : ''}</div>
      <div class="sdc-cover-icon">${esc(c.icon || '📚')}</div>
    </div>
    ${opts.preview ? '' : sdcMenuHtml(c)}
    <div class="sdc-body">
      <div>${sdcLevelHtml(c.level)}</div>
      <h3 class="sdc-title">${esc(c.title || 'Untitled course')}</h3>
      <p class="sdc-desc">${esc(c.subtitle || c.description || 'Add a short description so learners know what they will get out of it.')}</p>
      <div class="sdc-meta">${esc(sdcMetaText(c))}</div>
      ${ins.name ? `<div class="sdc-instructor"><span class="sdc-avatar">${esc(sdcInitials(ins.name))}</span>${esc(ins.name)}</div>` : ''}
      <div class="sdc-foot">${opts.preview ? `<span style="flex:1"></span><span class="sdc-btn sm primary">Start Learning</span>` : sdcActionHtml(c)}</div>
    </div>
  </article>`;
}
function sdcRowHtml(c){
  const st = sdcLearnState(c), pct = sdcPct(c);
  return `<div class="sdc-list-row" style="${sdcVars(c)}" onclick="sdcOpen('${c.id}')" tabindex="0" onkeydown="if(event.key==='Enter') sdcOpen('${c.id}')">
    <div class="sdc-thumb">${esc(c.icon || '📚')}</div>
    <div><h3 class="sdc-title">${esc(c.title)} ${c.status==='Draft' ? '<span class="sdc-chip draft">Draft</span>' : ''}</h3><p class="sdc-desc">${esc(c.subtitle || '')}</p></div>
    <div class="hide-sm"><div class="sdc-meta">${esc(c.category)} <span class="dot">•</span> ${sdcLevelHtml(c.level)}</div><div class="sdc-meta" style="margin-top:4px">${esc(sdcMetaText(c))}</div></div>
    <div class="hide-sm">${st==='Not started' ? `<span class="muted" style="font-size:12.5px">Not started</span>` : `<div class="sdc-progress"><div class="sdc-progress-top"><span>${st}</span><b>${pct}%</b></div><div class="sdc-bar"><i style="width:${pct}%"></i></div></div>`}</div>
    <div style="display:flex;gap:6px;align-items:center">${sdcMenuHtml(c)}</div>
  </div>`;
}
/* Search redraws only the results, so the box keeps its focus and caret. */
function sdcSearch(v){
  sdcState().q = v;
  const el = document.getElementById('sdcResults');
  if(el) el.innerHTML = sdcResultsHtml(); else render();
}
function sdcSet(k, v){ sdcState()[k] = v; render(); }
function sdcClearFilters(){ Object.assign(sdcState(), {q: '', cat: 'All', level: '', status: 'All'}); render(); }

/* =====================================================================
   COURSE: overview banner, lesson viewer, syllabus
   ===================================================================== */
function sdcOpenState(id, preview){
  const S = sdcState(), c = sdcCourse(id);
  if(!c) return;
  S.mode = 'course'; S.courseId = id; S.preview = !!preview; S.quiz = {};
  const ls = sdcLessons(c), p = sdcProg(id);
  const resume = p && p.lastLessonId && ls.find(x=>x.l.id===p.lastLessonId);
  const firstOpen = ls.find(x=>!sdcIsDone(c, x.l.id) && !sdcLocked(c, x.l.id));
  S.lessonId = (resume || firstOpen || ls[0] || {l: {}}).l.id || null;
  S.open = {};
  const cur = ls.find(x=>x.l.id===S.lessonId);
  (c.modules || []).forEach((m, i)=>{ S.open[m.id] = cur ? cur.m.id === m.id : i === 0; });
}
function sdcOpen(id, preview){
  sdcOpenState(id, preview);
  if(typeof currentView !== 'undefined' && currentView !== 'skills') navigate('skills');
  else render();
  try { window.scrollTo({top: 0}); } catch(e){}
}
function sdcCourseHtml(c){
  const S = sdcState(), ins = c.instructor || {}, pct = sdcPct(c), st = sdcLearnState(c);
  const ls = sdcLessons(c);
  const cur = ls.find(x=>x.l.id===S.lessonId) || ls[0];
  const cta = !ls.length ? '' : st === 'Not started' ? 'Start Course' : st === 'Completed' ? 'Review Course' : 'Continue Learning';
  return `<div style="${sdcVars(c)}">
    ${S.preview ? `<div class="sdc-preview-bar"><span>👁 <b>Preview</b> — you are seeing this course as a learner would. Nothing you do here is recorded as progress.</span>
      <button class="sdc-btn sm" onclick="sdcOpen('${c.id}')">Exit preview</button></div>` : ''}
    <nav class="sdc-crumbs" aria-label="Breadcrumb"><a onclick="sdcHome()">Skill Development Center</a><span>›</span>
      <a onclick="sdcState().cat='${esc(c.category)}'; sdcHome()">${esc(c.category)}</a><span>›</span><b>${esc(c.title)}</b></nav>
    <section class="sdc-hero">
      <div class="sdc-hero-top"><span class="sdc-chip">${esc(c.icon || '📚')} ${esc(c.category)}</span><span class="sdc-chip">${esc(c.level || 'Beginner')}</span>
        ${c.status==='Draft' ? '<span class="sdc-chip draft">Draft</span>' : ''}${c.sequential ? '<span class="sdc-chip dark">🔒 Lessons unlock in order</span>' : ''}</div>
      <h1>${esc(c.title)}</h1>
      <p>${esc(c.description || c.subtitle || '')}</p>
      <div class="sdc-hero-meta">
        ${ins.name ? `<div class="who"><span class="sdc-avatar lg">${esc(sdcInitials(ins.name))}</span><div><b>${esc(ins.name)}</b><span>${esc(ins.title || 'Instructor')}</span></div></div><span class="sep"></span>` : ''}
        <div><b>${esc(sdcMetaText(c))}</b></div><span class="sep"></span>
        <div>Last updated ${esc(fmtDate(c.updatedAt || c.createdAt))}</div>
      </div>
      <div class="sdc-hero-foot">
        <div class="sdc-hero-progress sdc-progress"><div class="sdc-progress-top"><span>${S.preview ? 'Your progress (not changed in preview)' : 'Your progress'}</span><b>${pct}%</b></div>
          <div class="sdc-bar lg"><i style="width:${pct}%"></i></div></div>
        ${cta ? `<button class="sdc-btn light" onclick="sdcContinue()">${cta} →</button>` : ''}
        ${sdcMayManage() ? `<button class="sdc-btn glass" onclick="sdcEdit('${c.id}')">✏️ Edit course</button>` : ''}
      </div>
    </section>
    ${ls.length ? `<div class="sdc-learn ${S.side ? '' : 'no-side'}">
      <div id="sdcViewer">${sdcViewerHtml(c, cur)}</div>
      ${sdcSyllabusHtml(c)}
    </div>` : `<div class="sdc-empty"><div class="sdc-empty-art">🧩</div><h3>No lessons yet</h3><p>This course has no curriculum yet.</p>
      ${sdcMayManage() ? `<button class="sdc-btn primary" onclick="sdcEdit('${c.id}', 2)">Build the curriculum</button>` : ''}</div>`}
  </div>`;
}
function sdcContinue(){
  const S = sdcState(), c = sdcCourse(S.courseId);
  const ls = sdcLessons(c);
  const next = ls.find(x=>!sdcIsDone(c, x.l.id) && !sdcLocked(c, x.l.id)) || ls[0];
  if(next) sdcGo(next.l.id);
  const el = document.getElementById('sdcViewer');
  if(el) el.scrollIntoView({behavior: 'smooth', block: 'start'});
}
function sdcSyllabusHtml(c){
  const S = sdcState(), ls = sdcLessons(c);
  const doneN = ls.filter(x=>sdcIsDone(c, x.l.id)).length;
  return `<aside class="sdc-syllabus" aria-label="Course curriculum">
    <div class="sdc-syl-head"><div><h3>Course content</h3><span>${doneN} of ${ls.length} lessons complete</span></div>
      <button class="sdc-ibtn" title="Hide course content" onclick="sdcSet('side', false)">✕</button></div>
    <div class="sdc-syl-body">${(c.modules || []).map((m, mi)=>{
      const mls = m.lessons || [];
      const md = mls.filter(l=>sdcIsDone(c, l.id)).length;
      const mpct = mls.length ? Math.round(100 * md / mls.length) : 0;
      const open = S.open[m.id] !== false && S.open[m.id] !== undefined ? S.open[m.id] : false;
      return `<div class="sdc-mod ${open ? 'open' : ''}">
        <button class="sdc-mod-head" aria-expanded="${open}" onclick="sdcToggleModule('${m.id}')">${SDC_SVG.chev}
          <span class="t"><b>Module ${mi + 1}: ${esc(m.title || 'Untitled module')}</b><span>${mls.length} lesson${mls.length===1?'':'s'} • ${sdcDur(mls.reduce((n, l)=>n + (Number(l.minutes) || 0), 0))}</span></span>
          ${sdcRing(mpct)}</button>
        <div class="sdc-lessons">${mls.map(l=>{
          const done = sdcIsDone(c, l.id), active = l.id === S.lessonId, locked = !done && sdcLocked(c, l.id);
          const st = done ? '<span class="st done">✓</span>' : locked ? '<span class="st lock">🔒</span>' : active ? '<span class="st cur"></span>' : '<span class="st todo"></span>';
          return `<button class="sdc-les ${active ? 'active' : ''} ${locked ? 'locked' : ''}" onclick="sdcGo('${l.id}')" aria-current="${active}">
            ${st}<span class="nm">${esc(l.title || 'Untitled lesson')}<small>${esc((SDC_TYPES[l.type] || SDC_TYPES.Article).label)}</small></span>
            <span class="du">${sdcDur(l.minutes)}</span></button>`;
        }).join('') || '<div class="muted" style="font-size:12.5px;padding:6px 14px">No lessons in this module yet.</div>'}</div>
      </div>`;
    }).join('')}</div>
  </aside>`;
}
function sdcToggleModule(id){ const S = sdcState(); S.open[id] = !S.open[id]; render(); }
function sdcGo(lessonId){
  const S = sdcState(), c = sdcCourse(S.courseId);
  if(!c) return;
  S.lessonId = lessonId;
  const x = sdcLessons(c).find(y=>y.l.id===lessonId);
  if(x) S.open[x.m.id] = true;
  // Opening a lesson is where the learner is: remembered, unless previewing or locked.
  if(!S.preview && x && !(sdcLocked(c, lessonId) && !sdcMayManage())){
    const p = sdcProg(c.id, true);
    if(p.lastLessonId !== lessonId){ p.lastLessonId = lessonId; p.updatedAt = new Date().toISOString(); save('sdcProgress'); }
  }
  render();
}
function sdcViewerHtml(c, x){
  const S = sdcState();
  if(!x) return '';
  const l = x.l, ls = sdcLessons(c), i = ls.findIndex(y=>y.l.id===l.id);
  const prev = ls[i - 1], next = ls[i + 1];
  const done = sdcIsDone(c, l.id), locked = !done && sdcLocked(c, l.id);
  const t = SDC_TYPES[l.type] || SDC_TYPES.Article;
  const head = `<div class="sdc-viewer-head"><div style="min-width:0">
      <div class="where">Module ${x.mi + 1} · Lesson ${x.li + 1} of ${(x.m.lessons || []).length}</div>
      <h2>${esc(l.title || 'Untitled lesson')}</h2>
      <div class="sdc-meta" style="margin-top:8px"><span class="sdc-type ${esc(l.type || 'Article')}">${t.icon} ${esc(t.label)}</span><span>⏱ ${sdcDur(l.minutes)}</span>
        ${done ? '<span class="sdc-chip done">✓ Completed</span>' : ''}</div></div>
    ${S.side ? '' : `<button class="sdc-btn sm" onclick="sdcSet('side', true)">${SDC_SVG.side} Course content</button>`}</div>`;
  if(locked && !sdcMayManage()){
    return `<div class="sdc-viewer">${head}<div class="sdc-locked"><div class="ico">🔒</div><h3 style="margin:0 0 6px">This lesson is locked</h3>
      <p class="muted" style="margin:0 0 16px">Lessons in this course open in order. Finish the lessons before it to unlock it.</p>
      ${prev ? `<button class="sdc-btn primary" onclick="sdcGo('${prev.l.id}')">← Go to the previous lesson</button>` : ''}</div></div>`;
  }
  const lockNote = locked ? `<div class="sdc-preview-bar" style="margin-bottom:16px"><span>🔒 Locked for learners until the lessons before it are done — you can open it because you manage courses.</span></div>` : '';
  return `<div class="sdc-viewer">${head}
    <div class="sdc-viewer-body">${lockNote}
      ${l.type === 'Video' ? sdcMediaHtml(l) : ''}
      ${l.type === 'Quiz' && (l.quiz || []).length ? sdcQuizHtml(c, l) : ''}
      ${l.summary && !l.body ? `<div class="sdc-rich"><p>${esc(l.summary)}</p></div>` : ''}
      ${l.body ? `<div class="sdc-rich">${sdcRich(l.body)}</div>` : ''}
      ${!l.body && !l.summary && !(l.quiz || []).length ? `<p class="muted">No notes have been written for this lesson yet.</p>` : ''}
      ${(l.takeaways || []).length ? `<div class="sdc-callout"><h4>💡 Key takeaways</h4><ul>${l.takeaways.map(k=>`<li>${esc(k)}</li>`).join('')}</ul></div>` : ''}
      ${sdcResourcesHtml(c, l)}
    </div>
    <div class="sdc-viewer-foot">
      <button class="sdc-btn" ${prev ? `onclick="sdcGo('${prev.l.id}')"` : 'disabled'}>← Previous</button>
      ${S.preview ? `<span class="muted" style="font-size:12.5px">Preview — progress is not recorded</span>`
        : `<button class="sdc-btn sdc-done-btn ${done ? 'on' : ''}" onclick="sdcToggleDone('${l.id}')">${done ? '✓ Completed' : 'Mark as Complete'}</button>`}
      <button class="sdc-btn primary" ${next ? `onclick="sdcGo('${next.l.id}')"` : 'disabled'}>${next ? 'Next Lesson →' : 'Last lesson'}</button>
    </div></div>`;
}
function sdcMediaHtml(l){
  const url = String(l.videoUrl || '').trim();
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,})/);
  if(yt) return `<div class="sdc-media"><iframe src="https://www.youtube-nocookie.com/embed/${esc(yt[1])}" title="${esc(l.title)}" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`;
  if(/^https?:\/\/.+\.(mp4|webm|ogg)(\?.*)?$/i.test(url)) return `<div class="sdc-media"><video controls src="${esc(url)}"></video></div>`;
  return `<div class="sdc-media"><div class="play">${SDC_SVG.play}</div>
    <div class="cap"><span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener" style="color:#fff">Open the video ↗</a>` : 'Video not attached yet'}</span><span>${sdcDur(l.minutes)}</span></div></div>`;
}
function sdcResourcesHtml(c, l){
  const res = (l.resources || []).filter(r=>r && r.name);
  return `<div class="sdc-resources"><h4>Resources</h4>
    ${res.map(r=>{
      const ext = (String(r.kind || r.name.split('.').pop() || 'FILE')).slice(0, 4).toUpperCase();
      return `<div class="sdc-res"><span class="sdc-res-ico">${esc(ext)}</span><span class="sdc-res-name"><b>${esc(r.name)}</b><span>${esc(r.note || (r.url ? 'Link' : 'Not uploaded yet'))}</span></span>
        ${r.url ? `<a class="sdc-btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">Open ↗</a>` : `<span class="sdc-chip draft">Not uploaded</span>`}</div>`;
    }).join('')}
    <div class="sdc-res"><span class="sdc-res-ico">TXT</span><span class="sdc-res-name"><b>Lesson notes — ${esc(l.title)}</b><span>The notes and takeaways of this lesson, to keep</span></span>
      <button class="sdc-btn sm" onclick="sdcDownloadNotes('${c.id}','${l.id}')">Download</button></div>
  </div>`;
}
function sdcDownloadNotes(courseId, lessonId){
  const c = sdcCourse(courseId), x = c && sdcLessons(c).find(y=>y.l.id===lessonId);
  if(!x) return;
  const l = x.l;
  const text = [c.title, 'Module ' + (x.mi + 1) + ': ' + (x.m.title || ''), 'Lesson: ' + l.title, '',
    (l.summary || ''), '', String(l.body || '').replace(/\*\*/g, ''), '',
    (l.takeaways || []).length ? 'Key takeaways:\n' + l.takeaways.map(k=>'- ' + k).join('\n') : ''].join('\n').replace(/\n{3,}/g, '\n\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type: 'text/plain'}));
  a.download = (l.title || 'lesson').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '-notes.txt';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}
function sdcQuizHtml(c, l){
  const S = sdcState(), st = S.quiz[l.id] || {ans: {}, checked: false};
  const qs = l.quiz || [];
  const right = qs.filter((q, i)=>st.ans[i] === q.answer).length;
  return `<div style="margin-bottom:18px">
    ${st.checked ? `<div class="sdc-score ${right===qs.length ? 'pass' : 'fail'}">${right===qs.length ? '🎉 All ' + qs.length + ' correct — well done.' : right + ' of ' + qs.length + ' correct. Review the explanations and try again.'}</div>` : ''}
    ${qs.map((q, i)=>`<div class="sdc-q"><h5>${i + 1}. ${esc(q.q)}</h5>
      ${(q.options || []).map((o, k)=>{
        const cls = st.checked ? (k === q.answer ? 'right' : st.ans[i] === k ? 'wrong' : '') : '';
        return `<label class="sdc-opt ${cls}"><input type="radio" name="sdcq_${esc(l.id)}_${i}" ${st.ans[i]===k?'checked':''} ${st.checked?'disabled':''}
          onchange="sdcQuizPick('${l.id}', ${i}, ${k})"><span>${esc(o)}</span></label>`;
      }).join('')}
      ${st.checked && q.explain ? `<div class="sdc-explain">${esc(q.explain)}</div>` : ''}</div>`).join('')}
    ${st.checked ? `<button class="sdc-btn" onclick="sdcQuizReset('${l.id}')">Try again</button>`
      : `<button class="sdc-btn primary" ${Object.keys(st.ans).length < qs.length ? 'disabled' : ''} onclick="sdcQuizCheck('${l.id}')">Check answers</button>`}
  </div>`;
}
function sdcQuizPick(lid, i, k){
  const S = sdcState(); S.quiz[lid] = S.quiz[lid] || {ans: {}, checked: false}; S.quiz[lid].ans[i] = k;
  const c = sdcCourse(S.courseId), x = c && sdcLessons(c).find(y=>y.l.id===lid);
  const el = document.getElementById('sdcViewer');
  if(el && x) el.innerHTML = sdcViewerHtml(c, x); else render();
}
async function sdcQuizCheck(lid){
  const S = sdcState(), c = sdcCourse(S.courseId), x = c && sdcLessons(c).find(y=>y.l.id===lid);
  if(!x) return;
  S.quiz[lid].checked = true;
  const qs = x.l.quiz || [];
  // Passing the quiz completes the lesson.
  if(!S.preview && qs.every((q, i)=>S.quiz[lid].ans[i] === q.answer) && !sdcIsDone(c, lid)) await sdcToggleDone(lid, true);
  else render();
}
function sdcQuizReset(lid){ sdcState().quiz[lid] = {ans: {}, checked: false}; render(); }
async function sdcToggleDone(lessonId, quiet){
  const S = sdcState(), c = sdcCourse(S.courseId);
  if(!c || S.preview) return;
  if(!sdcIsDone(c, lessonId) && sdcLocked(c, lessonId) && !sdcMayManage()){ alert('Finish the lessons before this one first.'); return; }
  const p = sdcProg(c.id, true);
  p.done = p.done || {};
  if(p.done[lessonId]) delete p.done[lessonId];
  else p.done[lessonId] = new Date().toISOString();
  p.lastLessonId = lessonId;
  p.updatedAt = new Date().toISOString();
  if(sdcPct(c) >= 100 && !p.completedAt) p.completedAt = p.updatedAt;
  if(sdcPct(c) < 100) delete p.completedAt;
  await save('sdcProgress');
  render();
  if(!quiet && sdcPct(c) >= 100 && p.completedAt === p.updatedAt) setTimeout(()=>alert('🎉 Course complete: ' + c.title + '. Well done.'), 50);
}

/* =====================================================================
   BUILDER: Basic info → Curriculum → Preview & Publish
   ===================================================================== */
function sdcBlank(){
  return {id: '', title: '', subtitle: '', description: '', category: 'Technical', level: 'Beginner',
    instructor: {name: (me() || {}).name || '', title: ''}, color: SDC_COLORS[0], icon: '📚', tags: [], sequential: false,
    status: 'Draft', modules: [{id: uid('SDM'), title: 'Module 1: Foundations', lessons: [sdcBlankLesson()]}]};
}
function sdcBlankLesson(type){ return {id: uid('SDL'), title: '', type: type || 'Video', minutes: 10, summary: ''}; }
function sdcNewCourse(){
  if(!sdcMayManage()){ alert('Only an admin, or someone with Manage Module Settings, can build courses.'); return; }
  window._sdcDraft = sdcBlank();
  Object.assign(sdcState(), {mode: 'builder', step: 1, expand: {}});
  if(typeof currentView !== 'undefined' && currentView !== 'skills') navigate('skills'); else render();
}
function sdcEdit(id, step){
  if(!sdcMayManage()){ alert('Only an admin, or someone with Manage Module Settings, can edit courses.'); return; }
  const c = sdcCourse(id);
  if(!c) return;
  window._sdcDraft = JSON.parse(JSON.stringify(c));
  Object.assign(sdcState(), {mode: 'builder', step: step || 1, expand: {}});
  if(typeof currentView !== 'undefined' && currentView !== 'skills') navigate('skills'); else render();
}
function sdcBuilderHtml(){
  const S = sdcState(), d = window._sdcDraft;
  const steps = [[1, 'Basic Info'], [2, 'Curriculum'], [3, 'Preview & Publish']];
  return `<div class="sdc-builder">
    <nav class="sdc-crumbs"><a onclick="sdcCancelBuild()">Skill Development Center</a><span>›</span><b>${d.id ? 'Edit course' : 'New course'}</b></nav>
    <div class="sdc-head" style="margin-bottom:14px"><div><h1>${d.id ? 'Edit course' : 'Design a new course'}</h1>
      <p>${d.id ? 'Changes reach learners when you save.' : 'Three steps: the basics, the curriculum, then a last look before it goes out.'}</p></div>
      <div class="sdc-head-actions"><button class="sdc-btn ghost" onclick="sdcCancelBuild()">Cancel</button>
        <button class="sdc-btn" onclick="sdcSaveCourse('Draft')">Save as Draft</button></div></div>
    <div class="sdc-steps" role="tablist">${steps.map(([n, l])=>`<button class="sdc-step ${S.step===n?'on':''} ${S.step>n?'done':''}" onclick="sdcStepTo(${n})">
      <span class="n">${S.step>n ? '✓' : n}</span>${l}</button>`).join('')}</div>
    <div class="sdc-build">
      <div>${S.step === 1 ? sdcStepBasics(d) : S.step === 2 ? sdcStepCurriculum(d) : sdcStepPublish(d)}</div>
      <div class="sdc-preview-col"><span class="label">Live card preview</span><div id="sdcLivePreview">${sdcCardHtml(d, {preview: true})}</div>
        <div class="sdc-stat"><span>Curriculum</span><b style="font-size:15px">${esc(sdcMetaText(d))}</b></div></div>
    </div>
  </div>`;
}
function sdcStepBasics(d){
  const f = (k, label, ph, req) => `<div class="sdc-field"><label>${label}${req ? ' <span class="req">*</span>' : ''}</label>
    <input value="${esc(d[k] || '')}" placeholder="${esc(ph)}" oninput="sdcDraftSet('${k}', this.value)"></div>`;
  return `<div class="sdc-panel"><h3>Basic info</h3><p class="muted">What the course is, who it is for and how it looks in the library.</p>
    <div class="sdc-form">
      <div class="full">${f('title', 'Course title', 'e.g. Financial Planning Foundations', true)}</div>
      <div class="full">${f('subtitle', 'Subtitle', 'One line that sells it — shown on the card')}</div>
      <div class="sdc-field full"><label>Description</label><textarea rows="3" placeholder="What learners will be able to do by the end" oninput="sdcDraftSet('description', this.value)">${esc(d.description || '')}</textarea></div>
      <div class="sdc-field"><label>Category</label><select onchange="sdcDraftSet('category', this.value)">${SDC_CATEGORIES.map(c=>`<option ${d.category===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="sdc-field"><label>Difficulty level</label><select onchange="sdcDraftSet('level', this.value)">${SDC_LEVELS.map(c=>`<option ${d.level===c?'selected':''}>${c}</option>`).join('')}</select></div>
      <div class="sdc-field"><label>Instructor name</label><input value="${esc((d.instructor||{}).name || '')}" placeholder="Who teaches it" oninput="sdcDraftSet('instructor.name', this.value)"></div>
      <div class="sdc-field"><label>Instructor title</label><input value="${esc((d.instructor||{}).title || '')}" placeholder="e.g. Senior Wealth Advisor" oninput="sdcDraftSet('instructor.title', this.value)"></div>
      <div class="sdc-field full"><label>Tags</label><input value="${esc((d.tags || []).join(', '))}" placeholder="Comma separated, e.g. goals, SIP, onboarding" oninput="sdcDraftSet('tags', this.value)">
        <div class="hint">Tags are searchable from the library.</div></div>
      <div class="sdc-field full"><label>Theme colour</label><div class="sdc-swatches">${SDC_COLORS.map(col=>`<button type="button" class="sdc-swatch ${d.color===col?'on':''}" style="background:${col}"
        aria-label="Colour ${col}" onclick="sdcDraftSet('color','${col}', true)"></button>`).join('')}</div></div>
      <div class="sdc-field full"><label>Cover icon</label><div class="sdc-icons">${SDC_ICONS.map(ic=>`<button type="button" class="sdc-icon-btn ${d.icon===ic?'on':''}"
        onclick="sdcDraftSet('icon','${ic}', true)">${ic}</button>`).join('')}</div></div>
      <div class="sdc-field full"><label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" style="width:auto" ${d.sequential?'checked':''}
        onchange="sdcDraftSet('sequential', this.checked)"> Lessons unlock in order (each opens when the one before it is complete)</label></div>
    </div>
    <div class="sdc-build-foot"><span></span><button class="sdc-btn primary" onclick="sdcStepTo(2)">Next: Curriculum →</button></div></div>`;
}
function sdcStepCurriculum(d){
  const S = sdcState(), s = sdcStats(d);
  const mods = d.modules || [];
  return `<div class="sdc-panel"><h3>Curriculum builder</h3><p class="muted">Modules hold lessons. Choose each lesson's type and length; open a lesson to write its notes, takeaways and resources.</p>
    <div class="sdc-totals"><span><b>${s.modules}</b> modules</span><span><b>${s.lessons}</b> lessons</span><span><b>${sdcDur(s.minutes)}</b> total</span></div>
    ${mods.map((m, mi)=>`<div class="sdc-bmod">
      <div class="sdc-bmod-head"><span class="num">MODULE ${mi + 1}</span>
        <input value="${esc(m.title || '')}" placeholder="Module title" oninput="sdcModSet(${mi}, this.value)" aria-label="Module ${mi + 1} title">
        <button class="sdc-ibtn" title="Move up" ${mi===0?'disabled':''} onclick="sdcMoveModule(${mi}, -1)">↑</button>
        <button class="sdc-ibtn" title="Move down" ${mi===mods.length-1?'disabled':''} onclick="sdcMoveModule(${mi}, 1)">↓</button>
        <button class="sdc-ibtn danger" title="Delete module" onclick="sdcDelModule(${mi})">🗑</button></div>
      <div class="sdc-bles">${(m.lessons || []).map((l, li)=>`<div class="sdc-blesson">
        <div class="sdc-blesson-row"><span class="ix">${li + 1}</span>
          <input value="${esc(l.title || '')}" placeholder="Lesson title" oninput="sdcLesSet(${mi}, ${li}, 'title', this.value)" aria-label="Lesson title">
          <select onchange="sdcLesSet(${mi}, ${li}, 'type', this.value, true)" aria-label="Lesson type">${Object.keys(SDC_TYPES).map(t=>`<option value="${t}" ${l.type===t?'selected':''}>${SDC_TYPES[t].icon} ${SDC_TYPES[t].label}</option>`).join('')}</select>
          <input type="number" min="1" max="600" value="${esc(l.minutes || '')}" title="Minutes" oninput="sdcLesSet(${mi}, ${li}, 'minutes', Number(this.value) || 0)" aria-label="Duration in minutes">
          <span class="acts" style="display:flex;gap:2px">
            <button class="sdc-ibtn" title="${S.expand[l.id] ? 'Close content' : 'Edit content'}" onclick="sdcExpand('${l.id}')">${S.expand[l.id] ? '▴' : '✎'}</button>
            <button class="sdc-ibtn" title="Move up" ${li===0?'disabled':''} onclick="sdcMoveLesson(${mi}, ${li}, -1)">↑</button>
            <button class="sdc-ibtn" title="Move down" ${li===m.lessons.length-1?'disabled':''} onclick="sdcMoveLesson(${mi}, ${li}, 1)">↓</button>
            <button class="sdc-ibtn danger" title="Delete lesson" onclick="sdcDelLesson(${mi}, ${li})">✕</button></span></div>
        ${S.expand[l.id] ? `<div class="sdc-blesson-more">
          <div class="sdc-field full"><label>Content summary</label><input value="${esc(l.summary || '')}" placeholder="What this lesson covers, in a sentence" oninput="sdcLesSet(${mi}, ${li}, 'summary', this.value)"></div>
          ${l.type==='Video' ? `<div class="sdc-field full"><label>Video link</label><input value="${esc(l.videoUrl || '')}" placeholder="YouTube link or a .mp4 address" oninput="sdcLesSet(${mi}, ${li}, 'videoUrl', this.value)"></div>` : ''}
          <div class="sdc-field full"><label>Notes</label><textarea rows="5" placeholder="## A heading&#10;A paragraph.&#10;- A bullet&#10;> A tip" oninput="sdcLesSet(${mi}, ${li}, 'body', this.value)">${esc(l.body || '')}</textarea>
            <div class="hint">## heading · - bullet · &gt; tip · **bold**</div></div>
          <div class="sdc-field"><label>Key takeaways</label><textarea rows="3" placeholder="One per line" oninput="sdcLesSet(${mi}, ${li}, 'takeaways', this.value)">${esc((l.takeaways || []).join('\n'))}</textarea></div>
          <div class="sdc-field"><label>Resources</label><textarea rows="3" placeholder="Name | link, one per line" oninput="sdcLesSet(${mi}, ${li}, 'resources', this.value)">${esc((l.resources || []).map(r=>r.name + (r.url ? ' | ' + r.url : '')).join('\n'))}</textarea></div>
        </div>` : ''}
      </div>`).join('')}
        <div class="sdc-add-row"><button class="sdc-dashed" onclick="sdcAddLesson(${mi})">+ Add lesson</button></div></div>
    </div>`).join('')}
    <button class="sdc-dashed" style="padding:12px" onclick="sdcAddModule()">+ Add module</button>
    <div class="sdc-build-foot"><button class="sdc-btn" onclick="sdcStepTo(1)">← Basic info</button><button class="sdc-btn primary" onclick="sdcStepTo(3)">Next: Preview & Publish →</button></div></div>`;
}
function sdcPublishProblems(d){
  const out = [];
  if(!String(d.title || '').trim()) out.push('a title');
  if(!sdcLessons(d).length) out.push('at least one lesson');
  if(sdcLessons(d).some(x=>!String(x.l.title || '').trim())) out.push('a title on every lesson');
  if((d.modules || []).some(m=>!String(m.title || '').trim())) out.push('a title on every module');
  return out;
}
function sdcStepPublish(d){
  const s = sdcStats(d), probs = sdcPublishProblems(d);
  const checks = [
    ['Course has a title', !!String(d.title || '').trim()],
    ['Description written', !!String(d.description || d.subtitle || '').trim()],
    ['At least one module and lesson', s.lessons > 0],
    ['Every module and lesson is named', !sdcLessons(d).some(x=>!String(x.l.title || '').trim()) && !(d.modules || []).some(m=>!String(m.title || '').trim())],
    ['Instructor named', !!String((d.instructor || {}).name || '').trim()],
  ];
  return `<div class="sdc-panel"><h3>Preview &amp; publish</h3><p class="muted">One last look. Published courses appear in everyone's library; drafts only for course managers.</p>
    <div class="sdc-summary"><div><b>${s.modules}</b><span>Modules</span></div><div><b>${s.lessons}</b><span>Lessons</span></div><div><b>${sdcDur(s.minutes)}</b><span>Estimated time</span></div></div>
    <ul class="sdc-check">${checks.map(([l, ok])=>`<li class="${ok ? '' : 'no'}"><span class="b">${ok ? '✓' : '•'}</span>${esc(l)}</li>`).join('')}</ul>
    <div class="sdc-outline">${(d.modules || []).map((m, mi)=>`<div class="m"><span>Module ${mi + 1}: ${esc(m.title || 'Untitled')}</span><span>${sdcDur((m.lessons||[]).reduce((n, l)=>n + (Number(l.minutes)||0), 0))}</span></div>
      ${(m.lessons || []).map(l=>`<div><span>${(SDC_TYPES[l.type]||SDC_TYPES.Article).icon} ${esc(l.title || 'Untitled lesson')}</span><span class="muted">${sdcDur(l.minutes)}</span></div>`).join('')}`).join('')}</div>
    ${probs.length ? `<div class="sdc-preview-bar"><span>To publish, the course still needs ${esc(probs.join(', '))}. You can save it as a draft meanwhile.</span></div>` : ''}
    <div class="sdc-build-foot"><button class="sdc-btn" onclick="sdcStepTo(2)">← Curriculum</button>
      <div style="display:flex;gap:8px"><button class="sdc-btn" onclick="sdcSaveCourse('Draft')">Save as Draft</button>
      <button class="sdc-btn accent" ${probs.length ? 'disabled' : ''} onclick="sdcSaveCourse('Published')">${d.status==='Published' ? 'Save & keep published' : 'Publish course'}</button></div></div></div>`;
}
/* Typing updates the draft and the live card, without redrawing the form
   (which would take the caret out of the box being typed in). */
function sdcLive(){
  const el = document.getElementById('sdcLivePreview');
  if(el) el.innerHTML = sdcCardHtml(window._sdcDraft, {preview: true});
}
function sdcDraftSet(k, v, redraw){
  const d = window._sdcDraft;
  if(k === 'tags') d.tags = String(v).split(',').map(t=>t.trim()).filter(Boolean);
  else if(k.indexOf('instructor.') === 0){ d.instructor = d.instructor || {}; d.instructor[k.split('.')[1]] = v; }
  else d[k] = v;
  d._dirty = true;
  if(redraw) render(); else sdcLive();
}
function sdcModSet(mi, v){ window._sdcDraft.modules[mi].title = v; window._sdcDraft._dirty = true; }
function sdcLesSet(mi, li, k, v, redraw){
  const l = window._sdcDraft.modules[mi].lessons[li];
  if(k === 'takeaways') l.takeaways = String(v).split('\n').map(x=>x.trim()).filter(Boolean);
  else if(k === 'resources') l.resources = String(v).split('\n').map(x=>x.trim()).filter(Boolean).map(x=>{
    const [name, url] = x.split('|').map(y=>y.trim());
    return {name, url: /^https?:\/\//i.test(url || '') ? url : ''};
  });
  else l[k] = v;
  window._sdcDraft._dirty = true;
  if(redraw) render(); else if(k === 'minutes') sdcLive();
}
function sdcExpand(id){ const S = sdcState(); S.expand[id] = !S.expand[id]; render(); }
function sdcAddModule(){
  const d = window._sdcDraft;
  d.modules.push({id: uid('SDM'), title: 'Module ' + (d.modules.length + 1), lessons: [sdcBlankLesson('Article')]});
  d._dirty = true; render();
}
function sdcDelModule(mi){
  const d = window._sdcDraft, m = d.modules[mi];
  if((m.lessons || []).length && !confirm('Delete "' + (m.title || 'this module') + '" and its ' + m.lessons.length + ' lesson(s)?')) return;
  d.modules.splice(mi, 1); d._dirty = true; render();
}
function sdcMoveModule(mi, dir){
  const a = window._sdcDraft.modules, j = mi + dir;
  if(j < 0 || j >= a.length) return;
  [a[mi], a[j]] = [a[j], a[mi]]; window._sdcDraft._dirty = true; render();
}
function sdcAddLesson(mi){ window._sdcDraft.modules[mi].lessons.push(sdcBlankLesson('Article')); window._sdcDraft._dirty = true; render(); }
function sdcDelLesson(mi, li){
  const l = window._sdcDraft.modules[mi].lessons[li];
  if((l.title || l.body) && !confirm('Delete the lesson "' + (l.title || 'untitled') + '"?')) return;
  window._sdcDraft.modules[mi].lessons.splice(li, 1); window._sdcDraft._dirty = true; render();
}
function sdcMoveLesson(mi, li, dir){
  const a = window._sdcDraft.modules[mi].lessons, j = li + dir;
  if(j < 0 || j >= a.length) return;
  [a[li], a[j]] = [a[j], a[li]]; window._sdcDraft._dirty = true; render();
}
function sdcStepTo(n){
  const S = sdcState(), d = window._sdcDraft;
  if(n > 1 && !String(d.title || '').trim()){ alert('Give the course a title first.'); S.step = 1; render(); return; }
  S.step = n; render();
  try { window.scrollTo({top: 0}); } catch(e){}
}
function sdcCancelBuild(){
  const d = window._sdcDraft;
  if(d && d._dirty && !confirm('Leave without saving? The changes made here will be lost.')) return;
  const S = sdcState();
  window._sdcDraft = null;
  if(d && d.id && sdcCourse(d.id)){ S.mode = 'course'; S.courseId = d.id; render(); }
  else sdcHome();
}
async function sdcSaveCourse(status){
  const d = window._sdcDraft;
  if(!d) return;
  if(!String(d.title || '').trim()){ alert('Give the course a title first.'); sdcState().step = 1; render(); return; }
  if(status === 'Published'){
    const probs = sdcPublishProblems(d);
    if(probs.length){ alert('To publish, the course still needs ' + probs.join(', ') + '.'); return; }
  }
  const at = new Date().toISOString(), isNew = !d.id;
  const was = isNew ? null : sdcCourse(d.id);
  const c = JSON.parse(JSON.stringify(d));
  delete c._dirty;
  c.status = status;
  c.updatedAt = at; c.updatedBy = currentUser;
  if(isNew){ c.id = uid('SDC'); c.createdAt = at; c.createdBy = currentUser; }
  if(status === 'Published' && !c.publishedAt) c.publishedAt = at;
  DB.sdcCourses = sdcAll().filter(x=>x.id !== c.id).concat([c]);
  await save('sdcCourses');
  if(typeof logAudit === 'function'){
    await logAudit('Skill Development', c.id, isNew ? 'Course Created' : status === 'Published' && (!was || was.status !== 'Published') ? 'Course Published' : 'Course Updated',
      [{field: 'Course', oldValue: was ? was.title + ' (' + was.status + ')' : '', newValue: c.title + ' (' + status + ') · ' + sdcMetaText(c)}]);
  }
  window._sdcDraft = null;
  const S = sdcState();
  S.mode = 'course'; S.courseId = c.id;
  sdcOpenState(c.id);
  render();
}
async function sdcDuplicate(id){
  const c = sdcCourse(id);
  if(!c || !sdcMayManage()) return;
  const copy = JSON.parse(JSON.stringify(c)), at = new Date().toISOString();
  copy.id = uid('SDC'); copy.title = c.title + ' (Copy)'; copy.status = 'Draft';
  copy.createdAt = at; copy.updatedAt = at; copy.createdBy = currentUser; delete copy.publishedAt;
  copy.modules = (copy.modules || []).map(m=>Object.assign(m, {id: uid('SDM'), lessons: (m.lessons || []).map(l=>Object.assign(l, {id: uid('SDL')}))}));
  DB.sdcCourses = sdcAll().concat([copy]);
  await save('sdcCourses');
  if(typeof logAudit === 'function') await logAudit('Skill Development', copy.id, 'Course Duplicated', [{field: 'From', oldValue: c.title, newValue: copy.title}]);
  render();
}
async function sdcDelete(id){
  const c = sdcCourse(id);
  if(!c || !sdcMayManage()) return;
  if(!confirm('Delete "' + c.title + '"? It leaves the library for everyone. Learners’ progress on it is kept.')) return;
  c.deletedAt = new Date().toISOString(); c.deletedBy = currentUser;
  await save('sdcCourses');
  if(typeof logAudit === 'function') await logAudit('Skill Development', c.id, 'Course Deleted', [{field: 'Course', oldValue: c.title, newValue: 'Deleted'}]);
  const S = sdcState();
  if(S.courseId === id) S.mode = 'library';
  render();
}

/* =====================================================================
   THE STARTING LIBRARY — written for this firm, so the Center opens with
   something worth reading. Seeded once, by a company session, and only
   when the library has never been saved (a reset system stays empty).
   ===================================================================== */
async function sdcEnsureLibrary(){
  if(Array.isArray(DB.sdcCourses)) return;
  DB.sdcCourses = [];
  if(typeof bossRestricted === 'function' && bossRestricted()) return;
  if(DB.systemState && DB.systemState.resetAt) return;
  DB.sdcCourses = sdcSampleCourses();
  await save('sdcCourses');
}
function sdcSampleCourses(){
  const at = new Date().toISOString();
  const L = (title, type, minutes, more) => Object.assign({id: uid('SDL'), title, type, minutes}, more || {});
  const M = (title, lessons) => ({id: uid('SDM'), title, lessons});
  const base = (o) => Object.assign({id: uid('SDC'), status: 'Published', createdAt: at, updatedAt: at, publishedAt: at, createdBy: 'system', tags: []}, o);
  return [
    base({
      title: 'Financial Planning Foundations', icon: '📈', color: '#164B5E', category: 'Technical', level: 'Beginner', sequential: true,
      subtitle: 'From a client’s first conversation to a goal-based plan they understand and act on.',
      description: 'The working method behind every plan the firm writes: how to gather the facts that matter, turn goals into numbers, choose an allocation that fits the client’s risk profile, and present a plan that gets signed. Finishes with a practical project on a real-looking client file.',
      instructor: {name: 'Ananya Rao', title: 'Head of Financial Planning'}, tags: ['goals', 'cash flow', 'asset allocation', 'risk profile', 'SIP'],
      modules: [
        M('Foundations', [
          L('Why goal-based planning works', 'Video', 8, {
            summary: 'Why a plan anchored to the client’s own goals outlasts one built around products.',
            body: '## The problem with product-first advice\nClients who buy products without a plan stop investing at the first market fall. They had no reason to stay.\n## What changes with goals\nWhen every rupee is tied to a goal the client named themselves — a daughter’s education, a house, retiring at 58 — the investment has a job. People keep doing things that have a job.\n- Goals turn a portfolio into a set of promises the client made to themselves\n- They give a natural review rhythm: are we on track for each goal?\n- They make risk a conversation about time, not about fear\n> Ask “what is this money for?” before you ask “how much can you invest?”',
            takeaways: ['Anchor every recommendation to a goal the client named', 'Goals create the reason to stay invested through volatility', 'Time to goal drives the risk you can take'],
            resources: [{name: 'Goal Planning Worksheet.pdf', kind: 'PDF', note: 'Use in the first meeting'}]}),
          L('The fact-find: what to ask, and why', 'Article', 12, {
            summary: 'The minimum set of facts a plan needs, and how to collect them without an interrogation.',
            body: '## Four things every plan needs\n- **Cash flow**: what comes in each month, what goes out, and what is left\n- **Balance sheet**: what they own (and where), what they owe, at what rate\n- **Protection**: life and health cover against the family’s real needs\n- **Goals**: what, when, and how much in today’s money\n## Ask in the order people think\nStart with goals — it is the part clients enjoy. Cash flow and assets follow naturally once they see why you need them.\n> If a number is a guess, write it down as a guess. Precision you do not have is worse than an honest range.\n## Red flags to note\n- No emergency fund, or one held in equity\n- Loans at a rate higher than any return you can promise\n- Cover that ends before the family’s dependence does',
            takeaways: ['Cash flow, balance sheet, protection and goals — in that checklist', 'Start with goals; the numbers follow', 'Record guesses as ranges, not false precision']}),
          L('Knowledge check: foundations', 'Quiz', 6, {
            summary: 'Three questions on why and how we plan.',
            quiz: [
              {q: 'What should the first conversation with a new client focus on?', options: ['The products we offer', 'The client’s goals and what the money is for', 'Last year’s fund returns', 'Their tax bracket'], answer: 1,
               explain: 'Goals come first: they give every later recommendation its reason.'},
              {q: 'Which of these belongs in a fact-find?', options: ['Monthly surplus after expenses', 'The client’s favourite fund house', 'Market predictions', 'The adviser’s targets'], answer: 0,
               explain: 'Cash flow — what is left each month — is one of the four essentials.'},
              {q: 'A client is unsure of their monthly expenses. What do you record?', options: ['Leave it blank', 'Your own estimate', 'Their honest range, marked as an estimate', 'The national average'], answer: 2,
               explain: 'Write down an honest range and say it is one; false precision misleads the plan.'}]}),
        ]),
        M('Core Skills', [
          L('Turning goals into numbers', 'Video', 14, {
            summary: 'Inflating a goal to its future cost, and working back to the monthly SIP that funds it.',
            body: '## Three steps\n- Today’s cost of the goal, in today’s rupees\n- Inflate it to the year the client needs it (education inflation is often 8–10%, not 6%)\n- Work out the monthly investment that reaches it at a return suited to the time horizon\n## A worked example\nA ₹20 lakh education goal in 12 years, at 9% education inflation, costs about ₹56 lakh then. At an assumed 11% return, that needs roughly ₹21,000 a month starting today.\n> Show the client what waiting costs: the same goal started three years later needs about 60% more each month.',
            takeaways: ['Use the inflation rate of the goal, not general inflation', 'Return assumptions must match the horizon', 'The cost of delay is the most persuasive number in the plan'],
            resources: [{name: 'Goal Calculator.xlsx', kind: 'XLSX', note: 'Inflation and SIP calculator'}]}),
          L('Risk profiling that holds up', 'Article', 10, {
            summary: 'Separating risk capacity from risk tolerance, and recording both.',
            body: '## Capacity and tolerance are different\n**Capacity** is how much loss the client’s finances can absorb — set by income stability, dependants, time to goal.\n**Tolerance** is how much loss they can live with emotionally — found through the ISEQ and conversation.\n## When they disagree\nRecommend to the lower of the two, and say why. A client with high tolerance and low capacity needs protecting from their own optimism.\n- Record both scores on the client file\n- Revisit after any major life event',
            takeaways: ['Capacity is financial; tolerance is emotional', 'Recommend to the lower of the two', 'Re-profile after life events']}),
          L('Asset allocation by goal horizon', 'Article', 12, {
            summary: 'A simple, defensible way to set equity, debt and gold weights per goal.',
            body: '## Horizon first\n- Under 3 years: mostly debt and liquid funds — capital must be there when needed\n- 3 to 7 years: a balanced mix, glide toward debt as the date nears\n- Over 7 years: equity-led, within the client’s risk profile\n## Glide paths\nAs a goal comes within three years, move its money from equity to debt in steps, so a late crash cannot derail it.\n> Allocate per goal, then roll the goals up into one portfolio view for the client.',
            takeaways: ['Allocation is set per goal, by time to goal', 'Glide to debt in the last three years', 'Present one consolidated view']}),
          L('Exercise: build an allocation', 'Exercise', 15, {
            summary: 'Allocate three goals for a sample client and justify each weight.',
            body: '## The client\nRohit, 36, salaried, two children (4 and 7). Moderate risk tolerance, high capacity.\n## The goals\n- Emergency fund of ₹4 lakh — now\n- Elder child’s graduation — 11 years\n- Retirement at 58 — 22 years\n## Your task\nFor each goal write the equity / debt / gold split you would recommend, and one sentence on why. Compare with the model answer in the next module’s project brief.',
            takeaways: ['Different goals of the same client get different allocations', 'Every weight needs a one-line reason']}),
        ]),
        M('Practical Project', [
          L('Project brief: the Mehta family plan', 'Resource', 10, {
            summary: 'A complete client file to plan from end to end.',
            body: '## Your brief\nThe Mehtas have completed their FQ, ISEQ and input sheet. Build their plan in BOSS: goals, cash flow ladder, allocation and the execution plan.\n- Use the fact-find in the client file\n- Every goal needs a funded SIP or a lump sum\n- Note one risk the family has not considered',
            resources: [{name: 'Mehta Family — Client File.pdf', kind: 'PDF', note: 'Fact-find, FQ and ISEQ results'}, {name: 'Plan Review Checklist.pdf', kind: 'PDF', note: 'What reviewers look for'}]}),
          L('Presenting the plan', 'Video', 12, {
            summary: 'How to walk a family through their plan so they sign it.',
            body: '## Structure the meeting\n- Remind them of their goals, in their words\n- Show where they stand today — honestly\n- Show the plan, one goal at a time\n- Agree the first three actions and dates\n> Finish with the action, not the summary. A plan without a first step is a document.',
            takeaways: ['Lead with their goals, in their words', 'One goal at a time', 'Close on the first three actions']}),
          L('Final assessment', 'Quiz', 8, {
            summary: 'Check your understanding before you plan for real.',
            quiz: [
              {q: 'A goal is 2 years away. Which allocation fits best?', options: ['80% equity', 'Mostly debt and liquid funds', '100% gold', 'Small-cap funds'], answer: 1, explain: 'Short horizons need capital certainty.'},
              {q: 'Tolerance is high but capacity is low. You recommend to…', options: ['Tolerance', 'Capacity — the lower of the two', 'The average', 'Whatever the client asks'], answer: 1, explain: 'Always the lower of the two.'},
              {q: 'What should the plan presentation end with?', options: ['A recap slide', 'The fee', 'Agreed first actions and dates', 'Market outlook'], answer: 2, explain: 'Close on action.'}]}),
        ]),
      ]}),
    base({
      title: 'Consultative Client Conversations', icon: '💬', color: '#0E7490', category: 'Communication', level: 'Intermediate',
      subtitle: 'Listen first, ask better questions, and handle objections without pressure.',
      description: 'The conversation skills behind discovery calls, review meetings and difficult news — practised on the situations advisers meet every week.',
      instructor: {name: 'Rahul Menon', title: 'Client Experience Lead'}, tags: ['discovery', 'objections', 'listening', 'reviews'],
      modules: [
        M('Listening and discovery', [L('Active listening in practice', 'Video', 12, {summary: 'Reflecting, summarising and the power of the pause.'}),
          L('Questions that open people up', 'Article', 9, {summary: 'Open, probing and confirming questions — and when to use each.'}),
          L('Role-play: the discovery call', 'Exercise', 20, {summary: 'Run a 15-minute discovery call with a colleague using the guide.'})]),
        M('Objections and difficult moments', [L('The four common objections', 'Video', 14, {summary: '“I need to think about it”, fees, past losses and “my cousin handles it”.'}),
          L('Delivering bad news in a review', 'Article', 10, {summary: 'When a goal is off track: how to say it and what to offer.'}),
          L('Check your approach', 'Quiz', 6, {summary: 'Scenarios on objections and empathy.'})]),
      ]}),
    base({
      title: 'Leading High-Performance Advisory Teams', icon: '🧭', color: '#6D28D9', category: 'Leadership', level: 'Advanced',
      subtitle: 'Coaching, pipeline reviews and building a team that grows without you in every meeting.',
      description: 'For team leads and senior partners: setting expectations, running weekly pipeline reviews, coaching through call reviews, and growing new partners into independent advisers.',
      instructor: {name: 'Vikram Sethi', title: 'Regional Director'}, tags: ['coaching', 'pipeline', 'partners', 'team'],
      modules: [
        M('Setting the standard', [L('What good looks like', 'Video', 10, {summary: 'Activity, conversion and client outcomes — the three numbers that matter.'}),
          L('Weekly pipeline reviews', 'Article', 12, {summary: 'A 30-minute review format that finds stuck deals early.'})]),
        M('Coaching', [L('Coaching through call reviews', 'Video', 16, {summary: 'Listening to a call together and giving one piece of feedback.'}),
          L('Growing new partners', 'Article', 11, {summary: 'From shadowing to independent: the first 90 days.'}),
          L('Exercise: your coaching plan', 'Exercise', 25, {summary: 'Write a 30-day plan for one team member.'})]),
        M('Leading through change', [L('Handling a down quarter', 'Video', 9, {summary: 'Keeping morale and activity up when markets fall.'})]),
      ]}),
    base({
      title: 'Designing Client-Ready Reports', icon: '🎨', color: '#BE185D', category: 'Design', level: 'Beginner',
      subtitle: 'Make portfolio reviews and plans clear enough to understand at a glance.',
      description: 'Simple design rules for the documents clients actually read: layout, charts that tell the truth, and plain language for numbers.',
      instructor: {name: 'Meera Kapoor', title: 'Brand & Communications'}, tags: ['reports', 'charts', 'presentation'],
      modules: [
        M('Clarity first', [L('One page, one message', 'Article', 7, {summary: 'Deciding what each page is for before designing it.'}),
          L('Charts that tell the truth', 'Video', 11, {summary: 'Choosing the right chart and avoiding misleading axes.'})]),
        M('Putting it together', [L('Writing numbers in plain language', 'Article', 8, {summary: '“Your SIP is on track to reach ₹56 lakh by 2038.”'}),
          L('Review a real report', 'Exercise', 15, {summary: 'Mark up a sample review and redesign one page.'})]),
      ]}),
    base({
      title: 'SEBI & AMFI Compliance Essentials', icon: '🛡️', color: '#B45309', category: 'Compliance', level: 'Intermediate',
      subtitle: 'The rules every distributor and adviser must follow, explained with examples.',
      description: 'KYC, suitability, disclosure, commissions and record keeping — what the regulations require and how BOSS helps you stay compliant.',
      instructor: {name: 'Sanjay Iyer', title: 'Compliance Officer'}, tags: ['SEBI', 'AMFI', 'KYC', 'ARN', 'EUIN', 'suitability'],
      modules: [
        M('The rules', [L('KYC and client onboarding', 'Article', 10, {summary: 'What must be collected and verified before any transaction.'}),
          L('Suitability and risk disclosure', 'Video', 12, {summary: 'Matching products to the risk profile — and documenting it.'}),
          L('ARN, EUIN and the code of conduct', 'Article', 9, {summary: 'Keeping registrations current and what the code forbids.'})]),
        M('In practice', [L('Record keeping in BOSS', 'Video', 8, {summary: 'Where approvals, consents and documents are kept and for how long.'}),
          L('Compliance check', 'Quiz', 8, {summary: 'Ten scenarios: compliant or not?'})]),
      ]}),
    base({
      title: 'Mutual Fund Product Deep Dive', icon: '🧮', color: '#4338CA', category: 'Technical', level: 'Advanced', status: 'Draft', publishedAt: undefined,
      subtitle: 'Categories, costs, taxation and how to compare schemes properly.',
      description: 'A draft course being prepared by the research desk.',
      instructor: {name: 'Research Desk', title: 'Product Research'}, tags: ['mutual funds', 'taxation', 'TER'],
      modules: [M('Scheme categories', [L('SEBI categorisation explained', 'Article', 12, {summary: 'The 36 categories and what each may hold.'})]),
        M('Comparing schemes', [])]}),
  ];
}
