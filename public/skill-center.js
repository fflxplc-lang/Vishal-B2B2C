/* =====================================================================
   SKILL DEVELOPMENT CENTER — the firm's video-first learning library.

   One route, `skills`, with three faces:
     library   the courses this person has been given, as cards or rows,
               with search (title, tag, instructor), category pills,
               difficulty and status filters
     course    an overview banner, then the HTML5 video player beside the
               module / lesson playlist: thumbnails, durations, done /
               playing / unwatched / locked marks, Mark as Complete (and
               automatic completion when a video is watched to the end),
               Previous / Next, resuming where the learner stopped
     builder   + Add Course (or Edit): Basic info → Curriculum (upload a
               video straight into a lesson, or link one) → Access & Publish,
               with a live card preview the whole way

   Courses are videos with optional notes, takeaways and resources. There
   are no quizzes or tests.

   WHO SEES WHAT. Each course carries an access rule an admin or course
   manager sets (Access & Publish, or ⋯ › Manage Access): all employees and
   partners, employees only, partners only, or specific people. The server
   sends a learner only the published courses their rule lets in and will
   not stream a video from any other (skill-center-server.js). Admins and
   course managers see and manage everything, drafts included.

   Stores, read by loadAll() in index.html:
     sdcCourses   the courses, each with its modules and lessons
     sdcProgress  one row per person per course: lessons finished, the last
                  lesson, and where each video was left (userId owns it)
   Videos and thumbnails are files on the server (/api/sdc/media/…), not
   rows in the store. Styling is skill-center.css, scoped under .sdc.
   ===================================================================== */

const SDC_CATEGORIES = ['Technical', 'Communication', 'Leadership', 'Design', 'Compliance'];
const SDC_LEVELS = ['Beginner', 'Intermediate', 'Advanced'];
/* Lessons are videos first; a reading or a resource can sit beside them. */
const SDC_TYPES = {
  Video:    {label: 'Video',          icon: '▶'},
  Article:  {label: 'Reading',        icon: '📄'},
  Resource: {label: 'PDF / Resource', icon: '📎'},
};
const SDC_ACCESS = [
  ['all',       'All employees & partners', 'Everyone who signs in to BOSS, on either platform.'],
  ['employees', 'Employees only',           'Company staff on the Company Platform. No partners.'],
  ['partners',  'Partners only',            'Partners (L1–L7) and the staff they hired. No employees.'],
  ['selected',  'Specific people',          'Only the employees and partners you pick below.'],
];
const SDC_COLORS = ['#164B5E', '#1E6B85', '#0E7490', '#047857', '#4D7C0F', '#B45309', '#F25C2A', '#BE185D', '#6D28D9', '#4338CA', '#334155'];
const SDC_ICONS = ['📈', '💬', '🧭', '🎨', '🛡️', '🧮', '📚', '🎯', '🤝', '💡', '🏦', '🧠', '📊', '🚀'];
const SDC_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
const SDC_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SDC_VIDEO_MAX_MB = 1024;

/* ---------- reading the stores ---------- */
function sdcAll(){ return Array.isArray(DB.sdcCourses) ? DB.sdcCourses : []; }
function sdcCourses(){ return sdcAll().filter(c=>c && !c.deletedAt); }
function sdcCourse(id){ return sdcCourses().find(c=>c.id===id) || null; }
/* Who builds courses and decides who sees them: an admin, a company person
   with Manage Module Settings, or a partner on L7. The server holds the
   same rule (skill-center-server.js). */
function sdcMayManage(){
  if(typeof bossPartnerSide === 'function' && bossPartnerSide()) return false;
  return isAdmin() || (typeof canAdmin === 'function' && canAdmin('manageModuleSettings'));
}
function sdcAccessOf(c){
  const a = (c && c.access) || {};
  return {mode: SDC_ACCESS.some(x=>x[0]===a.mode) ? a.mode : 'all', users: Array.isArray(a.users) ? a.users : []};
}
/* Whether this person may open a course. The server has already left out
   the ones they may not; this keeps the page honest about it too. */
