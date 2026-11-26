/* WHO MAY SEE AND CHANGE WHAT — enforced on the server.

   Freedom LifeX runs two platforms on one backend and one store:

     partner.freedomlifex.co.in   partners (L1–L7) and the staff they hire
     one.freedomlifex.co.in       company employees

   Both read and write the same records, so a change on one shows on the
   other with the next live update. What differs is who is asking. Until
   this file the server handed every signed-in person the whole store and
   left the page to hide what they should not see; that is not access
   control. Now every read of a store is cut down to the records the
   person may see, and every write is checked against the same rule before
   it lands.

   WHO IS ASKING (principal):
     admin       a company admin account, or an employee with Admin role or
                 "Everyone" scope: unrestricted.
     employee    a company employee with Own / Team / Branch scope. Their
                 client and lead records follow that scope (the reporting
                 line, or their branch), plus the partners they are the
                 assigned RM of. Partner L1–L7 rules are NOT applied to them.
     partner     a team member with partnerPobId. Their level
                 (public/partner-levels.js) decides the reach: L1–L2 their
                 own data only; L3–L6 their own plus every partner mapped
                 below them; L7 unrestricted. HR, employee records, company
                 configuration and payout administration stay closed to
                 L1–L6.
     staff       a person a partner (L5+) hired (partnerTeamOf). An RM sees
                 their own work; Operations staff work the partner's book.

   A record is visible when somebody in reach owns it (assignedTo, rmName,
   assignTo, createdBy, …), when it belongs to a partner in reach
   (partnerPobId), when it is mapped to somebody in reach on the payout
   hierarchy (mappedTo), or when it hangs off a visible record (a task on a
   visible lead, a document of a visible client). */
'use strict';
const PLV = require('./public/partner-levels.js');

/* ---- platforms ---------------------------------------------------------- */
function hostList(s) { return String(s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean); }
/* Which platform a request came in on, from its host name. Anything that is
   neither (the old single address, localhost) is "combined": everybody may
   sign in there, as before. */
function platformOf(req, env) {
  const host = String((req.headers && req.headers.host) || '').toLowerCase().replace(/:\d+$/, '');
  env = env || process.env;
  if (hostList(env.CRM_PARTNER_HOSTS).includes(host) || host.startsWith('partner.')) return 'partner';
  if (hostList(env.CRM_COMPANY_HOSTS).includes(host) || host.startsWith('one.')) return 'company';
  return 'combined';
}
const PLATFORM_LABEL = { partner: 'Partner Platform', company: 'Company Platform', combined: '' };

/* ---- which stores are what ---------------------------------------------- */
// Fields that say who a record belongs to.
const OWNER_FIELDS = ['assignedTo', 'assignTo', 'rmName', 'owner', 'loggedBy', 'createdBy', 'userId', 'memberId',
  'raisedBy', 'requestedBy', 'submittedBy', 'approverId', 'by'];
// Fields that hang a record off another one.
const LINK_FIELDS = ['leadId', 'clientId', 'reviewId', 'recordId', 'projectId', 'queryId', 'allocationId',
  'recommendationId', 'taskId', 'parentId', 'convertedFromLeadId', 'convertedToClientId', 'prospectId', 'goalId'];
// Fields that say which partner's business a record is.
const POB_FIELDS = ['partnerPobId', 'pobId', 'fbmPobId', 'referrerPobId', 'onboardingId'];

/* The firm's business records: cut down row by row for anybody restricted. */
const BUSINESS_ROWS = ['leads', 'clients', 'reviews', 'recommendations', 'meetings', 'businessEntries', 'transactions',
  'communications', 'clientGoals', 'clientDocuments', 'clientFeedback', 'moms', 'callEntries', 'docLinks',
  'docSubmissions', 'insPolicies', 'platformHoldings', 'platformSips', 'reviewEdits', 'reviewReports',
  // Website FQ results: an RM with Own / Team scope sees those of their own leads.
  'websiteFqResults'];
