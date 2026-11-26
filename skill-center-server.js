/* SKILL DEVELOPMENT CENTER — the server half (public/skill-center.js is the page).

   Two jobs:

   1. WHO MAY SEE WHICH COURSE. Every course carries an access rule set by
      an admin or course manager:
        all        every employee and partner
        employees  company employees only
        partners   partners (and the staff they hired) only
        selected   the people picked by name
      A learner is sent only the published courses their rule lets in
      (filterCourses), and cannot open a video that belongs to a course they
      may not see. Admins and course managers see and manage every course,
      drafts included. Only they may save the library.

   2. VIDEOS AND THUMBNAILS, uploaded straight into a lesson. A file is
      streamed to disk as it arrives (no base64, no JSON), kept with a small
      sidecar of what it is, and served back with byte ranges so the HTML5
      player can seek. Media lives in CRM_SDC_MEDIA_DIR (deploy puts it
      beside data/, not inside it, so the data backups taken on every deploy
      do not copy gigabytes of video each time).

   Course managers: a company admin account, a team member with the Admin
   role or Manage Module Settings, or a partner on L7. Partners below L7 and
   partner staff never manage courses. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIDEO_TYPES = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv', 'video/quicktime': '.mov' };
const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const ACCESS_MODES = ['all', 'employees', 'partners', 'selected'];

function install({ app, checkApiKey, signedInUser, storeList, storeValue, dataDir }) {
  const MEDIA_DIR = process.env.CRM_SDC_MEDIA_DIR || path.join(dataDir, 'sdc-media');
  const VIDEO_MAX = (Number(process.env.CRM_SDC_VIDEO_MAX_MB) || 1024) * 1024 * 1024;
  const IMAGE_MAX = 8 * 1024 * 1024;
  try { fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) { console.error('Skill Development media folder:', e.message); }

  /* ---- who is asking ---- */
  function memberOf(user) {
    if (!user) return null;
    const team = storeList('team').filter((t) => t && t.id && !t.deletedAt);
    const byId = user.member_id && team.find((t) => t.id === user.member_id);
    if (byId) return byId;
    const e = String(user.email || '').trim().toLowerCase();
    const byEmail = e ? team.filter((t) => String(t.email || '').trim().toLowerCase() === e) : [];
    return byEmail.length === 1 ? byEmail[0] : null;
  }
  const isPartnerSide = (m) => !!(m && (m.partnerPobId || m.partnerTeamOf));
  function mayManage(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const m = memberOf(user);
    if (!m) return false;
    if (m.partnerTeamOf && !m.partnerPobId) return false;
    if (m.partnerPobId) return m.partnerLevel === 'L7';
    return m.role === 'Admin' || !!(m.adminFlags && m.adminFlags.manageModuleSettings);
  }
  /* Whether this course's rule lets this person in (managers: always). */
  function maySee(course, user, m, manager) {
    if (!course || course.deletedAt) return false;
    if (manager) return true;
    if (course.status !== 'Published') return false;
    const a = course.access || {};
    const mode = ACCESS_MODES.includes(a.mode) ? a.mode : 'all';
    if (mode === 'all') return true;
    if (!m) return false;
    if (mode === 'employees') return !isPartnerSide(m);
    if (mode === 'partners') return isPartnerSide(m);
    return Array.isArray(a.users) && a.users.includes(m.id);
  }
  /* The library as this person may read it. */
  function filterCourses(text, user) {
    if (text === undefined || text === null) return text;
    if (mayManage(user)) return text;
    let list;
    try { list = JSON.parse(text); } catch (e) { return text; }
    if (!Array.isArray(list)) return text;
    const m = memberOf(user);
    return JSON.stringify(list.filter((c) => maySee(c, user, m, false)).map((c) => {
      // Who else is on a course's list is the manager's business, not the learner's.
      if (!c.access || !Array.isArray(c.access.users)) return c;
      return Object.assign({}, c, { access: { mode: c.access.mode } });
    }));
  }

  /* ---- media ---- */
  const idOk = (id) => /^SDM-[0-9a-f]{32}$/.test(String(id || ''));
  const metaPath = (id) => path.join(MEDIA_DIR, id + '.json');
  function readMeta(id) { try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')); } catch (e) { return null; } }
  /* The courses that use a file, as a video, a thumbnail or a cover. */
  function coursesUsing(id) {
    return storeList('sdcCourses').filter((c) => c && !c.deletedAt && (c.coverId === id
      || (c.modules || []).some((m) => (m.lessons || []).some((l) => l && (l.videoId === id || l.posterId === id)))));
  }

  /* POST /api/sdc/media?kind=video|image&name=…   body: the file itself.
     For course managers only. Answers { id, url, size, mime, name }. */
  app.post('/api/sdc/media', checkApiKey, (req, res) => {
    const user = signedInUser(req);
    res.set('Cache-Control', 'no-store');
    if (!mayManage(user)) return res.status(403).json({ ok: false, message: 'Only an admin or a course manager can upload course videos.' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const kind = String(req.query.kind || (mime.startsWith('image/') ? 'image' : 'video'));
    const types = kind === 'image' ? IMAGE_TYPES : VIDEO_TYPES;
    if (!types[mime]) {
      return res.status(415).json({ ok: false, message: kind === 'image'
        ? 'A thumbnail has to be a JPG, PNG or WEBP image.' : 'A video has to be MP4, WEBM, OGG or MOV.' });
    }
    const max = kind === 'image' ? IMAGE_MAX : VIDEO_MAX;
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > max) return res.status(413).json({ ok: false, message: 'That file is larger than ' + Math.round(max / 1048576) + ' MB.' });
    const id = 'SDM-' + crypto.randomBytes(16).toString('hex');
    const file = path.join(MEDIA_DIR, id + types[mime]);
    const tmp = file + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0, failed = false;
    const fail = (code, message) => {
      if (failed) return; failed = true;
      out.destroy(); fs.unlink(tmp, () => {});
      if (!res.headersSent) res.status(code).json({ ok: false, message });
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) { fail(413, 'That file is larger than ' + Math.round(max / 1048576) + ' MB.'); req.destroy(); }
    });
    req.on('aborted', () => fail(400, 'The upload was interrupted.'));
    out.on('error', (e) => fail(500, 'The file could not be stored: ' + e.message));
    out.on('finish', () => {
      if (failed) return;
      if (!size) { fs.unlink(tmp, () => {}); return res.status(400).json({ ok: false, message: 'The file is empty.' }); }
      fs.rename(tmp, file, (err) => {
        if (err) return fail(500, 'The file could not be stored: ' + err.message);
        const meta = { id, kind, mime, ext: types[mime], size, name: String(req.query.name || '').slice(0, 200),
          by: (user && user.email) || '', at: new Date().toISOString() };
        fs.writeFile(metaPath(id), JSON.stringify(meta), () => {
          res.json({ ok: true, id, url: '/api/sdc/media/' + id, size, mime, name: meta.name });
        });
      });
    });
    req.pipe(out);
  });

  /* GET /api/sdc/media/:id — the file, with byte ranges for seeking. No API
     key header here: a <video> or <img> cannot send one, and the sign-in
     gate in front of every route has already checked the session. Whoever
     may see a course that uses the file may fetch it; a file no saved course
     uses yet (just uploaded in the builder) is for course managers. */
  app.get('/api/sdc/media/:id', (req, res) => {
    const id = String(req.params.id || '');
    if (!idOk(id)) return res.status(404).end();
    const meta = readMeta(id);
    if (!meta) return res.status(404).end();
    const user = signedInUser(req);
    const manager = mayManage(user);
    if (!manager) {
      const m = memberOf(user);
      if (!coursesUsing(id).some((c) => maySee(c, user, m, false))) return res.status(403).end();
    }
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(meta.mime);
    // dotfiles: the folder is ours, and may sit under a hidden directory (a test
    // run's .work/), which send() would otherwise answer with nothing.
    res.sendFile(path.join(MEDIA_DIR, id + meta.ext), { acceptRanges: true, lastModified: true, dotfiles: 'allow', headers: { 'Content-Type': meta.mime } }, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode || 404).end();
    });
  });

  return { mayManage, maySee, filterCourses, memberOf, MEDIA_DIR };
}

module.exports = { install, ACCESS_MODES };