function sdcCanSee(c){
  if(!c || c.deletedAt) return false;
  if(sdcMayManage()) return true;
  if(c.status !== 'Published') return false;
  const a = sdcAccessOf(c), u = me();
  const partner = typeof isPartnerMember === 'function' && isPartnerMember(u);
  if(a.mode === 'employees') return !partner;
  if(a.mode === 'partners') return partner;
  if(a.mode === 'selected') return a.users.indexOf(currentUser) >= 0;
  return true;
}
function sdcVisible(){ return sdcCourses().filter(sdcCanSee); }
function sdcAccessLabel(c){
  const a = sdcAccessOf(c);
  if(a.mode === 'selected') return a.users.length + (a.users.length === 1 ? ' person' : ' people');
  return {all: 'Everyone', employees: 'Employees only', partners: 'Partners only'}[a.mode];
}
function sdcType(l){ return SDC_TYPES[l && l.type] ? l.type : 'Article'; }
function sdcLessons(c){
  const out = [];
  (c && c.modules || []).forEach((m, mi)=>(m.lessons || []).forEach((l, li)=>out.push({l, m, mi, li})));
  return out;
}
function sdcStats(c){
  const ls = sdcLessons(c);
  return {modules: (c.modules || []).length, lessons: ls.length, videos: ls.filter(x=>sdcType(x.l)==='Video').length,
    minutes: ls.reduce((n, x)=>n + (Number(x.l.minutes) || 0), 0)};
}
function sdcDur(min){
  min = Math.round(Number(min) || 0);
  if(min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h' + (min % 60 ? ' ' + (min % 60) + 'm' : '');
}
/* A video's length as the player shows it: 4:07, 1:02:30. */
function sdcClock(sec){
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function sdcLessonLen(l){ return l.videoSeconds ? sdcClock(l.videoSeconds) : sdcDur(l.minutes); }
function sdcMetaText(c){
  const s = sdcStats(c);
  return s.modules + ' Module' + (s.modules===1?'':'s') + ' • ' + s.lessons + ' Lesson' + (s.lessons===1?'':'s') + ' • ' + sdcDur(s.minutes);
}
function sdcMediaUrl(id){ return id ? '/api/sdc/media/' + encodeURIComponent(id) : ''; }
/* The picture a course shows: its own cover, else the first video's thumbnail. */
function sdcCoverUrl(c){
  if(c.coverId) return sdcMediaUrl(c.coverId);
  const v = sdcLessons(c).find(x=>x.l.posterId);
  return v ? sdcMediaUrl(v.l.posterId) : '';
}

/* ---------- progress, one row per person per course ---------- */
function sdcProgAll(){ return Array.isArray(DB.sdcProgress) ? DB.sdcProgress : (DB.sdcProgress = []); }
function sdcProg(courseId, create){
  const id = currentUser + '|' + courseId;
  let p = sdcProgAll().find(x=>x && x.id===id);
  if(!p && create){
    p = {id, userId: currentUser, courseId, done: {}, pos: {}, lastLessonId: '', startedAt: new Date().toISOString()};
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
/* A course set to unlock in order opens a lesson once every lesson before it is done. */
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
  return `--c:${col};--c-2:${sdcShade(col, -0.35)};--c-soft:rgba(${r},${g},${b},.10);--c-line:rgba(${r},${g},${b},.24);--c-ink:${col}`;
}
function sdcInitials(name){ return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w=>w[0].toUpperCase()).join('') || '?'; }
function sdcLevelHtml(level){
  const n = Math.max(1, SDC_LEVELS.indexOf(level) + 1);
  return `<span class="sdc-level ${esc(level)}"><i>${[1,2,3].map(k=>`<b class="${k<=n?'on':''}"></b>`).join('')}</i>${esc(level || 'Beginner')}</span>`;
}
function sdcFmtBytes(n){
  n = Number(n) || 0;
  if(n >= 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
  if(n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}
const SDC_SVG = {
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg>',
  chev: '<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 6 6 6-6 6"/></svg>',
  play: '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  playSm: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  side: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
  upload: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 16V4M6 10l6-6 6 6"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2Zm-7-2a2 2 0 0 1 4 0v2h-4Z"/></svg>',
  people: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/></svg>',
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
    courseId: null, lessonId: null, preview: false, side: true, open: {}, step: 1, expand: {}, uploads: {}, autoplay: false};
  return window._sdc;
}

/* =====================================================================
   THE ROUTE
   ===================================================================== */
function viewSkillCenter(){
  const S = sdcState();
  // navigate('skills', courseId) opens that course — if it is one they were given.
  if(window._sdcArg){ const id = window._sdcArg; window._sdcArg = null; if(sdcCourse(id) && sdcCanSee(sdcCourse(id))) sdcOpenState(id); }
  if(S.mode === 'builder' && window._sdcDraft) return `<div class="sdc">${sdcBuilderHtml()}</div>`;
  if(S.mode === 'course' && sdcCourse(S.courseId) && sdcCanSee(sdcCourse(S.courseId))){
    setTimeout(sdcWirePlayer, 0);
    return `<div class="sdc">${sdcCourseHtml(sdcCourse(S.courseId))}</div>`;
  }
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
  const pub = all.filter(c=>c.status==='Published');
  const inProg = pub.filter(c=>sdcLearnState(c)==='In Progress').length;
  const done = pub.filter(c=>sdcLearnState(c)==='Completed').length;
  const videos = pub.reduce((n, c)=>n + sdcStats(c).videos, 0);
  const count = k => all.filter(c=>k==='All' || c.category===k).length;
  const statuses = ['All', 'Published', 'Draft', 'In Progress', 'Completed'].filter(s=>sdcMayManage() || s !== 'Draft');
  return `
    <div class="sdc-head">
      <div><h1>Skill Development Center</h1><p>${sdcMayManage() ? 'Browse, manage, and learn structured skill courses.' : 'The courses assigned to you — watch, learn, and track your progress.'}</p></div>
      <div class="sdc-head-actions">
        <label class="sdc-search">${SDC_SVG.search}<input id="sdcSearch" type="search" placeholder="Search courses by title, tag, or instructor" value="${esc(S.q)}"
          oninput="sdcSearch(this.value)" aria-label="Search courses"></label>
        ${sdcMayManage() ? `<button class="sdc-btn primary" onclick="sdcNewCourse()">+ Add Course</button>` : ''}
      </div>
    </div>
    ${all.length ? `<div class="sdc-stats">
      <div class="sdc-stat"><b>${pub.length}</b><span>${sdcMayManage() ? 'Published courses' : 'Courses for you'}</span></div>
      <div class="sdc-stat"><b>${inProg}</b><span>In progress</span></div>
      <div class="sdc-stat"><b>${done}</b><span>Completed</span></div>
      <div class="sdc-stat"><b>${videos}</b><span>Video lessons</span></div>
    </div>` : ''}
    ${all.length ? `<div class="sdc-filters">
      <div class="sdc-pills" role="tablist">${['All'].concat(SDC_CATEGORIES).map(k=>`<button class="sdc-pill ${S.cat===k?'on':''}" role="tab" aria-selected="${S.cat===k}"
        onclick="sdcSet('cat','${k}')">${esc(k)}<span class="n">${count(k)}</span></button>`).join('')}</div>
      <div class="sdc-controls">
        <select class="sdc-select" aria-label="Difficulty" onchange="sdcSet('level', this.value)">
          <option value="">All levels</option>${SDC_LEVELS.map(l=>`<option ${S.level===l?'selected':''}>${l}</option>`).join('')}</select>
        <select class="sdc-select" aria-label="Status" onchange="sdcSet('status', this.value)">
          ${statuses.map(s=>`<option value="${s}" ${S.status===s?'selected':''}>${s==='All'?'All statuses':s}</option>`).join('')}</select>
        <div class="sdc-toggle" role="group" aria-label="Layout">
          <button class="${S.layout==='grid'?'on':''}" title="Grid view" aria-label="Grid view" onclick="sdcSet('layout','grid')">${SDC_SVG.grid}</button>
          <button class="${S.layout==='list'?'on':''}" title="List view" aria-label="List view" onclick="sdcSet('layout','list')">${SDC_SVG.list}</button>
        </div>
      </div>
    </div>` : ''}
    <div id="sdcResults">${sdcResultsHtml()}</div>`;
}
function sdcResultsHtml(){
  const S = sdcState(), list = sdcFiltered();
  if(!sdcVisible().length){
    return sdcMayManage()
      ? `<div class="sdc-empty"><div class="sdc-empty-art">🎬</div><h3>Your library is empty</h3>
          <p>Create the first course: give it a title and a cover, upload its videos into modules and lessons, choose who may see it, and publish.</p>
          <button class="sdc-btn primary" onclick="sdcNewCourse()">+ Add Course</button></div>`
      : `<div class="sdc-empty"><div class="sdc-empty-art">🎓</div><h3>No courses assigned to you yet</h3>
          <p>When your admin gives you access to a course it appears here, ready to watch.</p></div>`;
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
  if(sdcMayManage()) items.unshift(['✏️', 'Edit', `sdcEdit('${c.id}')`], ['👥', 'Manage Access', `sdcManageAccess('${c.id}')`]);
  if(sdcMayManage()) items.push(['⧉', 'Duplicate', `sdcDuplicate('${c.id}')`], ['🗑', 'Delete', `sdcDelete('${c.id}')`, 'danger']);
  return `<details class="sdc-menu" onclick="event.stopPropagation()" ontoggle="sdcMenuToggle(this)"><summary aria-label="Course actions">⋯</summary>
    <div class="sdc-menu-list">${items.map(([i, l, fn, cls])=>`<button class="${cls||''}" onclick="event.stopPropagation(); this.closest('details').open=false; ${fn}">${i} ${l}</button>`).join('')}</div></details>`;
}
function sdcMenuToggle(el){ if(el.open) document.querySelectorAll('.sdc-menu[open]').forEach(d=>{ if(d !== el) d.open = false; }); }
function sdcActionHtml(c){
  const st = sdcLearnState(c), pct = sdcPct(c);
  if(c.status === 'Draft' && !sdcLessons(c).length) return `<span style="flex:1"></span><button class="sdc-btn sm" onclick="event.stopPropagation(); sdcEdit('${c.id}')">Continue building</button>`;
  if(st === 'In Progress') return `<div class="sdc-progress"><div class="sdc-progress-top"><span>Progress</span><b>${pct}%</b></div>
    <div class="sdc-bar"><i style="width:${pct}%"></i></div></div><button class="sdc-btn sm primary" onclick="event.stopPropagation(); sdcOpen('${c.id}')">Resume</button>`;
  if(st === 'Completed') return `<span class="sdc-chip done">✓ Completed</span><span style="flex:1"></span><button class="sdc-btn sm" onclick="event.stopPropagation(); sdcOpen('${c.id}')">Open Course</button>`;
  return `<span style="flex:1"></span><button class="sdc-btn sm primary" onclick="event.stopPropagation(); sdcOpen('${c.id}')">Start Learning</button>`;
}
function sdcCoverHtml(c, cls){
  const url = sdcCoverUrl(c), s = sdcStats(c);
  return `<div class="${cls || 'sdc-cover'} ${url ? 'has-img' : ''}">
    ${url ? `<img src="${esc(url)}" alt="" loading="lazy" onerror="this.remove()">` : `<div class="sdc-cover-icon">${esc(c.icon || '📚')}</div>`}
    ${s.videos ? `<span class="sdc-cover-play" aria-hidden="true">${SDC_SVG.play}</span><span class="sdc-cover-len">${SDC_SVG.playSm} ${s.videos} video${s.videos===1?'':'s'} · ${sdcDur(s.minutes)}</span>` : ''}
  </div>`;
}
function sdcCardHtml(c, opts){
  opts = opts || {};
  const ins = c.instructor || {};
  return `<article class="sdc-card" style="${sdcVars(c)}" tabindex="0" ${opts.preview ? '' : `onclick="sdcOpen('${c.id}')" onkeydown="if(event.key==='Enter') sdcOpen('${c.id}')"`}
      aria-label="${esc(c.title || 'Untitled course')}">
    <div class="sdc-cover-wrap">${sdcCoverHtml(c)}
      <div class="sdc-badges"><span class="sdc-chip">${esc(c.category || 'Technical')}</span>${c.status==='Draft' ? '<span class="sdc-chip draft">Draft</span>' : ''}
        ${sdcMayManage() ? `<span class="sdc-chip dark" title="Who can open it">${SDC_SVG.people} ${esc(sdcAccessLabel(c))}</span>` : ''}</div>
      ${opts.preview ? '' : sdcMenuHtml(c)}</div>
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
    ${sdcCoverHtml(c, 'sdc-thumb')}
    <div><h3 class="sdc-title">${esc(c.title)} ${c.status==='Draft' ? '<span class="sdc-chip draft">Draft</span>' : ''}</h3><p class="sdc-desc">${esc(c.subtitle || '')}</p></div>
    <div class="hide-sm"><div class="sdc-meta">${esc(c.category)} <span class="dot">•</span> ${sdcLevelHtml(c.level)}${sdcMayManage() ? ` <span class="dot">•</span> ${esc(sdcAccessLabel(c))}` : ''}</div>
      <div class="sdc-meta" style="margin-top:4px">${esc(sdcMetaText(c))}</div></div>
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
   COURSE: overview banner, video player, playlist
   ===================================================================== */
function sdcOpenState(id, preview){
  const S = sdcState(), c = sdcCourse(id);
  if(!c) return;
  S.mode = 'course'; S.courseId = id; S.preview = !!preview;
  const ls = sdcLessons(c), p = sdcProg(id);
  const resume = p && p.lastLessonId && ls.find(x=>x.l.id===p.lastLessonId);
  const firstOpen = ls.find(x=>!sdcIsDone(c, x.l.id) && !sdcLocked(c, x.l.id));
  S.lessonId = (resume || firstOpen || ls[0] || {l: {}}).l.id || null;
  S.open = {};
  const cur = ls.find(x=>x.l.id===S.lessonId);
  (c.modules || []).forEach((m, i)=>{ S.open[m.id] = cur ? cur.m.id === m.id : i === 0; });
}
function sdcOpen(id, preview){
  const c = sdcCourse(id);
  if(!c || !sdcCanSee(c)){ alert('That course has not been assigned to you.'); return; }
  sdcOpenState(id, preview);
  if(typeof currentView !== 'undefined' && currentView !== 'skills') navigate('skills');
  else render();
  try { window.scrollTo({top: 0}); } catch(e){}
}
function sdcCourseHtml(c){
  const S = sdcState(), ins = c.instructor || {}, pct = sdcPct(c), st = sdcLearnState(c);
  const ls = sdcLessons(c);
  const cur = ls.find(x=>x.l.id===S.lessonId) || ls[0];
  const cta = !ls.length ? '' : st === 'Not started' ? 'Start Course' : st === 'Completed' ? 'Watch Again' : 'Continue Learning';
  return `<div style="${sdcVars(c)}">
    ${S.preview ? `<div class="sdc-preview-bar"><span>👁 <b>Preview</b> — you are seeing this course as a learner would. Nothing you watch here is recorded.</span>
      <button class="sdc-btn sm" onclick="sdcOpen('${c.id}')">Exit preview</button></div>` : ''}
    <nav class="sdc-crumbs" aria-label="Breadcrumb"><a onclick="sdcHome()">Skill Development Center</a><span>›</span>
      <a onclick="sdcState().cat='${esc(c.category)}'; sdcHome()">${esc(c.category)}</a><span>›</span><b>${esc(c.title)}</b></nav>
    <section class="sdc-hero">
      <div class="sdc-hero-top"><span class="sdc-chip">${esc(c.icon || '📚')} ${esc(c.category)}</span><span class="sdc-chip">${esc(c.level || 'Beginner')}</span>
        ${c.status==='Draft' ? '<span class="sdc-chip draft">Draft</span>' : ''}${c.sequential ? `<span class="sdc-chip dark">${SDC_SVG.lock} Lessons unlock in order</span>` : ''}
        ${sdcMayManage() ? `<span class="sdc-chip dark">${SDC_SVG.people} ${esc(sdcAccessLabel(c))}</span>` : ''}</div>
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
        ${sdcMayManage() ? `<button class="sdc-btn glass" onclick="sdcEdit('${c.id}')">✏️ Edit course</button><button class="sdc-btn glass" onclick="sdcManageAccess('${c.id}')">👥 Manage Access</button>` : ''}
      </div>
    </section>
    ${ls.length ? `<div class="sdc-learn ${S.side ? '' : 'no-side'}" id="sdcLearn">
      <div id="sdcViewer">${sdcViewerHtml(c, cur)}</div>
      ${sdcSyllabusHtml(c)}
    </div>` : `<div class="sdc-empty"><div class="sdc-empty-art">🎬</div><h3>No lessons yet</h3><p>This course has no videos yet.</p>
      ${sdcMayManage() ? `<button class="sdc-btn primary" onclick="sdcEdit('${c.id}', 2)">Add videos to the curriculum</button>` : ''}</div>`}
  </div>`;
}
function sdcContinue(){
  const S = sdcState(), c = sdcCourse(S.courseId);
  const ls = sdcLessons(c);
  const next = ls.find(x=>!sdcIsDone(c, x.l.id) && !sdcLocked(c, x.l.id)) || ls[0];
  if(next) sdcGo(next.l.id);
  setTimeout(()=>{ const el = document.getElementById('sdcViewer'); if(el) el.scrollIntoView({behavior: 'smooth', block: 'start'}); }, 30);
}
/* A lesson's small picture in the playlist: its thumbnail, or the course colour with its type. */
function sdcThumbHtml(l, extra){
  const poster = l.posterId ? sdcMediaUrl(l.posterId) : '';
  return `<span class="sdc-lthumb ${poster ? 'has-img' : ''}">${poster ? `<img src="${esc(poster)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
    <span class="ico">${sdcType(l)==='Video' ? SDC_SVG.playSm : (SDC_TYPES[sdcType(l)].icon)}</span>${extra || ''}</span>`;
}
function sdcSyllabusHtml(c){
  const S = sdcState(), ls = sdcLessons(c);
  const doneN = ls.filter(x=>sdcIsDone(c, x.l.id)).length;
  return `<aside class="sdc-syllabus" id="sdcSyllabus" aria-label="Course playlist">
    <div class="sdc-syl-head"><div><h3>Course content</h3><span>${doneN} of ${ls.length} lessons complete · ${sdcDur(sdcStats(c).minutes)}</span></div>
      <button class="sdc-ibtn" title="Hide course content" aria-label="Hide course content" onclick="sdcSet('side', false)">✕</button></div>
    <div class="sdc-syl-body">${(c.modules || []).map((m, mi)=>{
      const mls = m.lessons || [];
      const md = mls.filter(l=>sdcIsDone(c, l.id)).length;
      const mpct = mls.length ? Math.round(100 * md / mls.length) : 0;
      const open = !!S.open[m.id];
      return `<div class="sdc-mod ${open ? 'open' : ''}">
        <button class="sdc-mod-head" aria-expanded="${open}" onclick="sdcToggleModule('${m.id}')">${SDC_SVG.chev}
          <span class="t"><b>Module ${mi + 1}: ${esc(m.title || 'Untitled module')}</b><span>${mls.length} lesson${mls.length===1?'':'s'} • ${sdcDur(mls.reduce((n, l)=>n + (Number(l.minutes) || 0), 0))}</span></span>
          ${sdcRing(mpct)}</button>
        <div class="sdc-lessons">${mls.map(l=>{
          const done = sdcIsDone(c, l.id), active = l.id === S.lessonId, locked = !done && sdcLocked(c, l.id);
          const mark = done ? '<span class="sdc-lmark done" title="Completed">✓</span>' : locked ? `<span class="sdc-lmark lock" title="Locked">${SDC_SVG.lock}</span>` : '';
          return `<button class="sdc-les ${active ? 'active' : ''} ${locked ? 'locked' : ''} ${done ? 'is-done' : ''}" onclick="sdcGo('${l.id}')" aria-current="${active}">
            ${sdcThumbHtml(l, mark + `<span class="len">${esc(sdcLessonLen(l))}</span>`)}
            <span class="nm">${active ? '<small class="now">Now playing</small>' : ''}${esc(l.title || 'Untitled lesson')}<small>${esc(SDC_TYPES[sdcType(l)].label)}${done ? ' · Completed' : ''}</small></span></button>`;
        }).join('') || '<div class="muted" style="font-size:12.5px;padding:6px 14px">No lessons in this module yet.</div>'}</div>
      </div>`;
    }).join('')}</div>
  </aside>`;
}
function sdcToggleModule(id){ const S = sdcState(); S.open[id] = !S.open[id]; sdcRedrawSide(); }
/* The playlist redraws on its own, so a playing video is not interrupted. */
function sdcRedrawSide(){
  const S = sdcState(), c = sdcCourse(S.courseId);
  const el = document.getElementById('sdcSyllabus');
  if(!c || !el){ render(); return; }
  el.outerHTML = sdcSyllabusHtml(c);
}
function sdcGo(lessonId, autoplay){
  const S = sdcState(), c = sdcCourse(S.courseId);
  if(!c) return;
  sdcSavePos();
  S.lessonId = lessonId;
  S.autoplay = !!autoplay;
  const x = sdcLessons(c).find(y=>y.l.id===lessonId);
  if(x) S.open[x.m.id] = true;
  // Opening a lesson is where the learner is: remembered, unless previewing or locked.
  if(!S.preview && x && !(sdcLocked(c, lessonId) && !sdcMayManage())){
    const p = sdcProg(c.id, true);
    if(p.lastLessonId !== lessonId){ p.lastLessonId = lessonId; p.updatedAt = new Date().toISOString(); save('sdcProgress'); }
  }
  // Only the player and the playlist change: no jump back to the top of the page.
  const v = document.getElementById('sdcViewer');
  if(v && x){
    v.innerHTML = sdcViewerHtml(c, x);
    sdcRedrawSide();
    setTimeout(sdcWirePlayer, 0);
  } else render();
}
function sdcViewerHtml(c, x){
  const S = sdcState();
  if(!x) return '';
  const l = x.l, ls = sdcLessons(c), i = ls.findIndex(y=>y.l.id===l.id);
  const prev = ls[i - 1], next = ls[i + 1];
  const done = sdcIsDone(c, l.id), locked = !done && sdcLocked(c, l.id);
  const type = sdcType(l), t = SDC_TYPES[type];
  const head = `<div class="sdc-viewer-head"><div style="min-width:0">
      <div class="where">Module ${x.mi + 1} · Lesson ${x.li + 1} of ${(x.m.lessons || []).length}</div>
      <h2>${esc(l.title || 'Untitled lesson')}</h2>
      <div class="sdc-meta" style="margin-top:8px"><span class="sdc-type ${esc(type)}">${t.icon} ${esc(t.label)}</span><span>⏱ ${esc(sdcLessonLen(l))}</span>
        ${done ? '<span class="sdc-chip done">✓ Completed</span>' : ''}</div></div>
    ${S.side ? '' : `<button class="sdc-btn sm" onclick="sdcSet('side', true)">${SDC_SVG.side} Course content</button>`}</div>`;
  if(locked && !sdcMayManage()){
    return `<div class="sdc-viewer">${head}<div class="sdc-locked"><div class="ico">🔒</div><h3 style="margin:0 0 6px">This lesson is locked</h3>
      <p class="muted" style="margin:0 0 16px">Lessons in this course open in order. Finish the one before it to unlock it.</p>
      ${prev ? `<button class="sdc-btn primary" onclick="sdcGo('${prev.l.id}')">← Go to the previous lesson</button>` : ''}</div></div>`;
  }
  const lockNote = locked ? `<div class="sdc-preview-bar" style="margin-bottom:16px"><span>🔒 Locked for learners until the lessons before it are done — you can open it because you manage courses.</span></div>` : '';
  return `<div class="sdc-viewer" data-lesson="${esc(l.id)}">${head}
    ${type === 'Video' ? sdcPlayerHtml(c, l, next) : ''}
    <div class="sdc-viewer-body">${lockNote}
      ${l.summary && !l.body ? `<div class="sdc-rich"><p>${esc(l.summary)}</p></div>` : ''}
      ${l.body ? `<div class="sdc-rich">${sdcRich(l.body)}</div>` : ''}
      ${!l.body && !l.summary && type !== 'Video' ? `<p class="muted">No notes have been written for this lesson yet.</p>` : ''}
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
/* The video, played here: an uploaded file or a hosted .mp4/.webm in the
   page's own HTML5 player; a YouTube link embedded; nothing yet, a clean
   placeholder that says so. */
function sdcPlayerHtml(c, l, next){
  const url = String(l.videoUrl || '').trim();
  const poster = l.posterId ? sdcMediaUrl(l.posterId) : '';
  const yt = !l.videoId && url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,})/);
  if(yt) return `<div class="sdc-player"><iframe src="https://www.youtube-nocookie.com/embed/${esc(yt[1])}" title="${esc(l.title)}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  const src = l.videoId ? sdcMediaUrl(l.videoId) : (/^https?:\/\/.+\.(mp4|webm|ogv|ogg|mov)(\?.*)?$/i.test(url) ? url : '');
  if(!src){
    return `<div class="sdc-player empty">${poster ? `<img class="poster" src="${esc(poster)}" alt="">` : ''}
      <div class="sdc-player-empty"><span class="play">${SDC_SVG.play}</span>
        <b>${url ? 'This lesson links to a video elsewhere' : 'Video coming soon'}</b>
        <span>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open the video ↗</a>` : sdcMayManage() ? 'Upload it in the course builder: Edit course › Curriculum.' : 'The video for this lesson has not been uploaded yet.'}</span></div>
      <span class="sdc-vdur">${esc(sdcLessonLen(l))}</span></div>`;
  }
  return `<div class="sdc-player" id="sdcPlayer">
    <video id="sdcVideo" data-lesson="${esc(l.id)}" controls playsinline preload="metadata" ${poster ? `poster="${esc(poster)}"` : ''}
      controlslist="nodownload" src="${esc(src)}"></video>
    <span class="sdc-vdur" id="sdcVdur">${esc(sdcLessonLen(l))}</span>
    <div class="sdc-ended" id="sdcEnded" hidden>
      <div class="sdc-ended-card"><div class="tick">✓</div><b>${sdcState().preview ? 'Finished (preview — not recorded)' : 'Lesson complete'}</b>
        ${next ? `<span>Up next · ${esc(next.l.title || 'Next lesson')}</span>` : '<span>That was the last lesson of the course.</span>'}
        <div class="acts">${next ? `<button class="sdc-btn light" onclick="sdcGo('${next.l.id}', true)">▶ Play next</button>` : ''}
          <button class="sdc-btn glass" onclick="sdcReplay()">↺ Replay</button></div></div></div>
  </div>`;
}
/* Wiring the player after it is drawn: resume where the learner stopped,
   mark the lesson complete once it is watched to the end (or 95% of it),
   and remember the position when they pause or move on. */
function sdcWirePlayer(){
  const v = document.getElementById('sdcVideo');
  if(!v || v._sdcWired) return;
  v._sdcWired = true;
  const S = sdcState(), lid = v.dataset.lesson;
  const p = sdcProg(S.courseId);
  const c = sdcCourse(S.courseId), lesson = c && (sdcLessons(c).find(x=>x.l.id===lid) || {}).l;
  /* A file with no length in its header (a WEBM recorded in a browser)
     plays with an unknown duration; the length measured when it was
     uploaded stands in for it. */
  const length = () => (isFinite(v.duration) && v.duration > 0) ? v.duration : Number((lesson || {}).videoSeconds) || 0;
  v.addEventListener('loadedmetadata', ()=>{
    const d = length();
    const badge = document.getElementById('sdcVdur');
    if(badge && d) badge.textContent = sdcClock(d);
    const at = p && p.pos && Number(p.pos[lid]);
    if(at && d && at < d - 5) { try { v.currentTime = at; } catch(e){} }
    if(S.autoplay){ S.autoplay = false; const pr = v.play(); if(pr && pr.catch) pr.catch(()=>{}); }
  });
  v.addEventListener('play', ()=>{ const pl = document.getElementById('sdcPlayer'); if(pl) pl.classList.add('playing'); const e = document.getElementById('sdcEnded'); if(e) e.hidden = true; });
  v.addEventListener('pause', ()=>sdcSavePos(true));
  v.addEventListener('timeupdate', ()=>{
    S._pos = {lid, t: v.currentTime};
    const d = length();
    if(d > 0 && v.currentTime / d >= 0.95) sdcAutoComplete(lid);
    // Near the end of a file whose length the browser never learned, the
    // closing screen comes when the measured length is reached.
    if(!isFinite(v.duration) && d > 0 && v.currentTime >= d - 0.25 && !v._sdcEndShown){ v._sdcEndShown = true; v.dispatchEvent(new Event('sdcend')); }
  });
  const onEnd = ()=>{
    sdcAutoComplete(lid);
    const pl = document.getElementById('sdcPlayer'); if(pl) pl.classList.remove('playing');
    const e = document.getElementById('sdcEnded'); if(e) e.hidden = false;
  };
  v.addEventListener('ended', onEnd);
  v.addEventListener('sdcend', onEnd);
}
function sdcReplay(){
  const v = document.getElementById('sdcVideo'), e = document.getElementById('sdcEnded');
  if(e) e.hidden = true;
  if(v){ v._sdcEndShown = false; v.currentTime = 0; const pr = v.play(); if(pr && pr.catch) pr.catch(()=>{}); }
}
/* Where the video was left, kept on the learner's progress row. */
function sdcSavePos(persist){
  const S = sdcState();
  if(S.preview || !S._pos || !S.courseId) return;
  const p = sdcProg(S.courseId, true);
  p.pos = p.pos || {};
  const t = Math.floor(S._pos.t || 0);
  if(p.pos[S._pos.lid] === t) return;
  p.pos[S._pos.lid] = t;
  if(persist) save('sdcProgress');
}
/* Watched to the end: complete, without stopping the video to redraw the page. */
async function sdcAutoComplete(lid){
  const S = sdcState(), c = sdcCourse(S.courseId);
  if(!c || S.preview || sdcIsDone(c, lid) || S._completing === lid) return;
  S._completing = lid;
  const p = sdcProg(c.id, true);
  p.done = p.done || {};
  p.done[lid] = new Date().toISOString();
  p.updatedAt = p.done[lid];
  if(sdcPct(c) >= 100 && !p.completedAt) p.completedAt = p.updatedAt;
  await save('sdcProgress');
  S._completing = null;
  const btn = document.querySelector('.sdc-done-btn');
  if(btn){ btn.classList.add('on'); btn.textContent = '✓ Completed'; }
  sdcRedrawSide();
  sdcRedrawHeroProgress(c);
}
function sdcRedrawHeroProgress(c){
  const pct = sdcPct(c);
  const b = document.querySelector('.sdc-hero-progress .sdc-progress-top b'), bar = document.querySelector('.sdc-hero-progress .sdc-bar > i');
  if(b) b.textContent = pct + '%';
  if(bar) bar.style.width = pct + '%';
}
function sdcResourcesHtml(c, l){
  const res = (l.resources || []).filter(r=>r && r.name);
  if(!res.length && !l.body && !(l.takeaways || []).length) return '';
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
async function sdcToggleDone(lessonId){
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
  if(sdcPct(c) >= 100 && p.completedAt === p.updatedAt) setTimeout(()=>alert('🎉 Course complete: ' + c.title + '. Well done.'), 50);
}

/* =====================================================================
   ACCESS — who may open a course. Used by the builder's last step and by
   ⋯ › Manage Access; the same editor, pointed at a different course.
   ===================================================================== */
function sdcPeople(){
  return (DB.team || []).filter(t=>t && t.id && !t.deletedAt && !t.directoryOnly && (typeof isMemberActive !== 'function' || isMemberActive(t)))
    .slice().sort((a, b)=>String(a.name || '').localeCompare(String(b.name || '')));
}
function sdcPersonKind(t){ return t.partnerPobId ? 'Partner' : t.partnerTeamOf ? 'Partner staff' : 'Employee'; }
function sdcPersonSub(t){
  if(t.partnerPobId) return 'Partner' + (t.partnerLevel ? ' · ' + t.partnerLevel : '');
  if(t.partnerTeamOf) return 'Partner staff' + (t.partnerStaffRole ? ' · ' + t.partnerStaffRole : '');
  return (t.designation || t.role || 'Employee') + (t.branch ? ' · ' + t.branch : '');
}
/* The access being edited: the builder's draft, or a copy for the modal. */
function sdcAccEdit(){ const S = sdcState(); return S.accTarget === 'draft' ? (window._sdcDraft.access = window._sdcDraft.access || {mode: 'all', users: []}) : window._sdcAcc; }
function sdcAccessEditorHtml(){
  const a = sdcAccEdit(), S = sdcState();
  a.users = Array.isArray(a.users) ? a.users : [];
  return `<div class="sdc-access" id="sdcAccEditor">
    <div class="sdc-acc-modes" role="radiogroup">${SDC_ACCESS.map(([k, l, d])=>`<label class="sdc-acc-mode ${a.mode===k?'on':''}">
      <input type="radio" name="sdcAccMode" value="${k}" ${a.mode===k?'checked':''} onchange="sdcAccMode('${k}')">
      <span><b>${esc(l)}</b><small>${esc(d)}</small></span></label>`).join('')}</div>
    ${a.mode === 'selected' ? `<div class="sdc-acc-pick">
      <div class="sdc-acc-bar"><label class="sdc-search sm">${SDC_SVG.search}<input id="sdcAccQ" type="search" placeholder="Search people by name, role or branch" value="${esc(S.accQ || '')}"
        oninput="sdcAccSearch(this.value)"></label>
        <select class="sdc-select" onchange="sdcAccKind(this.value)">${['All people', 'Employees', 'Partners'].map(o=>`<option ${(S.accKind||'All people')===o?'selected':''}>${o}</option>`).join('')}</select></div>
      <div class="sdc-acc-count"><b id="sdcAccN">${a.users.length}</b> selected · <a onclick="sdcAccAll(true)">Select all shown</a> · <a onclick="sdcAccAll(false)">Clear shown</a></div>
      <div class="sdc-acc-list" id="sdcAccList">${sdcAccListHtml()}</div></div>` : ''}
  </div>`;
}
function sdcAccShown(){
  const S = sdcState(), q = String(S.accQ || '').trim().toLowerCase(), kind = S.accKind || 'All people';
  return sdcPeople().filter(t=>{
    const k = sdcPersonKind(t);
    if(kind === 'Employees' && k !== 'Employee') return false;
    if(kind === 'Partners' && k === 'Employee') return false;
    return !q || [t.name, t.email, sdcPersonSub(t)].join(' ').toLowerCase().indexOf(q) >= 0;
  });
}
function sdcAccListHtml(){
  const a = sdcAccEdit(), shown = sdcAccShown();
  if(!shown.length) return `<div class="muted" style="padding:14px;font-size:13px">Nobody matches.</div>`;
  return shown.map(t=>`<label class="sdc-acc-person"><input type="checkbox" value="${esc(t.id)}" ${a.users.indexOf(t.id) >= 0 ? 'checked' : ''}
      onchange="sdcAccToggle('${esc(t.id)}', this.checked)">
    <span class="sdc-avatar" style="--c:${t.partnerPobId || t.partnerTeamOf ? '#B45309' : '#164B5E'}">${esc(sdcInitials(t.name))}</span>
    <span class="who"><b>${esc(t.name || '')}</b><small>${esc(sdcPersonSub(t))}</small></span>
    <span class="sdc-chip ${sdcPersonKind(t) === 'Employee' ? '' : 'draft'}">${esc(sdcPersonKind(t))}</span></label>`).join('');
}
/* The builder's summary and live card follow the access being chosen. */
function sdcAccSummary(){
  if(sdcState().accTarget !== 'draft' || !window._sdcDraft) return;
  const st = document.getElementById('sdcAccStat'); if(st) st.textContent = sdcAccessLabel(window._sdcDraft);
  sdcLive();
}
function sdcAccMode(k){
  const a = sdcAccEdit(); a.mode = k;
  if(sdcState().accTarget === 'draft') window._sdcDraft._dirty = true;
  const el = document.getElementById('sdcAccEditor');
  if(el) el.outerHTML = sdcAccessEditorHtml();
  sdcAccSummary();
}
function sdcAccSearch(v){ sdcState().accQ = v; const el = document.getElementById('sdcAccList'); if(el) el.innerHTML = sdcAccListHtml(); }
function sdcAccKind(v){ sdcState().accKind = v; const el = document.getElementById('sdcAccList'); if(el) el.innerHTML = sdcAccListHtml(); }
function sdcAccToggle(id, on){
  const a = sdcAccEdit();
  a.users = a.users.filter(x=>x !== id);
  if(on) a.users.push(id);
  if(sdcState().accTarget === 'draft') window._sdcDraft._dirty = true;
  const n = document.getElementById('sdcAccN'); if(n) n.textContent = a.users.length;
  sdcAccSummary();
}
function sdcAccAll(on){
  const a = sdcAccEdit(), ids = sdcAccShown().map(t=>t.id);
  a.users = a.users.filter(x=>ids.indexOf(x) < 0).concat(on ? ids : []);
  const el = document.getElementById('sdcAccList'); if(el) el.innerHTML = sdcAccListHtml();
  const n = document.getElementById('sdcAccN'); if(n) n.textContent = a.users.length;
  sdcAccSummary();
}
/* ⋯ › Manage Access. */
function sdcManageAccess(id){
  const c = sdcCourse(id);
  if(!c || !sdcMayManage()) return;
  const S = sdcState();
  S.accTarget = id; S.accQ = ''; S.accKind = 'All people';
  window._sdcAcc = JSON.parse(JSON.stringify(sdcAccessOf(c)));
  openModal('Manage Access — ' + (c.title || 'course'),
    `<p class="small-note" style="margin-top:0">Choose who can find and watch this course. Admins and course managers always see every course.${c.status === 'Draft' ? ' It is a <b>draft</b>: nobody else sees it until it is published.' : ''}</p>`
      + `<div class="sdc">${sdcAccessEditorHtml()}</div>`,
    `<button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="sdcSaveAccess('${esc(id)}')">Save access</button>`);
}
function sdcAccessProblem(a){ return a.mode === 'selected' && !a.users.length ? 'Pick at least one person, or choose another option.' : ''; }
async function sdcSaveAccess(id){
  const c = sdcCourse(id), a = window._sdcAcc;
  if(!c || !a) return;
  const bad = sdcAccessProblem(a);
  if(bad){ alert(bad); return; }
  const was = sdcAccessLabel(c);
  c.access = a.mode === 'selected' ? {mode: 'selected', users: a.users.slice()} : {mode: a.mode};
  c.updatedAt = new Date().toISOString(); c.updatedBy = currentUser;
  await save('sdcCourses');
  if(typeof logAudit === 'function') await logAudit('Skill Development', c.id, 'Course Access Changed', [{field: 'Who can open it', oldValue: was, newValue: sdcAccessLabel(c)}]);
  window._sdcAcc = null;
  closeModal(); render();
}

/* =====================================================================
   UPLOADS — a video or an image, streamed to the server as it is
   (POST /api/sdc/media), with progress. Used by the lesson editor; kept
   apart from any page so a dedicated upload screen can reuse it later.
   ===================================================================== */
function sdcUploadMedia(blob, kind, name, onProgress){
  return new Promise((resolve, reject)=>{
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sdc/media?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name || ''));
    const h = typeof apiHeaders === 'function' ? apiHeaders() : {};
    Object.keys(h).forEach(k=>xhr.setRequestHeader(k, h[k]));
    xhr.setRequestHeader('Content-Type', blob.type || (kind === 'image' ? 'image/jpeg' : 'video/mp4'));
    if(xhr.upload && onProgress) xhr.upload.onprogress = e=>{ if(e.lengthComputable) onProgress(Math.round(100 * e.loaded / e.total)); };
    xhr.onload = ()=>{
      let r = {}; try { r = JSON.parse(xhr.responseText); } catch(e){}
      if(xhr.status >= 200 && xhr.status < 300 && r.ok) resolve(r); else reject(new Error(r.message || ('the server refused (' + xhr.status + ')')));
    };
    xhr.onerror = ()=>reject(new Error('the connection dropped'));
    xhr.send(blob);
  });
}
/* A video's length and a thumbnail from one of its frames, read in the
   browser before it is uploaded. A recording with no length in its header
   (as browsers write WEBM) is sought to the end to find it. */
function sdcProbeVideo(blob){
  return new Promise(resolve=>{
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    let done = false, seconds = 0;
    const finish = poster => { if(done) return; done = true; URL.revokeObjectURL(url); resolve({seconds, poster}); };
    const timer = setTimeout(()=>finish(null), 15000);
    const grab = () => {
      try {
        const w = Math.min(960, v.videoWidth || 640), h = Math.round(w * ((v.videoHeight || 360) / (v.videoWidth || 640)));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(v, 0, 0, w, h);
        cv.toBlob(b=>{ clearTimeout(timer); finish(b); }, 'image/jpeg', 0.84);
      } catch(e){ clearTimeout(timer); finish(null); }
    };
    v.addEventListener('error', ()=>{ clearTimeout(timer); finish(null); });
    v.addEventListener('loadedmetadata', ()=>{
      const seekFrame = () => { v.addEventListener('seeked', grab, {once: true}); v.currentTime = Math.min(1, seconds / 3 || 0); };
      if(isFinite(v.duration) && v.duration > 0){ seconds = v.duration; seekFrame(); return; }
      v.addEventListener('durationchange', function once(){
        if(!isFinite(v.duration)) return;
        v.removeEventListener('durationchange', once);
        seconds = v.duration;
        v.addEventListener('seeked', ()=>seekFrame(), {once: true});
        v.currentTime = 0;
      });
      v.currentTime = 1e7;
    });
  });
}
/* Attach a video file to a lesson of the draft: probe, upload the video and
   its thumbnail, and fill in the lesson's length. */
async function sdcAttachVideo(mi, li, file){
  const S = sdcState(), d = window._sdcDraft;
  const l = d && d.modules[mi] && d.modules[mi].lessons[li];
  if(!l) return null;
  const type = String(file.type || '').toLowerCase().split(';')[0];
  if(SDC_VIDEO_TYPES.indexOf(type) < 0){ alert('Upload an MP4, WEBM, OGG or MOV video.'); return null; }
  if(file.size > SDC_VIDEO_MAX_MB * 1048576){ alert('That video is larger than ' + SDC_VIDEO_MAX_MB + ' MB.'); return null; }
  S.uploads[l.id] = {pct: 0, name: file.name || 'video'};
  if(S.mode === 'builder') render();
  try {
    const probe = await sdcProbeVideo(file);
    const up = await sdcUploadMedia(file, 'video', file.name || 'video', pct=>{ S.uploads[l.id].pct = pct; sdcUploadProgress(l.id, pct); });
    let posterId = l.posterCustom ? l.posterId : '';
    if(!posterId && probe.poster){
      try { posterId = (await sdcUploadMedia(probe.poster, 'image', (file.name || 'video') + '.jpg')).id; } catch(e){ posterId = ''; }
    }
    Object.assign(l, {type: 'Video', videoId: up.id, videoName: file.name || 'video', videoSize: up.size, videoMime: up.mime,
      videoSeconds: probe.seconds ? Math.round(probe.seconds) : 0, posterId: posterId || l.posterId || ''});
    if(probe.seconds) l.minutes = Math.max(1, Math.round(probe.seconds / 60));
    delete l.videoUrl;
    if(!l.title) l.title = String(file.name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    d._dirty = true;
    return up;
  } catch(e){
    alert('The video could not be uploaded: ' + e.message);
    return null;
  } finally {
    delete S.uploads[l.id];
    if(sdcState().mode === 'builder') render();
  }
}
function sdcPickVideo(mi, li, input){ const f = input.files && input.files[0]; if(f) sdcAttachVideo(mi, li, f); input.value = ''; }
async function sdcPickPoster(mi, li, input){
  const f = input.files && input.files[0]; input.value = '';
  if(!f) return;
  if(SDC_IMAGE_TYPES.indexOf(String(f.type).toLowerCase()) < 0){ alert('A thumbnail has to be a JPG, PNG or WEBP image.'); return; }
  try {
    const up = await sdcUploadMedia(f, 'image', f.name);
    const l = window._sdcDraft.modules[mi].lessons[li];
    l.posterId = up.id; l.posterCustom = true; window._sdcDraft._dirty = true; render();
  } catch(e){ alert('The thumbnail could not be uploaded: ' + e.message); }
}
async function sdcPickCover(input){
  const f = input.files && input.files[0]; input.value = '';
  if(!f) return;
  if(SDC_IMAGE_TYPES.indexOf(String(f.type).toLowerCase()) < 0){ alert('A cover has to be a JPG, PNG or WEBP image.'); return; }
  try { const up = await sdcUploadMedia(f, 'image', f.name); window._sdcDraft.coverId = up.id; window._sdcDraft._dirty = true; render(); }
  catch(e){ alert('The cover could not be uploaded: ' + e.message); }
}
function sdcRemoveVideo(mi, li){
  const l = window._sdcDraft.modules[mi].lessons[li];
  if(!confirm('Remove the video from "' + (l.title || 'this lesson') + '"? The lesson stays.')) return;
  ['videoId', 'videoName', 'videoSize', 'videoMime', 'videoSeconds'].forEach(k=>delete l[k]);
  if(!l.posterCustom) delete l.posterId;
  window._sdcDraft._dirty = true; render();
}
function sdcUploadProgress(lid, pct){
  const bar = document.getElementById('sdcUpBar_' + lid), txt = document.getElementById('sdcUpTxt_' + lid);
  if(bar) bar.style.width = pct + '%';
  if(txt) txt.textContent = pct + '%';
}

/* =====================================================================
   BUILDER: Basic info → Curriculum → Access & Publish
   ===================================================================== */
function sdcBlank(){
  return {id: '', title: '', subtitle: '', description: '', category: 'Technical', level: 'Beginner',
    instructor: {name: (me() || {}).name || '', title: ''}, color: SDC_COLORS[0], icon: '📚', tags: [], sequential: false,
    status: 'Draft', access: {mode: 'all', users: []},
    modules: [{id: uid('SDM'), title: 'Module 1: Foundations', lessons: [sdcBlankLesson()]}]};
}
function sdcBlankLesson(type){ return {id: uid('SDL'), title: '', type: type || 'Video', minutes: 10, summary: ''}; }
function sdcNewCourse(){
  if(!sdcMayManage()){ alert('Only an admin, or someone with Manage Module Settings, can build courses.'); return; }
  window._sdcDraft = sdcBlank();
  Object.assign(sdcState(), {mode: 'builder', step: 1, expand: {}, accTarget: 'draft', accQ: '', accKind: 'All people'});
  if(typeof currentView !== 'undefined' && currentView !== 'skills') navigate('skills'); else render();
}
function sdcEdit(id, step){
  if(!sdcMayManage()){ alert('Only an admin, or someone with Manage Module Settings, can edit courses.'); return; }
  const c = sdcCourse(id);
  if(!c) return;
  window._sdcDraft = JSON.parse(JSON.stringify(c));
  window._sdcDraft.access = sdcAccessOf(c);
  Object.assign(sdcState(), {mode: 'builder', step: step || 1, expand: {}, accTarget: 'draft', accQ: '', accKind: 'All people'});
  if(typeof currentView !== 'undefined' && currentView !== 'skills') navigate('skills'); else render();
}
function sdcBuilderHtml(){
  const S = sdcState(), d = window._sdcDraft;
  S.accTarget = 'draft';
  const steps = [[1, 'Basic Info'], [2, 'Curriculum'], [3, 'Access & Publish']];
  const busy = Object.keys(S.uploads || {}).length;
  return `<div class="sdc-builder">
    <nav class="sdc-crumbs"><a onclick="sdcCancelBuild()">Skill Development Center</a><span>›</span><b>${d.id ? 'Edit course' : 'New course'}</b></nav>
    <div class="sdc-head" style="margin-bottom:14px"><div><h1>${d.id ? 'Edit course' : 'Design a new course'}</h1>
      <p>${d.id ? 'Changes reach learners when you save.' : 'Three steps: the basics, the videos, then who may watch it.'}</p></div>
      <div class="sdc-head-actions"><button class="sdc-btn ghost" onclick="sdcCancelBuild()">Cancel</button>
        <button class="sdc-btn" ${busy ? 'disabled title="Wait for the upload to finish"' : ''} onclick="sdcSaveCourse('Draft')">Save as Draft</button></div></div>
    <div class="sdc-steps" role="tablist">${steps.map(([n, l])=>`<button class="sdc-step ${S.step===n?'on':''} ${S.step>n?'done':''}" onclick="sdcStepTo(${n})">
      <span class="n">${S.step>n ? '✓' : n}</span>${l}</button>`).join('')}</div>
    <div class="sdc-build">
      <div>${S.step === 1 ? sdcStepBasics(d) : S.step === 2 ? sdcStepCurriculum(d) : sdcStepPublish(d)}</div>
      <div class="sdc-preview-col"><span class="label">Live card preview</span><div id="sdcLivePreview">${sdcCardHtml(d, {preview: true})}</div>
        <div class="sdc-stat"><span>Curriculum</span><b style="font-size:15px">${esc(sdcMetaText(d))}</b></div>
        <div class="sdc-stat"><span>Who can open it</span><b style="font-size:15px" id="sdcAccStat">${esc(sdcAccessLabel(d))}</b></div></div>
    </div>
  </div>`;
}
function sdcStepBasics(d){
  const f = (k, label, ph, req) => `<div class="sdc-field"><label>${label}${req ? ' <span class="req">*</span>' : ''}</label>
    <input value="${esc(d[k] || '')}" placeholder="${esc(ph)}" oninput="sdcDraftSet('${k}', this.value)"></div>`;
  return `<div class="sdc-panel"><h3>Basic info</h3><p class="muted">What the course is, who teaches it and how it looks in the library.</p>
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
      <div class="sdc-field full"><label>Cover image</label>
        <div class="sdc-cover-pick">${d.coverId ? `<img src="${esc(sdcMediaUrl(d.coverId))}" alt="">` : `<span class="muted">No cover uploaded — the first video's thumbnail, or the colour and icon below, are used.</span>`}
          <label class="sdc-btn sm">${d.coverId ? 'Replace' : 'Upload cover'}<input type="file" accept="image/jpeg,image/png,image/webp" hidden onchange="sdcPickCover(this)"></label>
          ${d.coverId ? `<button class="sdc-btn sm ghost" onclick="window._sdcDraft.coverId=''; window._sdcDraft._dirty=true; render()">Remove</button>` : ''}</div></div>
      <div class="sdc-field full"><label>Theme colour</label><div class="sdc-swatches">${SDC_COLORS.map(col=>`<button type="button" class="sdc-swatch ${d.color===col?'on':''}" style="background:${col}"
        aria-label="Colour ${col}" onclick="sdcDraftSet('color','${col}', true)"></button>`).join('')}</div></div>
      <div class="sdc-field full"><label>Cover icon</label><div class="sdc-icons">${SDC_ICONS.map(ic=>`<button type="button" class="sdc-icon-btn ${d.icon===ic?'on':''}"
        onclick="sdcDraftSet('icon','${ic}', true)">${ic}</button>`).join('')}</div></div>
      <div class="sdc-field full"><label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" style="width:auto" ${d.sequential?'checked':''}
        onchange="sdcDraftSet('sequential', this.checked)"> Lessons unlock in order (each opens when the one before it is complete)</label></div>
    </div>
    <div class="sdc-build-foot"><span></span><button class="sdc-btn primary" onclick="sdcStepTo(2)">Next: Curriculum →</button></div></div>`;
}
/* The video part of a video lesson's editor: upload, progress, the attached
   file with its thumbnail, or a link to a video hosted elsewhere. */
function sdcVideoEditorHtml(l, mi, li){
  const S = sdcState(), up = S.uploads[l.id];
  if(up) return `<div class="sdc-vup busy"><div class="sdc-vup-row"><span class="sdc-vup-ico">${SDC_SVG.upload}</span>
      <span class="who"><b>Uploading ${esc(up.name)}</b><small id="sdcUpTxt_${esc(l.id)}">${up.pct}%</small></span></div>
      <div class="sdc-bar"><i id="sdcUpBar_${esc(l.id)}" style="width:${up.pct}%"></i></div></div>`;
  if(l.videoId) return `<div class="sdc-vup has">
      <span class="sdc-lthumb lg ${l.posterId ? 'has-img' : ''}">${l.posterId ? `<img src="${esc(sdcMediaUrl(l.posterId))}" alt="">` : ''}<span class="ico">${SDC_SVG.playSm}</span>
        ${l.videoSeconds ? `<span class="len">${esc(sdcClock(l.videoSeconds))}</span>` : ''}</span>
      <span class="who"><b>${esc(l.videoName || 'Uploaded video')}</b><small>${esc([l.videoSize ? sdcFmtBytes(l.videoSize) : '', l.videoSeconds ? sdcClock(l.videoSeconds) : '', (l.videoMime || '').replace('video/', '').toUpperCase()].filter(Boolean).join(' · '))}</small>
        <span class="acts"><label class="sdc-btn sm">Replace video<input type="file" accept="video/mp4,video/webm,video/ogg,video/quicktime" hidden onchange="sdcPickVideo(${mi}, ${li}, this)"></label>
          <label class="sdc-btn sm">${l.posterCustom ? 'Replace thumbnail' : 'Upload thumbnail'}<input type="file" accept="image/jpeg,image/png,image/webp" hidden onchange="sdcPickPoster(${mi}, ${li}, this)"></label>
          <button class="sdc-btn sm ghost danger" onclick="sdcRemoveVideo(${mi}, ${li})">Remove</button></span></span></div>`;
  return `<div class="sdc-vup">
      <label class="sdc-drop"><input type="file" accept="video/mp4,video/webm,video/ogg,video/quicktime" hidden onchange="sdcPickVideo(${mi}, ${li}, this)">
        <span class="sdc-vup-ico">${SDC_SVG.upload}</span><b>Upload a video</b><small>MP4, WEBM, OGG or MOV · up to ${SDC_VIDEO_MAX_MB} MB · its length and a thumbnail are taken from the file</small></label>
      <div class="sdc-field" style="margin-top:10px"><label>…or link a hosted video</label><input value="${esc(l.videoUrl || '')}" placeholder="YouTube link, or an address ending .mp4 / .webm"
        oninput="sdcLesSet(${mi}, ${li}, 'videoUrl', this.value)"></div></div>`;
}
function sdcStepCurriculum(d){
  const S = sdcState(), s = sdcStats(d);
  const mods = d.modules || [];
  return `<div class="sdc-panel"><h3>Curriculum builder</h3><p class="muted">Modules hold lessons. Upload each lesson's video right here; open a lesson to add notes, takeaways and resources.</p>
    <div class="sdc-totals"><span><b>${s.modules}</b> modules</span><span><b>${s.lessons}</b> lessons</span><span><b>${s.videos}</b> videos</span><span><b>${sdcDur(s.minutes)}</b> total</span></div>
    ${mods.map((m, mi)=>`<div class="sdc-bmod">
      <div class="sdc-bmod-head"><span class="num">MODULE ${mi + 1}</span>
        <input value="${esc(m.title || '')}" placeholder="Module title" oninput="sdcModSet(${mi}, this.value)" aria-label="Module ${mi + 1} title">
        <button class="sdc-ibtn" title="Move up" ${mi===0?'disabled':''} onclick="sdcMoveModule(${mi}, -1)">↑</button>
        <button class="sdc-ibtn" title="Move down" ${mi===mods.length-1?'disabled':''} onclick="sdcMoveModule(${mi}, 1)">↓</button>
        <button class="sdc-ibtn danger" title="Delete module" onclick="sdcDelModule(${mi})">🗑</button></div>
      <div class="sdc-bles">${(m.lessons || []).map((l, li)=>`<div class="sdc-blesson">
        <div class="sdc-blesson-row"><span class="ix">${li + 1}</span>
          <input value="${esc(l.title || '')}" placeholder="Lesson title" oninput="sdcLesSet(${mi}, ${li}, 'title', this.value)" aria-label="Lesson title">
          <select onchange="sdcLesSet(${mi}, ${li}, 'type', this.value, true)" aria-label="Lesson type">${Object.keys(SDC_TYPES).map(t=>`<option value="${t}" ${sdcType(l)===t?'selected':''}>${SDC_TYPES[t].icon} ${SDC_TYPES[t].label}</option>`).join('')}</select>
          <input type="number" min="1" max="600" value="${esc(l.minutes || '')}" title="${l.videoSeconds ? 'Taken from the video' : 'Minutes'}" oninput="sdcLesSet(${mi}, ${li}, 'minutes', Number(this.value) || 0)" aria-label="Duration in minutes" ${l.videoSeconds ? 'disabled' : ''}>
          <span class="acts" style="display:flex;gap:2px">
            <button class="sdc-ibtn" title="${S.expand[l.id] ? 'Close' : 'Video, notes and resources'}" onclick="sdcExpand('${l.id}')">${S.expand[l.id] ? '▴' : '✎'}</button>
            <button class="sdc-ibtn" title="Move up" ${li===0?'disabled':''} onclick="sdcMoveLesson(${mi}, ${li}, -1)">↑</button>
            <button class="sdc-ibtn" title="Move down" ${li===m.lessons.length-1?'disabled':''} onclick="sdcMoveLesson(${mi}, ${li}, 1)">↓</button>
            <button class="sdc-ibtn danger" title="Delete lesson" onclick="sdcDelLesson(${mi}, ${li})">✕</button></span></div>
        ${sdcType(l) === 'Video' && !S.expand[l.id] ? `<div class="sdc-blesson-vid">${l.videoId ? `🎬 ${esc(l.videoName || 'Video attached')}${l.videoSeconds ? ' · ' + esc(sdcClock(l.videoSeconds)) : ''}` : l.videoUrl ? '🔗 Linked video' : S.uploads[l.id] ? 'Uploading… ' + S.uploads[l.id].pct + '%' : '<span class="muted">No video yet</span>'}
          <button class="sdc-btn sm ghost" onclick="sdcExpand('${l.id}')">${l.videoId || l.videoUrl ? 'Change' : 'Add video'}</button></div>` : ''}
        ${S.expand[l.id] ? `<div class="sdc-blesson-more">
          ${sdcType(l) === 'Video' ? `<div class="full">${sdcVideoEditorHtml(l, mi, li)}</div>` : ''}
          <div class="sdc-field full"><label>Content summary</label><input value="${esc(l.summary || '')}" placeholder="What this lesson covers, in a sentence" oninput="sdcLesSet(${mi}, ${li}, 'summary', this.value)"></div>
          <div class="sdc-field full"><label>Notes (optional)</label><textarea rows="4" placeholder="## A heading&#10;A paragraph.&#10;- A bullet&#10;> A tip" oninput="sdcLesSet(${mi}, ${li}, 'body', this.value)">${esc(l.body || '')}</textarea>
            <div class="hint">## heading · - bullet · &gt; tip · **bold**</div></div>
          <div class="sdc-field"><label>Key takeaways</label><textarea rows="3" placeholder="One per line" oninput="sdcLesSet(${mi}, ${li}, 'takeaways', this.value)">${esc((l.takeaways || []).join('\n'))}</textarea></div>
          <div class="sdc-field"><label>Resources</label><textarea rows="3" placeholder="Name | link, one per line" oninput="sdcLesSet(${mi}, ${li}, 'resources', this.value)">${esc((l.resources || []).map(r=>r.name + (r.url ? ' | ' + r.url : '')).join('\n'))}</textarea></div>
        </div>` : ''}
      </div>`).join('')}
        <div class="sdc-add-row"><button class="sdc-dashed" onclick="sdcAddLesson(${mi})">+ Add lesson</button></div></div>
    </div>`).join('')}
    <button class="sdc-dashed" style="padding:12px" onclick="sdcAddModule()">+ Add module</button>
    <div class="sdc-build-foot"><button class="sdc-btn" onclick="sdcStepTo(1)">← Basic info</button><button class="sdc-btn primary" onclick="sdcStepTo(3)">Next: Access & Publish →</button></div></div>`;
}
function sdcPublishProblems(d){
  const out = [];
  if(!String(d.title || '').trim()) out.push('a title');
  if(!sdcLessons(d).length) out.push('at least one lesson');
  if(sdcLessons(d).some(x=>!String(x.l.title || '').trim())) out.push('a title on every lesson');
  if((d.modules || []).some(m=>!String(m.title || '').trim())) out.push('a title on every module');
  if(sdcAccessProblem(sdcAccessOf(d))) out.push('at least one person to give it to');
  return out;
}
function sdcStepPublish(d){
  const S = sdcState(), s = sdcStats(d), probs = sdcPublishProblems(d);
  const noVideo = sdcLessons(d).filter(x=>sdcType(x.l)==='Video' && !x.l.videoId && !x.l.videoUrl).length;
  const checks = [
    ['Course has a title', !!String(d.title || '').trim()],
    ['Description written', !!String(d.description || d.subtitle || '').trim()],
    ['At least one module and lesson', s.lessons > 0],
    ['Every module and lesson is named', !sdcLessons(d).some(x=>!String(x.l.title || '').trim()) && !(d.modules || []).some(m=>!String(m.title || '').trim())],
    ['Every video lesson has its video', s.videos > 0 && !noVideo],
    ['Access chosen', !sdcAccessProblem(sdcAccessOf(d))],
  ];
  return `<div class="sdc-panel"><h3>Who can access this course</h3><p class="muted">Admins and course managers always see every course. Everybody else sees it only if this lets them in.</p>
    ${sdcAccessEditorHtml()}
  </div>
  <div class="sdc-panel" style="margin-top:16px"><h3>Preview &amp; publish</h3><p class="muted">One last look. A draft is seen only by course managers until you publish it.</p>
    <div class="sdc-summary"><div><b>${s.modules}</b><span>Modules</span></div><div><b>${s.videos}</b><span>Videos</span></div><div><b>${sdcDur(s.minutes)}</b><span>Estimated time</span></div></div>
    <ul class="sdc-check">${checks.map(([l, ok])=>`<li class="${ok ? '' : 'no'}"><span class="b">${ok ? '✓' : '•'}</span>${esc(l)}</li>`).join('')}</ul>
    <div class="sdc-outline">${(d.modules || []).map((m, mi)=>`<div class="m"><span>Module ${mi + 1}: ${esc(m.title || 'Untitled')}</span><span>${sdcDur((m.lessons||[]).reduce((n, l)=>n + (Number(l.minutes)||0), 0))}</span></div>
      ${(m.lessons || []).map(l=>`<div><span>${SDC_TYPES[sdcType(l)].icon} ${esc(l.title || 'Untitled lesson')}${sdcType(l)==='Video' && !l.videoId && !l.videoUrl ? ' <span class="sdc-chip draft">no video yet</span>' : ''}</span><span class="muted">${esc(sdcLessonLen(l))}</span></div>`).join('')}`).join('')}</div>
    ${probs.length ? `<div class="sdc-preview-bar"><span>To publish, the course still needs ${esc(probs.join(', '))}. You can save it as a draft meanwhile.</span></div>`
      : noVideo ? `<div class="sdc-preview-bar"><span>${noVideo} video lesson${noVideo===1?' has':'s have'} no video yet. Learners will see "Video coming soon" there until you upload ${noVideo===1?'it':'them'}.</span></div>` : ''}
    <div class="sdc-build-foot"><button class="sdc-btn" onclick="sdcStepTo(2)">← Curriculum</button>
      <div style="display:flex;gap:8px"><button class="sdc-btn" onclick="sdcSaveCourse('Draft')">Save as Draft</button>
      <button class="sdc-btn accent" ${probs.length || Object.keys(S.uploads||{}).length ? 'disabled' : ''} onclick="sdcSaveCourse('Published')">${d.status==='Published' ? 'Save & keep published' : 'Publish course'}</button></div></div></div>`;
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
  if(redraw) render(); else if(k === 'minutes' || k === 'title') sdcLive();
}
function sdcExpand(id){ const S = sdcState(); S.expand[id] = !S.expand[id]; render(); }
function sdcAddModule(){
  const d = window._sdcDraft;
  d.modules.push({id: uid('SDM'), title: 'Module ' + (d.modules.length + 1), lessons: [sdcBlankLesson('Video')]});
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
function sdcAddLesson(mi){ window._sdcDraft.modules[mi].lessons.push(sdcBlankLesson('Video')); window._sdcDraft._dirty = true; render(); }
function sdcDelLesson(mi, li){
  const l = window._sdcDraft.modules[mi].lessons[li];
  if((l.title || l.body || l.videoId) && !confirm('Delete the lesson "' + (l.title || 'untitled') + '"?')) return;
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
  const d = window._sdcDraft, S = sdcState();
  if(!d) return;
  if(Object.keys(S.uploads || {}).length){ alert('Wait for the upload to finish first.'); return; }
  if(!String(d.title || '').trim()){ alert('Give the course a title first.'); S.step = 1; render(); return; }
  if(status === 'Published'){
    const probs = sdcPublishProblems(d);
    if(probs.length){ alert('To publish, the course still needs ' + probs.join(', ') + '.'); return; }
  }
  const at = new Date().toISOString(), isNew = !d.id;
  const was = isNew ? null : sdcCourse(d.id);
  const c = JSON.parse(JSON.stringify(d));
  delete c._dirty;
  const a = sdcAccessOf(c);
  c.access = a.mode === 'selected' ? {mode: 'selected', users: a.users.slice()} : {mode: a.mode};
  c.status = status;
  c.updatedAt = at; c.updatedBy = currentUser;
  if(isNew){ c.id = uid('SDC'); c.createdAt = at; c.createdBy = currentUser; }
  if(status === 'Published' && !c.publishedAt) c.publishedAt = at;
  DB.sdcCourses = sdcAll().filter(x=>x.id !== c.id).concat([c]);
  await save('sdcCourses');
  if(typeof logAudit === 'function'){
    await logAudit('Skill Development', c.id, isNew ? 'Course Created' : status === 'Published' && (!was || was.status !== 'Published') ? 'Course Published' : 'Course Updated',
      [{field: 'Course', oldValue: was ? was.title + ' (' + was.status + ', ' + sdcAccessLabel(was) + ')' : '', newValue: c.title + ' (' + status + ', ' + sdcAccessLabel(c) + ') · ' + sdcMetaText(c)}]);
  }
  window._sdcDraft = null;
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
  // The copy shares the uploaded files; its modules and lessons get ids of their own.
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
   THE STARTING LIBRARY — video courses written for this firm, so the
   Center opens with something to show. Seeded once, by an admin's
   session, only when the library has never been saved (a reset system
   stays empty). The videos themselves are uploaded by the firm.
   ===================================================================== */
async function sdcEnsureLibrary(){
  const admin = !!window.CRM_IS_ADMIN && !(typeof bossPartnerSide === 'function' && bossPartnerSide());
  if(!Array.isArray(DB.sdcCourses)){
    DB.sdcCourses = [];
    if(!admin || (DB.systemState && DB.systemState.resetAt)) return;
    DB.sdcCourses = sdcSampleCourses();
    await save('sdcCourses');
    return;
  }
  // Quizzes and exercises are gone (courses are video-first): quiz lessons
  // leave the library and an exercise becomes a reading, once.
  if(!admin) return;
  let changed = false;
  DB.sdcCourses.forEach(c=>(c.modules || []).forEach(m=>{
    const before = (m.lessons || []).length;
    m.lessons = (m.lessons || []).filter(l=>l && l.type !== 'Quiz');
    if(m.lessons.length !== before) changed = true;
    m.lessons.forEach(l=>{ if(l.quiz){ delete l.quiz; changed = true; } if(!SDC_TYPES[l.type]){ l.type = 'Article'; changed = true; } });
  }));
  if(changed) await save('sdcCourses');
}
function sdcSampleCourses(){
  const at = new Date().toISOString();
  const V = (title, minutes, more) => Object.assign({id: uid('SDL'), title, type: 'Video', minutes}, more || {});
  const R = (title, minutes, more) => Object.assign({id: uid('SDL'), title, type: 'Article', minutes}, more || {});
  const F = (title, minutes, more) => Object.assign({id: uid('SDL'), title, type: 'Resource', minutes}, more || {});
  const M = (title, lessons) => ({id: uid('SDM'), title, lessons});
  const base = (o) => Object.assign({id: uid('SDC'), status: 'Published', access: {mode: 'all'}, createdAt: at, updatedAt: at, publishedAt: at, createdBy: 'system', tags: []}, o);
  return [
    base({
      title: 'Financial Planning Foundations', icon: '📈', color: '#164B5E', category: 'Technical', level: 'Beginner', sequential: true,
      subtitle: 'From a client’s first conversation to a goal-based plan they understand and act on.',
      description: 'The working method behind every plan the firm writes: how to gather the facts that matter, turn goals into numbers, choose an allocation that fits the client’s risk profile, and present a plan that gets signed. Short videos with notes, ending with a full walkthrough of a real-looking client plan.',
      instructor: {name: 'Ananya Rao', title: 'Head of Financial Planning'}, tags: ['goals', 'cash flow', 'asset allocation', 'risk profile', 'SIP'],
      modules: [
        M('Foundations', [
          V('Why goal-based planning works', 8, {
            summary: 'Why a plan anchored to the client’s own goals outlasts one built around products.',
            body: '## The problem with product-first advice\nClients who buy products without a plan stop investing at the first market fall. They had no reason to stay.\n## What changes with goals\nWhen every rupee is tied to a goal the client named themselves — a daughter’s education, a house, retiring at 58 — the investment has a job. People keep doing things that have a job.\n- Goals turn a portfolio into a set of promises the client made to themselves\n- They give a natural review rhythm: are we on track for each goal?\n- They make risk a conversation about time, not about fear\n> Ask “what is this money for?” before you ask “how much can you invest?”',
            takeaways: ['Anchor every recommendation to a goal the client named', 'Goals create the reason to stay invested through volatility', 'Time to goal drives the risk you can take'],
            resources: [{name: 'Goal Planning Worksheet.pdf', kind: 'PDF', note: 'Use in the first meeting'}]}),
          V('The fact-find: what to ask, and why', 12, {
            summary: 'The minimum set of facts a plan needs, and how to collect them without an interrogation.',
            body: '## Four things every plan needs\n- **Cash flow**: what comes in each month, what goes out, and what is left\n- **Balance sheet**: what they own (and where), what they owe, at what rate\n- **Protection**: life and health cover against the family’s real needs\n- **Goals**: what, when, and how much in today’s money\n## Ask in the order people think\nStart with goals — it is the part clients enjoy. Cash flow and assets follow naturally once they see why you need them.\n> If a number is a guess, write it down as a guess. Precision you do not have is worse than an honest range.',
            takeaways: ['Cash flow, balance sheet, protection and goals — in that checklist', 'Start with goals; the numbers follow', 'Record guesses as ranges, not false precision']}),
          F('Fact-find checklist', 4, {
            summary: 'A one-page checklist to keep beside you in a first meeting.',
            body: '## Before the meeting\n- Send the FQ link a day ahead\n- Read the input sheet if it is back\n## In the meeting\n- Goals, in the client’s words\n- Monthly surplus, emergency fund, loans\n- Existing cover and nominees',
            resources: [{name: 'Fact-find Checklist.pdf', kind: 'PDF', note: 'Print-ready'}]}),
        ]),
        M('Core Skills', [
          V('Turning goals into numbers', 14, {
            summary: 'Inflating a goal to its future cost, and working back to the monthly SIP that funds it.',
            body: '## Three steps\n- Today’s cost of the goal, in today’s rupees\n- Inflate it to the year the client needs it (education inflation is often 8–10%, not 6%)\n- Work out the monthly investment that reaches it at a return suited to the time horizon\n## A worked example\nA ₹20 lakh education goal in 12 years, at 9% education inflation, costs about ₹56 lakh then. At an assumed 11% return, that needs roughly ₹21,000 a month starting today.\n> Show the client what waiting costs: the same goal started three years later needs about 60% more each month.',
            takeaways: ['Use the inflation rate of the goal, not general inflation', 'Return assumptions must match the horizon', 'The cost of delay is the most persuasive number in the plan'],
            resources: [{name: 'Goal Calculator.xlsx', kind: 'XLSX', note: 'Inflation and SIP calculator'}]}),
          V('Risk profiling that holds up', 10, {
            summary: 'Separating risk capacity from risk tolerance, and recording both.',
            body: '## Capacity and tolerance are different\n**Capacity** is how much loss the client’s finances can absorb — set by income stability, dependants, time to goal.\n**Tolerance** is how much loss they can live with emotionally — found through the ISEQ and conversation.\n## When they disagree\nRecommend to the lower of the two, and say why.',
            takeaways: ['Capacity is financial; tolerance is emotional', 'Recommend to the lower of the two', 'Re-profile after life events']}),
          V('Asset allocation by goal horizon', 12, {
            summary: 'A simple, defensible way to set equity, debt and gold weights per goal.',
            body: '## Horizon first\n- Under 3 years: mostly debt and liquid funds\n- 3 to 7 years: a balanced mix, gliding toward debt as the date nears\n- Over 7 years: equity-led, within the client’s risk profile\n> Allocate per goal, then roll the goals up into one portfolio view for the client.',
            takeaways: ['Allocation is set per goal, by time to goal', 'Glide to debt in the last three years', 'Present one consolidated view']}),
          V('Worked example: Rohit’s three goals', 15, {
            summary: 'Allocating an emergency fund, a graduation goal and retirement for one client, step by step.',
            body: '## The client\nRohit, 36, salaried, two children (4 and 7). Moderate risk tolerance, high capacity.\n## The goals\n- Emergency fund of ₹4 lakh — now\n- Elder child’s graduation — 11 years\n- Retirement at 58 — 22 years\n## What the video shows\nEach goal gets its own split and a one-line reason, then the three roll up into one portfolio.',
            takeaways: ['Different goals of the same client get different allocations', 'Every weight needs a one-line reason']}),
        ]),
        M('Practical Project', [
          F('Project brief: the Mehta family plan', 6, {
            summary: 'A complete client file to plan from end to end.',
            body: '## Your brief\nThe Mehtas have completed their FQ, ISEQ and input sheet. Build their plan in BOSS: goals, cash flow ladder, allocation and the execution plan.\n- Use the fact-find in the client file\n- Every goal needs a funded SIP or a lump sum\n- Note one risk the family has not considered',
            resources: [{name: 'Mehta Family — Client File.pdf', kind: 'PDF', note: 'Fact-find, FQ and ISEQ results'}]}),
          V('Presenting the plan', 12, {
            summary: 'How to walk a family through their plan so they sign it.',
            body: '## Structure the meeting\n- Remind them of their goals, in their words\n- Show where they stand today — honestly\n- Show the plan, one goal at a time\n- Agree the first three actions and dates\n> Finish with the action, not the summary.',
            takeaways: ['Lead with their goals, in their words', 'One goal at a time', 'Close on the first three actions']}),
          V('Walkthrough: the Mehta plan, finished', 14, {
            summary: 'The completed Mehta plan in BOSS, reviewed screen by screen.',
            takeaways: ['Every goal funded or flagged', 'The execution plan names dates and owners']}),
        ]),
      ]}),
    base({
      title: 'Consultative Client Conversations', icon: '💬', color: '#0E7490', category: 'Communication', level: 'Intermediate',
      subtitle: 'Listen first, ask better questions, and handle objections without pressure.',
      description: 'The conversation skills behind discovery calls, review meetings and difficult news — shown in short videos of the situations advisers meet every week.',
      instructor: {name: 'Rahul Menon', title: 'Client Experience Lead'}, tags: ['discovery', 'objections', 'listening', 'reviews'],
      modules: [
        M('Listening and discovery', [V('Active listening in practice', 12, {summary: 'Reflecting, summarising and the power of the pause.'}),
          V('Questions that open people up', 9, {summary: 'Open, probing and confirming questions — and when to use each.'}),
          V('A discovery call, start to finish', 18, {summary: 'A full 15-minute discovery call, with commentary.'})]),
        M('Objections and difficult moments', [V('The four common objections', 14, {summary: '“I need to think about it”, fees, past losses and “my cousin handles it”.'}),
          V('Delivering bad news in a review', 10, {summary: 'When a goal is off track: how to say it and what to offer.'})]),
      ]}),
    base({
      title: 'Leading High-Performance Advisory Teams', icon: '🧭', color: '#6D28D9', category: 'Leadership', level: 'Advanced',
      subtitle: 'Coaching, pipeline reviews and building a team that grows without you in every meeting.',
      description: 'For team leads and senior partners: setting expectations, running weekly pipeline reviews, coaching through call reviews, and growing new partners into independent advisers.',
      instructor: {name: 'Vikram Sethi', title: 'Regional Director'}, tags: ['coaching', 'pipeline', 'partners', 'team'],
      modules: [
        M('Setting the standard', [V('What good looks like', 10, {summary: 'Activity, conversion and client outcomes — the three numbers that matter.'}),
          V('Weekly pipeline reviews', 12, {summary: 'A 30-minute review format that finds stuck deals early.'})]),
        M('Coaching', [V('Coaching through call reviews', 16, {summary: 'Listening to a call together and giving one piece of feedback.'}),
          V('Growing new partners', 11, {summary: 'From shadowing to independent: the first 90 days.'})]),
        M('Leading through change', [V('Handling a down quarter', 9, {summary: 'Keeping morale and activity up when markets fall.'})]),
      ]}),
    base({
      title: 'Designing Client-Ready Reports', icon: '🎨', color: '#BE185D', category: 'Design', level: 'Beginner',
      subtitle: 'Make portfolio reviews and plans clear enough to understand at a glance.',
      description: 'Simple design rules for the documents clients actually read: layout, charts that tell the truth, and plain language for numbers.',
      instructor: {name: 'Meera Kapoor', title: 'Brand & Communications'}, tags: ['reports', 'charts', 'presentation'],
      modules: [
        M('Clarity first', [V('One page, one message', 7, {summary: 'Deciding what each page is for before designing it.'}),
          V('Charts that tell the truth', 11, {summary: 'Choosing the right chart and avoiding misleading axes.'})]),
        M('Putting it together', [R('Writing numbers in plain language', 8, {summary: '“Your SIP is on track to reach ₹56 lakh by 2038.”'}),
          V('A report redesigned', 15, {summary: 'One real review page, redesigned on screen.'})]),
      ]}),
    base({
      title: 'SEBI & AMFI Compliance Essentials', icon: '🛡️', color: '#B45309', category: 'Compliance', level: 'Intermediate',
      subtitle: 'The rules every distributor and adviser must follow, explained with examples.',
      description: 'KYC, suitability, disclosure, commissions and record keeping — what the regulations require and how BOSS helps you stay compliant.',
      instructor: {name: 'Sanjay Iyer', title: 'Compliance Officer'}, tags: ['SEBI', 'AMFI', 'KYC', 'ARN', 'EUIN', 'suitability'],
      modules: [
        M('The rules', [V('KYC and client onboarding', 10, {summary: 'What must be collected and verified before any transaction.'}),
          V('Suitability and risk disclosure', 12, {summary: 'Matching products to the risk profile — and documenting it.'}),
          R('ARN, EUIN and the code of conduct', 9, {summary: 'Keeping registrations current and what the code forbids.'})]),
        M('In practice', [V('Record keeping in BOSS', 8, {summary: 'Where approvals, consents and documents are kept and for how long.'})]),
      ]}),
    base({
      title: 'Mutual Fund Product Deep Dive', icon: '🧮', color: '#4338CA', category: 'Technical', level: 'Advanced', status: 'Draft', publishedAt: undefined,
      access: {mode: 'employees'},
      subtitle: 'Categories, costs, taxation and how to compare schemes properly.',
      description: 'A draft course being prepared by the research desk.',
      instructor: {name: 'Research Desk', title: 'Product Research'}, tags: ['mutual funds', 'taxation', 'TER'],
      modules: [M('Scheme categories', [V('SEBI categorisation explained', 12, {summary: 'The 36 categories and what each may hold.'})]),
        M('Comparing schemes', [])]}),
  ];
}