/* What a partner also works in, row by row. */
const PARTNER_ROWS = BUSINESS_ROWS.concat(['tasks', 'queries', 'queryReplies', 'supportQueries', 'approvals',
  'deleteRequests', 'projects', 'projectTasks', 'projectClients', 'notifications', 'workActivities', 'djtEntries',
  'auditLog', 'accessRequests', 'partnerProspects', 'pjPartners', 'partnerQueries', 'partnerPayouts',
  'partnerReferrals', 'pjOnboarding', 'pjDocuments', 'pjSessions', 'pjTraining', 'pjReviews', 'aumMonthly',
  // Skill Development Center: each person's own progress (userId).
  'sdcProgress']);
/* Company HR: a partner sees only their own rows (and their own staff's on L5+). */
const HR_ROWS = ['hrAttendance', 'hrLeave', 'hrRegularizations', 'hrCompOff', 'hrIncentives', 'hrAppraisals'];
/* Read-only reference a partner's screens need to draw. */
const PARTNER_SHARED = ['config', 'settings', 'systemState', 'hrConfig', 'amcs', 'schemes', 'multiProductSchemes',
  'sops', 'slaRules', 'automationRules', 'campaignTemplates', 'complianceItems', 'pjWorkflows', 'partnerWebinars',
  'sdcCourses'];
/* Per-file stores a partner may use: attachments on their own queries. */
const PARTNER_FILE_PREFIXES = ['qfile.', 'qFile.', 'queryFile.'];
// Everything else (connectors, logs, imports, backups, payout rates, …) is closed to a partner.

/* Team fields a partner sees for people outside their reach: enough to put a
   name to an id, nothing an employee record holds beyond that. */
const DIRECTORY_FIELDS = ['id', 'name', 'designation', 'status', 'branch', 'partnerPobId', 'partnerLevel',
  'partnerTeamOf', 'partnerStaffRole', 'parentUserId', 'deletedAt', 'photo', 'avatar'];
/* What a partner may change on their own team row. */
const SELF_EDITABLE = ['mobile', 'photo', 'avatar', 'address', 'notes', 'documents', 'preferences', 'signature',
  'lastSeenAt', 'theme', 'dashPrefs', 'bio', 'dob', 'emergencyContact'];
/* What a partner (L5+) may set on a person of their own team. */
const STAFF_EDITABLE = ['name', 'email', 'mobile', 'status', 'designation', 'role', 'partnerStaffRole', 'perms',
  'scope', 'pagePerms', 'photo', 'avatar', 'notes', 'documents', 'joinedAt', 'branch', 'employeeId', 'deletedAt',
  'deletedBy', 'updatedAt', 'updatedBy', 'adminFlags', 'hrAccess', 'managerIds', 'departments', 'parentUserId',
  'partnerTeamOf', 'createdAt', 'createdBy', 'id', 'plvV', 'lastSeenAt'];

const asArr = (v) => (Array.isArray(v) ? v : []);
const parse = (t, f) => { try { const v = JSON.parse(t); return v === undefined ? f : v; } catch (e) { return f; } };
const rowKey = (r) => (r && typeof r === 'object' && r.id !== undefined && r.id !== null ? String(r.id) : null);
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function createAccess({ getStore, revision }) {
  const list = (k) => { const v = parse(getStore()[k], []); return Array.isArray(v) ? v : []; };
  const value = (k, f) => (getStore()[k] === undefined ? f : parse(getStore()[k], f));

  /* ---- the reporting line ---- */
  function descendants(team, id) {
    const kids = new Map();
    team.forEach((t) => { if (t && t.parentUserId) { if (!kids.has(t.parentUserId)) kids.set(t.parentUserId, []); kids.get(t.parentUserId).push(t); } });
    const out = [], seen = new Set([id]), queue = (kids.get(id) || []).slice();
    while (queue.length) {
      const u = queue.shift();
      if (!u || seen.has(u.id)) continue;   // a loop in the data must not hang the server
      seen.add(u.id); out.push(u); queue.push(...(kids.get(u.id) || []));
    }
    return out;
  }

  /* ---- who is asking ---- */
  function principal(user) {
    if (!user) return null;
    const team = list('team');
    const live = team.filter((t) => t && t.id && !t.deletedAt);
    const byEmail = live.filter((t) => t.email && String(t.email).toLowerCase() === String(user.email || '').toLowerCase());
    const member = live.find((t) => t.id === user.member_id) || (byEmail.length === 1 ? byEmail[0] : null);
    const partnerSide = !!(member && (member.partnerPobId || member.partnerTeamOf));
    if (!partnerSide) {
      const admin = user.role === 'admin' || (member && (member.role === 'Admin' || member.scope === 'all'));
      if (admin) return { kind: 'admin', unrestricted: true, user, member, label: 'Company admin' };
      if (!member) return { kind: 'employee', unrestricted: false, user, member: null, ids: new Set(), pobs: new Set(), scope: 'own', label: 'Employee' };
      const scope = member.scope || 'own';
      const people = scope === 'team' ? [member].concat(descendants(team, member.id)) : [member];
      const ids = new Set(people.map((t) => t.id));
      // The partners an employee is the assigned RM of are their responsibility.
      const pobs = new Set(people.map((t) => t.partnerPobId).filter(Boolean));
      list('pjOnboarding').forEach((r) => { if (r && !r.deletedAt && ids.has(r.assignedTo)) pobs.add(r.id); });
      return { kind: 'employee', unrestricted: false, user, member, ids, pobs, scope,
        branch: scope === 'branch' ? member.branch || '' : null, label: 'Employee' };
    }
    const cfg = value('config', {}) || {};
    if (member.partnerTeamOf && !member.partnerPobId) {
      const boss = team.find((t) => t && t.id === member.partnerTeamOf && !t.deletedAt) || null;
      const role = PLV.staffRole(member.partnerStaffRole);
      let ids = new Set([member.id]), pobs = new Set();
      if (boss && boss.partnerPobId) {
        pobs.add(boss.partnerPobId);   // what they add is the partner's business
        if (role.reach === 'partner') {
          const bp = partnerReach(team, boss, PLV.level(cfg.partnerLevels, boss.partnerLevel || 'L1'));
          ids = new Set([member.id, ...bp.ids]); pobs = bp.pobs;
        }
      }
      return { kind: 'staff', unrestricted: false, user, member, boss, role, ids, pobs, scope: 'own',
        label: role.l + (boss ? ' · ' + (boss.name || '') : '') };
    }
    const lv = PLV.level(cfg.partnerLevels, member.partnerLevel || 'L1') || PLV.levels()[0];
    if (PLV.has(lv, 'superAdmin')) return { kind: 'partner', unrestricted: true, user, member, level: lv, label: lv.name + ' (' + lv.k + ')' };
    const r = partnerReach(team, member, lv);
    return { kind: 'partner', unrestricted: false, user, member, level: lv, ids: r.ids, pobs: r.pobs, scope: lv.scope,
      label: lv.name + ' (' + lv.k + ')' };
  }
  /* A partner's reach: themselves and their own staff; on L3 up every person
     mapped below them in the reporting line too. */
  function partnerReach(team, m, lv) {
    const people = lv.scope === 'own'
      ? [m].concat(team.filter((t) => t && t.partnerTeamOf === m.id))
      : [m].concat(descendants(team, m.id));
    return { ids: new Set(people.map((t) => t.id)), pobs: new Set(people.map((t) => t.partnerPobId).filter(Boolean)) };
  }
  const isPartnerSide = (p) => !!p && (p.kind === 'partner' || p.kind === 'staff');
  const restricted = (p) => !!p && !p.unrestricted;

  /* ---- which records are in reach ---- */
  function direct(row, p) {
    if (!row || typeof row !== 'object') return false;
    if (p.branch !== null && p.branch !== undefined) {
      if (row.branch && row.branch === p.branch) return true;
    }
    for (const f of OWNER_FIELDS) { const v = row[f]; if (v && p.ids.has(v)) return true; }
    for (const f of POB_FIELDS) { const v = row[f]; if (v && p.pobs.has(v)) return true; }
    if (row.id && p.pobs.has(row.id)) return true;
    if (asArr(row.mappedTo).some((id) => p.ids.has(id))) return true;
    return false;
  }
  function linked(row, seen) {
    for (const f of LINK_FIELDS) { const v = row[f]; if (v && seen.has(String(v))) return true; }
    return false;
  }
  const rowKeysFor = (p) => (isPartnerSide(p) ? PARTNER_ROWS : BUSINESS_ROWS);
  /* Every record id in reach, across the stores this person reads row by row. */
  const cache = new Map();
  function reach(p) {
    const ck = (p.user && p.user.id) + '|' + (revision ? revision() : 0);
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.at < 5000) return hit.seen;
    const keys = rowKeysFor(p);
    const rows = keys.map((k) => [k, list(k)]);
    const seen = new Set();
    rows.forEach(([, l]) => l.forEach((r) => { if (direct(r, p) && rowKey(r)) seen.add(rowKey(r)); }));
    // Twice: a document of a goal of a client, a reply to a query on a lead.
    for (let pass = 0; pass < 2; pass++) {
      rows.forEach(([, l]) => l.forEach((r) => { const k = rowKey(r); if (k && !seen.has(k) && linked(r, seen)) seen.add(k); }));
    }
    if (cache.size > 500) cache.clear();
    cache.set(ck, { seen, at: Date.now() });
    return seen;
  }
  function rowVisible(key, row, p, seen) {
    if (HR_ROWS.includes(key)) return !!row && (row.userId === p.member.id || (row.userId && p.ids.has(row.userId) && p.kind === 'partner' && PLV.has(p.level, 'buildTeam')));
    const k = rowKey(row);
    return !!k && (seen || reach(p)).has(k);
  }

  /* ---- reading ---- */
  function readable(key, p) {
    if (!restricted(p)) return true;
    if (!isPartnerSide(p)) return true;
    if (key === 'team' || PARTNER_ROWS.includes(key) || HR_ROWS.includes(key) || PARTNER_SHARED.includes(key)) return true;
    return PARTNER_FILE_PREFIXES.some((pre) => key.startsWith(pre));
  }
  /* The store as this person may see it, as text; null when it is not theirs to read. */
  function read(key, text, p) {
    if (!restricted(p) || text === undefined) return text;
    if (!readable(key, p)) return null;
    if (isPartnerSide(p) && key === 'team') return JSON.stringify(teamView(parse(text, []), p));
    const rowsHere = rowKeysFor(p).includes(key) || (isPartnerSide(p) && HR_ROWS.includes(key));
    if (!rowsHere) return text;
    const rows = parse(text, null);
    if (!Array.isArray(rows)) return text;
    const seen = reach(p);
    return JSON.stringify(rows.filter((r) => rowVisible(key, r, p, seen)));
  }
  function teamView(team, p) {
    if (!Array.isArray(team)) return team;
    return team.map((t) => {
      if (!t || typeof t !== 'object') return t;
      if (p.ids.has(t.id) || (p.boss && t.id === p.boss.id && p.role.reach === 'partner')) return t;
      const o = {};
      DIRECTORY_FIELDS.forEach((f) => { if (t[f] !== undefined) o[f] = t[f]; });
      o.directoryOnly = true;
      return o;
    });
  }

  /* ---- writing ---- */
  function writable(key, p) {
    if (!restricted(p)) return true;
    if (!isPartnerSide(p)) return true;   // an employee's other stores follow the company's own rules
    if (PARTNER_ROWS.includes(key) || HR_ROWS.includes(key)) return true;
    if (key === 'team') return true;      // checked row by row below
    return PARTNER_FILE_PREFIXES.some((pre) => key.startsWith(pre));
  }
  const rowChecked = (key, p) => restricted(p) && (rowKeysFor(p).includes(key) || (isPartnerSide(p) && (HR_ROWS.includes(key) || key === 'team')));

  /* A whole-list save from somebody restricted becomes a patch against what
     they were shown, so rows they never saw cannot be overwritten, and rows
     shown to them cut down (a colleague's name only) are not saved back cut
     down. */
  function toPatch(key, storedText, incoming, removed, p) {
    const served = parse(read(key, storedText === undefined ? '[]' : storedText, p) || '[]', []);
    const servedBy = new Map(asArr(served).map((r) => [rowKey(r), r]));
    const stored = new Map(list(key).map((r) => [rowKey(r), r]));
    const changes = [], adds = [];
    for (const r of asArr(incoming)) {
      const k = rowKey(r);
      if (k === null) continue;
      const was = servedBy.get(k);
      if (!was) {
        if (stored.has(k)) return { error: 'a record that is not yours to change (' + key + ' ' + k + ')' };
        adds.push(r);
        continue;
      }
      const set = {}, unset = [];
      Object.keys(r).forEach((f) => { if (f !== '_mt' && f !== 'directoryOnly' && !same(r[f], was[f])) set[f] = r[f]; });
      Object.keys(was).forEach((f) => { if (f !== '_mt' && f !== 'directoryOnly' && !(f in r)) unset.push(f); });
      if (Object.keys(set).length || unset.length) changes.push({ id: r.id, set, unset });
    }
    return { patch: { kind: 'rows', changes, adds, removed: asArr(removed) } };
  }
  /* Whether this person may make this change. Returns { error } or { patch }. */
  function authorize(key, storedText, body, headers, p) {
    if (!restricted(p)) return {};
    if (!writable(key, p)) return { error: 'You cannot change ' + key + '.' };
    if (!rowChecked(key, p)) return {};
    if (headers['x-crm-replace'] === '1' || headers['x-crm-bulk'] === '1') return { error: 'Only an administrator can replace ' + key + ' wholesale.' };
    let patch = body && body.patch;
    if (!patch) {
      const incoming = parse(body && body.value, null);
      if (!Array.isArray(incoming)) return { error: key + ' is a list' };
      const t = toPatch(key, storedText, incoming, body.removed, p);
      if (t.error) return t;
      patch = t.patch;
    }
    if (patch.kind !== 'rows') return { error: 'You cannot change ' + key + ' that way.' };
    const seen = reach(p);
    const stored = new Map(list(key).map((r) => [rowKey(r), r]));
    const fresh = new Set(asArr(patch.adds).map(rowKey).filter(Boolean));
    const seenAfter = new Set([...seen, ...fresh]);
    const visibleAfter = (row) => (HR_ROWS.includes(key) ? row.userId === p.member.id
      : direct(row, p) || linked(row, seenAfter));
    const mine = (row) => key === 'team' || rowVisible(key, row, p, seen);
    for (const c of asArr(patch.changes)) {
      const k = c && rowKey(c); if (k === null) continue;
      const row = stored.get(k); if (!row) continue;   // gone meanwhile
      if (!mine(row)) return { error: 'That ' + key + ' record is not yours to change.' };
      const after = Object.assign({}, row, c.set || {}); asArr(c.unset).forEach((f) => { delete after[f]; });
      const why = key === 'team' ? teamChange(row, after, Object.keys(c.set || {}).concat(asArr(c.unset)), p) : fieldProblem(row, after, p);
      if (why) return { error: why };
      if (key !== 'team' && !visibleAfter(after)) return { error: 'That change would move the record out of your reach.' };
    }
    for (const r of asArr(patch.adds)) {
      const k = rowKey(r); if (k === null) continue;
      const row = stored.get(k);
      if (row) {
        if (!mine(row)) return { error: 'That ' + key + ' record is not yours to change.' };
        const after = Object.assign({}, row, r);
        const why = key === 'team' ? teamChange(row, after, Object.keys(r), p) : fieldProblem(row, after, p);
        if (why) return { error: why };
        continue;
      }
      const why = key === 'team' ? teamAdd(r, p) : fieldProblem({}, r, p);
      if (why) return { error: why };
      if (key !== 'team' && !visibleAfter(r)) return { error: 'A new ' + key + ' record has to be yours, or hang off one of yours.' };
    }
    for (const id of asArr(patch.removed)) {
      const row = stored.get(String(id)); if (!row) continue;
      if (key === 'team' ? !(row.partnerTeamOf && row.partnerTeamOf === p.member.id) : !mine(row))
        return { error: 'That ' + key + ' record is not yours to remove.' };
    }
    return { patch };
  }
  /* A record may only be given to a partner this person works for. */
  function fieldProblem(row, after, p) {
    if (!isPartnerSide(p)) return '';
    for (const f of POB_FIELDS) {
      if (!same(row[f], after[f]) && after[f] && !p.pobs.has(after[f])) return 'You cannot hand a record to another partner.';
    }
    return '';
  }
  function teamChange(row, after, fields, p) {
    if (!isPartnerSide(p)) return '';
    const changed = fields.filter((f) => f !== '_mt' && f !== 'directoryOnly' && !same(row[f], after[f]));
    if (!changed.length) return '';
    if (row.id === p.member.id) {
      const bad = changed.filter((f) => !SELF_EDITABLE.includes(f));
      return bad.length ? 'Your level, role, access and reporting line are set by the company (' + bad.join(', ') + ').' : '';
    }
    if (row.partnerTeamOf && row.partnerTeamOf === p.member.id) {
      const bad = changed.filter((f) => !STAFF_EDITABLE.includes(f));
      if (bad.length) return 'You cannot change ' + bad.join(', ') + ' on a member of your team.';
      return staffProblem(after, p);
    }
    return 'Only your own profile and your own team can be changed from here.';
  }
  function teamAdd(r, p) {
    if (!isPartnerSide(p)) return '';
    if (p.kind !== 'partner' || !PLV.has(p.level, 'buildTeam')) return 'Building a team needs partner level L5 or above.';
    if (r.partnerTeamOf !== p.member.id) return 'A new team member has to be part of your own team.';
    return staffProblem(r, p);
  }
  function staffProblem(r, p) {
    if (r.partnerTeamOf !== p.member.id) return 'A member of your team stays in your team.';
    if (r.partnerPobId || r.partnerLevel) return 'Partners are given their level by the company, not from a team.';
    if (r.role === 'Admin' || r.scope === 'all' || r.scope === 'branch') return 'A team member cannot be given company-wide access.';
    if (Object.values(r.adminFlags || {}).some(Boolean)) return 'A team member cannot be given administrative controls.';
    if (r.hrAccess && Object.values(r.hrAccess).some(Boolean)) return 'A team member cannot be given HR access.';
    if (r.parentUserId && !p.ids.has(r.parentUserId)) return 'A team member has to report to you or to someone in your team.';
    return '';
  }
  /* A partner may only delete their own per-file stores; core stores need an admin. */
  function deletable(key, p) {
    if (!restricted(p) || !isPartnerSide(p)) return true;
    return PARTNER_FILE_PREFIXES.some((pre) => key.startsWith(pre));
  }
  /* What the page is told about the person signed in. */
  function summary(p, platform) {
    if (!p) return null;
    const lv = p.level;
    return {
      kind: p.kind, unrestricted: !!p.unrestricted, label: p.label || '', platform,
      level: lv ? lv.k : '', levelName: lv ? lv.name : '', caps: lv ? lv.caps.slice() : [],
      scope: p.unrestricted ? 'all' : (p.scope || 'own'),
      staffRole: p.kind === 'staff' ? p.role.k : '', partnerTeamOf: p.kind === 'staff' && p.boss ? p.boss.id : '',
      reach: p.ids ? p.ids.size : null,
      // The stores this person's page may save at all (everything when null).
      writable: restricted(p) && isPartnerSide(p) ? PARTNER_ROWS.concat(HR_ROWS, ['team']) : null,
      writablePrefixes: restricted(p) && isPartnerSide(p) ? PARTNER_FILE_PREFIXES.slice() : null,
    };
  }
  /* Which platform this person signs in on. A partner (and their staff) on
     the partner platform, an employee on the company platform; L7 and
     company admins on both; everybody on the combined (old) address. */
  function mayUsePlatform(p, platform) {
    if (!p || platform === 'combined') return true;
    if (p.kind === 'admin') return true;
    if (p.kind === 'partner' && p.unrestricted) return true;
    if (platform === 'partner') return isPartnerSide(p);
    return !isPartnerSide(p);
  }
  return { principal, restricted, isPartnerSide, read, readable, writable, authorize, deletable, summary,
    mayUsePlatform, reach, rowVisible };
}

module.exports = { createAccess, platformOf, PLATFORM_LABEL, BUSINESS_ROWS, PARTNER_ROWS, HR_ROWS, PARTNER_SHARED };
