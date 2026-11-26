/* BOSS — Production Server
 * Real Node.js backend, replacing the browser-only window.storage
 * mechanism the prototype used, which never left the browser.
 *
 * Storage: a single JSON file on disk (data.json), read into memory on
 * boot and written back on every change. No native dependencies — the
 * first version of this used better-sqlite3, but that requires compiling
 * C++ against Node's headers at install time, which fails outright on
 * networks that block nodejs.org (confirmed by actually trying it before
 * shipping this). A plain JSON file has no such risk, and at the scale
 * this CRM's actual storage needs (a few dozen named keys, not millions
 * of rows), it's a perfectly real, durable choice — verified below by
 * actually writing, restarting the process, and reading it back.
 *
 * WHAT THIS FIXES: data now lives in a real file on disk, durable across
 * restarts, shared correctly across every real device that hits this
 * server — not per-browser, not ephemeral, not dependent on any one
 * browser session staying open.
 *
 * WHAT THIS DOES NOT FIX (see README.md "Honest Limitations" section):
 * there is still no real user authentication, and the role/permission
 * rules are still only enforced in the browser's JavaScript. The
 * CRM_API_KEY check below is a minimal shared-secret gate to keep the API
 * off the open internet — it is NOT equivalent to per-user login security.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const net = require('net');
const tls = require('tls');
const https = require('https');
// A model the firm runs is often on its own network over plain http; the
// outward-facing probes still refuse it, and only the self-hosted adapter uses this.
const http = require('http');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CRM_API_KEY || null; // set this in production — see README.md
const DB_FILE = process.env.CRM_DB_FILE || path.join(__dirname, 'data.json');
// Connection credentials live in their OWN file, never in data.json.
// data.json is handed to any signed-in browser through /api/storage, so an SMTP
// password kept there would be readable by every user of the CRM. This file is
// only ever read by this process: secrets go in, and the API never sends one back
// out. It sits beside data.json, which in production is outside the repo.
const CONN_FILE = process.env.CRM_CONNECTIONS_FILE || path.join(path.dirname(DB_FILE), 'connections.json');

// Sign-in. One account per person: email and password, kept in SQLite beside
// the data file. This replaces the single shared access code the CRM used to
// have, so the door now records who opened it rather than only that someone did.
//
// SQLite comes from node:sqlite, built into Node 22 — not better-sqlite3, which
// compiles at install time and would break npm ci on this VPS.
const USERS_DB_FILE = process.env.CRM_USERS_DB || path.join(path.dirname(DB_FILE), 'users.db');
const usersDb = new DatabaseSync(USERS_DB_FILE);
usersDb.exec('PRAGMA journal_mode = WAL');
usersDb.exec('PRAGMA busy_timeout = 5000');
usersDb.exec(`CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Added after the table existed, so guard it: 'user' or 'admin'. The only
// difference is that an admin can add accounts; both see the same CRM.
if (!usersDb.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'role'").get()) {
  usersDb.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
}
// An account belongs to a team member. The CRM creates it when the member is
// created and keeps it in step, so there is one person, one record and one
// sign-in rather than the same human typed in twice.
//
//   member_id       the CRM team member this account is                                     
//   crm_role        their role in the CRM, kept for display — the gate only knows admin/user
//   active          a deactivated member cannot sign in, and any open session ends at once
//   issued_password retired: a password is never kept readable (see the scrub below)
//   password_set_at when the password now on the account was set
//   password_set_by 'system' (made with the account), 'admin-reset' or 'user' (they chose it)
//   must_change     1 while a temporary password is on the account: they choose their own next
//   last_login_at   when they first proved they had it
const USER_COLUMNS = {
  member_id: "ALTER TABLE users ADD COLUMN member_id TEXT",
  crm_role: "ALTER TABLE users ADD COLUMN crm_role TEXT",
  active: "ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1",
  issued_password: "ALTER TABLE users ADD COLUMN issued_password TEXT",
  last_login_at: "ALTER TABLE users ADD COLUMN last_login_at TEXT",
  // Two-step sign-in: after the password, a code emailed to this address.
  two_factor: "ALTER TABLE users ADD COLUMN two_factor INTEGER NOT NULL DEFAULT 0",
  // Password management. When the person last set a password of their own;
  // whether the one they have was issued (by account creation, a reset or a
  // temporary password) and must be replaced at their next sign-in; and a
  // pending reset link — only its hash, and when it stops working.
  password_set_at: "ALTER TABLE users ADD COLUMN password_set_at TEXT",
  password_set_by: "ALTER TABLE users ADD COLUMN password_set_by TEXT",
  must_change: "ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0",
  reset_hash: "ALTER TABLE users ADD COLUMN reset_hash TEXT",
  reset_expires: "ALTER TABLE users ADD COLUMN reset_expires INTEGER",
  reset_requested_at: "ALTER TABLE users ADD COLUMN reset_requested_at TEXT",
};
for (const [column, ddl] of Object.entries(USER_COLUMNS)) {
  if (!usersDb.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?").get(column)) usersDb.exec(ddl);
}
/* NO PASSWORD IS KEPT READABLE. A generated password used to be stored as
   it was, for an admin to read until the person first signed in. It is
   gone: anyone still holding one unused keeps it working (it was emailed to
   them) and is asked to choose their own at their next sign-in. */
usersDb.exec("UPDATE users SET must_change = 1, password_set_by = COALESCE(password_set_by, 'system') "
  + "WHERE issued_password IS NOT NULL AND issued_password <> ''");
usersDb.exec("UPDATE users SET issued_password = NULL WHERE issued_password IS NOT NULL");
const findUserByEmail = usersDb.prepare('SELECT * FROM users WHERE email = ?');
const findUserById = usersDb.prepare('SELECT * FROM users WHERE id = ?');
const findUserByMember = usersDb.prepare('SELECT * FROM users WHERE member_id = ?');
const listUsers = usersDb.prepare('SELECT * FROM users ORDER BY id');
/* An account with no team member behind it was only ever made by the
   form on /users, which is gone — Team Members makes the person and the
   account together, through insertMemberUser below. The command line
   (scripts/user.js) has its own statement for the first account on a
   fresh system, which is the one case Team Members cannot cover. */
const insertMemberUser = usersDb.prepare(
  "INSERT INTO users (email, password_hash, role, member_id, crm_role, active, must_change, password_set_by, password_set_at) "
  + "VALUES (?, ?, ?, ?, ?, ?, 1, 'system', datetime('now'))");
const updateUserAccount = usersDb.prepare(
  'UPDATE users SET email = ?, role = ?, member_id = ?, crm_role = ?, active = ? WHERE id = ?');
/* An issued password (a new account, a temporary one) is hashed like any
   other and never kept readable; the person must replace it when they sign in. */
const setIssuedPassword = usersDb.prepare("UPDATE users SET password_hash = ?, issued_password = NULL, must_change = 1, password_set_by = 'admin-reset', password_set_at = datetime('now'), reset_hash = NULL, reset_expires = NULL WHERE id = ?");
// The FreedomLifex code calls an admin's reset by this name.
const updateUserPassword = setIssuedPassword;
const setOwnPassword = usersDb.prepare("UPDATE users SET password_hash = ?, issued_password = NULL, must_change = 0, password_set_by = 'user', password_set_at = datetime('now'), reset_hash = NULL, reset_expires = NULL WHERE id = ?");
const setResetToken = usersDb.prepare("UPDATE users SET reset_hash = ?, reset_expires = ?, reset_requested_at = datetime('now') WHERE id = ?");
const findUserByReset = usersDb.prepare('SELECT * FROM users WHERE reset_hash = ?');
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
/* What a password has to be: long enough, and not one kind of character. The
   browser says the same thing as it is typed; this is the rule that counts. */
function passwordProblem(p) {
  p = String(p || '');
  if (p.length < 8) return 'A password needs at least 8 characters.';
  if (p.length > 128) return 'A password can be at most 128 characters.';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p)) return 'A password needs both capital and small letters.';
  if (!/[0-9]/.test(p)) return 'A password needs at least one number.';
  if (!/[^A-Za-z0-9]/.test(p)) return 'A password needs at least one symbol, such as ! @ # or $.';
  return null;
}
function resetHash(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function originOf(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return proto.split(',')[0].trim() + '://' + req.get('host');
}
const noteUserLogin = usersDb.prepare("UPDATE users SET last_login_at = datetime('now'), issued_password = NULL WHERE id = ?");
const deleteUserById = usersDb.prepare('DELETE FROM users WHERE id = ?');
const setUserTwoFactor = usersDb.prepare('UPDATE users SET two_factor = ? WHERE id = ?');

// A password somebody has to read off a screen and type once. No look-alike
// characters, and enough of them that the length is doing the work.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generatePassword(length) {
  const n = length || 14;
  let out = '';
  for (let i = 0; i < n; i++) out += PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)];
  return out;
}
// What the CRM is told about an account. The password only ever leaves here
// while it is still unused; once the person has signed in there is nothing to
// show and a new one has to be issued.
function accountJson(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, role: u.role, crmRole: u.crm_role || '', memberId: u.member_id || '',
    active: u.active === undefined ? 1 : u.active, createdAt: u.created_at, lastLoginAt: u.last_login_at || null,
    // Where the person is with their password — never the password itself.
    mustChange: !!u.must_change, passwordSetAt: u.password_set_at || null,
    resetRequestedAt: u.reset_requested_at || null,
    resetPending: !!(u.reset_hash && u.reset_expires && u.reset_expires > Date.now()),
    passwordSetBy: u.password_set_by || null,
  };
}

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(plain, salt, 64).toString('hex');
}

function passwordMatches(plain, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = crypto.scryptSync(plain, salt, want.length);
  return crypto.timingSafeEqual(want, got);
}
// Persist this across restarts or every deploy signs everyone out.
const SESSION_SECRET = process.env.CRM_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'finowise_session';

// Load the whole store into memory once at boot; every request reads/writes this
// object, and writeToDisk() persists it. Simple, and correct at this scale.
let store = {};
/* Moves on every write, so the access layer knows when what is in reach
   has to be worked out again. */
let storeRevision = 0;
/* WHO MAY SEE AND CHANGE WHAT (access.js): the two platforms, partner levels
   L1–L7, employee scopes, applied to every read and write of the store. */
const { createAccess, platformOf, PLATFORM_LABEL } = require('./access');
const access = createAccess({ getStore: () => store, revision: () => storeRevision });
if (fs.existsSync(DB_FILE)) {
  try { store = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('Could not parse existing data.json — starting from an empty store. Original error:', e.message); }
}
let writePending = false, writeAgain = false;

/* BACKUPS OF THE STORE. data.json is the whole database and each write
   replaces it. A copy is kept at most once an hour, and once at start-up,
   in backups/ beside it — the last 48 — so a write that should never have
   happened can be undone from the server. */
const BACKUP_DIR = process.env.CRM_BACKUP_DIR || path.join(path.dirname(DB_FILE), 'backups');
const BACKUP_KEEP = Number(process.env.CRM_BACKUP_KEEP) || 48;
let lastBackupAt = 0;
function backupStore(why) {
  if (!fs.existsSync(DB_FILE)) return;
  lastBackupAt = Date.now();
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = 'data-' + new Date().toISOString().replace(/[:.]/g, '-') + (why ? '-' + why : '') + '.json';
    fs.copyFile(DB_FILE, path.join(BACKUP_DIR, name), (err) => {
      if (err) return console.error('Backup failed:', err.message);
      const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^data-.*\.json$/.test(f)).sort().reverse().slice(BACKUP_KEEP);
      old.forEach((f) => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) { /* gone already */ } });
    });
  } catch (e) { console.error('Backup failed:', e.message); }
}
backupStore('start');

/* A WRITE THAT EMPTIES THE TEAM IS REFUSED.
   The team is a whole-array PUT like every store, so a page holding the
   wrong copy — one that failed to load and fell back to nothing — could
   replace every team member with one. Removing someone in BOSS marks them
   deleted; it does not take them out of the list. So a write that drops
   most of the people still on the team is not an edit anybody made, and
   is refused. Reset System and Restore Backup say so with X-CRM-Bulk. */
function teamGuard(oldRaw, newRaw) {
  let before, after;
  try { before = JSON.parse(oldRaw || '[]'); after = JSON.parse(newRaw || '[]'); } catch (e) { return ''; }
  if (!Array.isArray(before) || !Array.isArray(after)) return '';
  const live = before.filter((t) => t && t.id && !t.deletedAt);
  if (live.length < 3) return '';
  const kept = new Set(after.filter((t) => t && t.id).map((t) => t.id));
  const lost = live.filter((t) => !kept.has(t.id));
  if (lost.length * 2 > live.length) {
    return 'Not saved: this would remove ' + lost.length + ' of the ' + live.length + ' people on the team. '
      + 'The page probably did not load the team properly — reload it and try again.';
  }
  return '';
}
/* ---------------------------------------------------------------------
   LIVE UPDATES — one stream for the whole system

   A client fills in their form on their own link; the adviser is looking at
   the record on another screen. Until now the adviser had to press reload to
   see it. This is the one mechanism that fixes that everywhere rather than
   per module: every write the server accepts bumps a version and names the
   collections it touched, and every signed-in browser hears about it over
   one Server-Sent Events stream and re-reads just those collections.

   SSE rather than WebSockets on purpose: the traffic is one-way, it rides
   the HTTP server already running, it reconnects by itself, and it needs no
   dependency — this deploys with `npm ci --omit=dev` onto a small VPS.

   The event carries no record data at all: a version number, the names of
   the collections that changed, and which browser caused it. Reading the
   data still goes through the authenticated API, so the stream widens
   nobody's access.
   --------------------------------------------------------------------- */
let storeVersion = 0;
const liveStreams = new Set();
/* The last few hundred changes, so a browser can ask what it missed rather
   than only being told as it happens. An EventSource is the fast path and
   it is not a guarantee: a proxy can buffer it, a phone can suspend it, a
   laptop lid can close on it, and a browser freezes the timers of a tab
   nobody is looking at. Any of those and the stream goes quiet with
   nothing to say so. This is what /api/changes answers from. */
const changeLog = [];
const CHANGE_LOG_MAX = 300;
let pendingKeys = new Set(), pendingOrigin = null, pendingTimer = null;
function liveSend(res, event, payload) {
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n'); }
  catch (e) { /* a stream that has gone away is cleaned up by its own close handler */ }
}
/* Writes arrive in bursts — one request often saves three collections — so
   they are coalesced into a single event rather than three. */
function publishChange(keys, origin) {
  (keys || []).forEach((k) => k && pendingKeys.add(k));
  /* Writes batched together carry one origin only if they all came from the
     same tab. A batch that mixes a tab's own save with a colleague's used to
     carry the last writer's tab, and that tab then ignored the colleague's
     change as its own: it never reached the screen, and the next save from
     that tab was a step behind. Mixed, or unknown, means "not yours". */
  if (pendingOrigin === null) pendingOrigin = origin || '';
  else if (pendingOrigin !== (origin || '')) pendingOrigin = '';
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const changed = Array.from(pendingKeys); pendingKeys = new Set();
    const origin2 = pendingOrigin || ''; pendingOrigin = null;
    if (!changed.length) return;
    // The version moves whether or not anybody is listening: it is what a
    // browser coming back compares against to know it missed something.
    storeVersion++;
    const payload = { v: storeVersion, keys: changed, origin: origin2, at: new Date().toISOString() };
    changeLog.push(payload);
    if (changeLog.length > CHANGE_LOG_MAX) changeLog.shift();
    if (!liveStreams.size) return;
    liveStreams.forEach((res) => liveSend(res, 'change', payload));
  }, 40);
}

function writeToDisk() {
  storeRevision++;
  if (writePending) { writeAgain = true; return; } // coalesce rapid back-to-back writes into one
  writePending = true;
  const tmpFile = DB_FILE + '.tmp';
  fs.writeFile(tmpFile, JSON.stringify(store), (err) => {
    writePending = false;
    if (err) { console.error('Failed writing data.json:', err); return; }
    fs.rename(tmpFile, DB_FILE, (err2) => { // atomic-ish swap: never leaves a half-written data.json on disk
      if (err2) console.error('Failed finalizing data.json:', err2);
      if (writeAgain) { writeAgain = false; writeToDisk(); }
      if (Date.now() - lastBackupAt > 3600 * 1000) backupStore('');
    });
  });
}

// ------------------------------------------------------- connections store --
/* Connector settings, split into two halves that are treated very differently.
 *
 *   config  — host, port, from-address, which provider, enabled. Not secret.
 *             The browser reads and writes this freely.
 *   secrets — passwords, API keys, access tokens. These go in and never come
 *             back out: no endpoint returns one, and the UI is told only
 *             whether a value is present, so the form can say "leave blank to
 *             keep existing" and mean it.
 *
 * Both live in connections.json, written 0600, beside data.json (outside the
 * repo in production) and never served by /api/storage.
 */
let connections = {};
if (fs.existsSync(CONN_FILE)) {
  try { connections = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8')); }
  catch (e) { console.error('Could not parse connections.json — starting from an empty store. Original error:', e.message); }
}
let connWritePending = false, connWriteAgain = false;
function writeConnections() {
  if (connWritePending) { connWriteAgain = true; return; }
  connWritePending = true;
  const tmpFile = CONN_FILE + '.tmp';
  fs.writeFile(tmpFile, JSON.stringify(connections, null, 2), { mode: 0o600 }, (err) => {
    connWritePending = false;
    if (err) { console.error('Failed writing connections.json:', err); return; }
    fs.rename(tmpFile, CONN_FILE, (err2) => {
      if (err2) console.error('Failed finalizing connections.json:', err2);
      if (connWriteAgain) { connWriteAgain = false; writeConnections(); }
    });
  });
}
// What the browser is allowed to see: everything except the secrets themselves,
// plus a flag per secret saying whether one is stored.
function publicConnection(id) {
  const c = connections[id] || {};
  const secrets = c.secrets || {};
  const has = {};
  Object.keys(secrets).forEach(k => { has[k] = !!(secrets[k] && String(secrets[k]).length); });
  return {
    id,
    config: c.config || {},
    hasSecret: has,
    enabled: !!c.enabled,
    status: c.status || 'Not Connected',
    lastTestAt: c.lastTestAt || null,
    lastTestOk: c.lastTestOk === true,
    lastTestMessage: c.lastTestMessage || null,
    updatedAt: c.updatedAt || null,
    // What the assistant is allowed to do through this connector, and why.
    ai: AI_CONNECTORS.indexOf(id) >= 0 ? aiPrivacyState(id) : null,
    statusDetail: connectorStatusOf(id),
  };
}

/* ---- a real SMTP conversation, using only Node's built-in sockets ----
 * No new dependency (this deployment forbids anything that compiles at install
 * time, and nodemailer would be a dependency to audit for no gain here). It
 * connects, greets, upgrades to TLS where the port calls for it, and — when a
 * username and password are set — actually authenticates. What it reports is
 * what the mail server said.
 */
function smtpTest(opts, cb){ return smtpSession(opts, cb); }
/* The same conversation, with or without a letter to hand over. Without a
   message it is the connection test; with one it delivers, using the envelope
   the caller gives it. One implementation, so a test that passes means a send
   will too. */
function smtpSession({ host, port, secure, username, password, message }, cb) {
  const timeoutMs = 12000;
  let socket = null, done = false, buffer = '', stage = 'connect';
  const finish = (ok, message) => {
    if (done) return; done = true;
    try { if (socket) { socket.removeAllListeners(); socket.destroy(); } } catch (e) {}
    cb({ ok, stage, message });
  };
  const fail = (msg) => finish(false, msg);

  // Each step sends a command and waits for the reply code it expects.
  let steps = [], stepIndex = 0;
  const send = (line) => { try { socket.write(line + '\r\n'); } catch (e) { fail('Could not write to the server: ' + e.message); } };
  const runNext = () => {
    if (stepIndex >= steps.length) return finish(true, message
      ? 'The mail server accepted the message for delivery to ' + message.to.join(', ') + '.'
      : 'Authenticated successfully — the mail server accepted these settings.');
    const step = steps[stepIndex++];
    stage = step.stage;
    if (step.send !== null && step.send !== undefined) send(step.send);
    if (!step.expect) return runNext();
  };
  const onLine = (code, text, lines) => {
    const step = steps[stepIndex - 1];
    if (!step || !step.expect) return;
    if (step.expect.includes(code)) {
      if (step.afterEhlo) return decideTls(lines);
      if (step.afterTls) return upgradeToTls();
      return runNext();
    }
    fail(smtpExplain(stage, code, text));
  };

  // A plain connection is only safe to authenticate over once the server has
  // said it speaks STARTTLS. If it has not, the password would go across in
  // clear text, so say so instead of sending it.
  const decideTls = (lines) => {
    const offersStartTls = (lines || []).some(l => /^STARTTLS\b/i.test(String(l).trim()));
    if (offersStartTls) {
      steps = [{ stage: 'starttls', send: 'STARTTLS', expect: [220], afterTls: true }];
      stepIndex = 0;
      return runNext();
    }
    if (password) {
      return fail('This server did not offer STARTTLS on port ' + port + ', so the password would travel unencrypted. Tick SSL/TLS and use port 465, or check the host and port with your provider.');
    }
    steps = authSteps();
    stepIndex = 0;
    return runNext();
  };

  const attachReader = () => {
    socket.setEncoding('utf8');
    let replyLines = [];
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) > -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        replyLines.push(m[3]);
        if (m[2] === '-') continue; // multi-line reply; keep the capability lines and wait for the last
        const lines = replyLines;
        replyLines = [];
        onLine(Number(m[1]), m[3], lines);
      }
    });
    socket.on('error', (e) => fail('Could not reach ' + host + ':' + port + ' — ' + e.message));
    socket.on('timeout', () => fail('Timed out after ' + (timeoutMs / 1000) + 's talking to ' + host + ':' + port + '.'));
    socket.setTimeout(timeoutMs);
  };

  const upgradeToTls = () => {
    stage = 'starttls';
    const plain = socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('error');
    plain.removeAllListeners('timeout');
    socket = tls.connect({ socket: plain, servername: host, rejectUnauthorized: false }, () => {
      buffer = '';
      attachReader();
      steps = authSteps();
      stepIndex = 0;
      runNext();
    });
    socket.on('error', (e) => fail('TLS handshake failed — ' + e.message));
  };

  const authSteps = () => {
    const list = [{ stage: 'ehlo', send: 'EHLO finowise-crm', expect: [250] }];
    if (username) {
      list.push({ stage: 'auth', send: 'AUTH LOGIN', expect: [334] });
      list.push({ stage: 'auth-user', send: Buffer.from(String(username)).toString('base64'), expect: [334] });
      list.push({ stage: 'auth-pass', send: Buffer.from(String(password || '')).toString('base64'), expect: [235] });
    }
    if (message) {
      list.push({ stage: 'mail-from', send: 'MAIL FROM:<' + message.from + '>', expect: [250] });
      message.to.forEach(addr => list.push({ stage: 'rcpt-to', send: 'RCPT TO:<' + addr + '>', expect: [250, 251] }));
      list.push({ stage: 'data', send: 'DATA', expect: [354] });
      // The body ends with the lone dot that closes DATA; send() adds the CRLF.
      list.push({ stage: 'body', send: message.body + '\r\n.', expect: [250] });
    }
    list.push({ stage: 'quit', send: 'QUIT', expect: null });
    return list;
  };

  const start = () => {
    attachReader();
    if (secure) {
      // Implicit TLS (465): the greeting arrives already encrypted.
      steps = authSteps();
      stepIndex = 0;
      steps.unshift({ stage: 'greeting', send: null, expect: [220] });
      runNext();
    } else {
      steps = [
        { stage: 'greeting', send: null, expect: [220] },
        { stage: 'ehlo', send: 'EHLO finowise-crm', expect: [250], afterEhlo: true },
      ];
      stepIndex = 0;
      runNext();
    }
  };

  try {
    socket = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: false }, start)
      : net.connect({ host, port }, start);
    socket.once('error', (e) => fail('Could not reach ' + host + ':' + port + ' — ' + e.message));
  } catch (e) {
    fail('Could not open a connection — ' + e.message);
  }
}
// Turn an SMTP reply into something worth reading.
function smtpExplain(stage, code, text) {
  if (stage === 'mail-from') return 'The server refused the From address (' + code + ' ' + text + '). It usually has to match the mailbox you signed in as — check From Email on the connector.';
  if (stage === 'rcpt-to') return 'The server refused the recipient (' + code + ' ' + text + '). Check the address, and whether this account is allowed to send outside your organisation.';
  if (stage === 'data' || stage === 'body') return 'The server accepted the envelope but not the message (' + code + ' ' + text + ').';
  if (stage === 'auth-pass' && (code === 535 || code === 534 || code === 530)) {
    return 'The server rejected the username or password (' + code + ' ' + text + '). For Microsoft 365 and Google Workspace this usually means the account needs an app password, or SMTP AUTH is switched off for it.';
  }
  if (stage === 'auth' && code === 503) return 'The server does not accept AUTH on this connection (503 ' + text + '). Try the TLS port instead.';
  if (stage === 'starttls') return 'The server would not start TLS (' + code + ' ' + text + '). Try port 465 with SSL/TLS ticked.';
  if (stage === 'greeting') return 'The server answered, but not with a mail greeting (' + code + ' ' + text + '). Check the host and port.';
  return 'The server replied ' + code + ' ' + text + ' at the ' + stage + ' step.';
}

/* ---- a real HTTPS probe for token-based connectors ----
 * The user supplies the endpoint their provider documents; this calls it for
 * real with the credential attached and reports the status line it got back.
 */
/* An outbound request can end twice: a timeout destroys the socket, and the
   destroy then raises 'error'. Answering the browser twice throws inside an
   event handler, which nothing catches, and the whole process goes down. So
   every request callback answers once and ignores what comes after. */
function callOnce(cb) {
  let done = false;
  return (...args) => { if (done) return; done = true; cb(...args); };
}
function httpsProbe({ url, method, headers, body }, cb) {
  cb = callOnce(cb);
  let target;
  try { target = new URL(url); } catch (e) { return cb({ ok: false, message: 'That is not a valid URL.' }); }
  if (target.protocol !== 'https:') return cb({ ok: false, message: 'Use an https:// endpoint — a credential must not travel over plain http.' });
  const req = https.request({
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    method: method || 'GET',
    headers: Object.assign({ 'User-Agent': 'Finowise-CRM/1.0', 'Accept': 'application/json' }, headers || {}),
    timeout: 12000,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { if (data.length < 2000) data += d; });
    res.on('end', () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      const snippet = data.trim().replace(/\s+/g, ' ').slice(0, 220);
      cb({
        ok,
        message: ok
          ? 'The provider answered ' + res.statusCode + '. The credential was accepted.'
          : 'The provider answered ' + res.statusCode + ' ' + (res.statusMessage || '') + (snippet ? ' — ' + snippet : '') +
            (res.statusCode === 401 || res.statusCode === 403 ? ' This usually means the key or token is wrong, expired, or lacks the required scope.' : ''),
      });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, message: 'The provider did not answer within 12 seconds.' }); });
  req.on('error', (e) => cb({ ok: false, message: 'Could not reach the provider — ' + e.message }));
  if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
}

// httpsProbe reports whether a call worked; this one also hands back what
// came back, for the calls where the answer is the point.
function httpsProbeJson(opts, cb) {
  cb = callOnce(cb);
  let target;
  try { target = new URL(opts.url); } catch (e) { return cb({ ok: false, message: 'That is not a valid URL.' }); }
  if (target.protocol !== 'https:') return cb({ ok: false, message: 'Use an https:// endpoint.' });
  const req = https.request({
    hostname: target.hostname, port: target.port || 443,
    path: target.pathname + target.search, method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'Finowise-CRM/1.0', 'Accept': 'application/json' }, opts.headers || {}),
    timeout: 15000,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', d => { if (data.length < 20000) data += d; });
    res.on('end', () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      let json = null;
      try { json = JSON.parse(data); } catch (e) { /* not json, which is itself informative */ }
      const why = json && json.error ? (json.error.message || json.error) : data.trim().replace(/\s+/g, ' ').slice(0, 220);
      cb({ ok, json, status: res.statusCode, message: ok ? 'OK' : ('HTTP ' + res.statusCode + (why ? ' — ' + why : '')) });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, message: 'The provider did not answer within 15 seconds.' }); });
  req.on('error', e => cb({ ok: false, message: 'Could not reach the provider — ' + e.message }));
  if (opts.body) req.write(opts.body);
  req.end();
}

const app = express();
app.set('trust proxy', 1); // nginx terminates TLS; needed for secure-cookie detection
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false })); // the sign-in form posts a normal HTML form // the Task Bank + Zoho mapping data is large; default 100kb limit would reject real saves

// ------------------------------------------------------------------ users --
// Adding accounts, for admins only. A plain server-rendered page rather than
// anything inside the CRM itself, so the app's own screens are untouched.
function usersPage({ error = null, added = null, removed = null, meId = null } = {}) {
  const rows = listUsers.all().map((u) => `
        <tr${u.active === 0 ? ' class="off"' : ''}>
          <td>${esc(u.email)}${u.member_id ? '<div class="sub2">from the Team Members module</div>' : ''}</td>
          <td class="role">${esc(u.crm_role || (u.role === 'admin' ? 'Admin' : 'User'))}
            ${u.role === 'admin' ? '<span class="tag">admin</span>' : ''}</td>
          <td class="pw">${u.active === 0
            ? '<span class="muted">deactivated</span>'
            : u.must_change
              ? '<span class="muted">temporary password, not yet changed</span>'
              : u.password_set_by === 'user'
                ? '<span class="muted">set by them ' + esc(u.password_set_at || '') + '</span>'
              : u.last_login_at
                ? '<span class="muted">used ' + esc(u.last_login_at) + '</span>'
                : '<span class="muted">set by hand</span>'}</td>
          <td class="when">${esc(u.created_at)}</td>
          <td class="act">${u.id === meId
            ? '<span class="muted">this is you</span>'
            : `<form method="POST" action="/users/delete" onsubmit="return confirm('Delete the account for ${esc(u.email)}?\n\nThey will not be able to sign in. Their work in the CRM is untouched.')">
                 <input type="hidden" name="id" value="${u.id}">
                 <button type="submit" class="danger">Delete</button>
               </form>`}</td>
        </tr>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Users — BOSS</title>
<link rel="icon" type="image/png" href="${FALLBACK_LOGO}">
<style>
  :root{ --navy:#0F1B2D; --navy-2:#152541; --gold:#B9863E; --line:#E4E7EC;
         --text:#1B2233; --muted:#6B7280; --ok:#1E7F5C; --danger:#B3432B;
         --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif; }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:#F5F6F8;font-family:var(--font);color:var(--text);padding:32px 16px}
  h1{font-family:Georgia,serif;font-weight:400;font-size:23px;margin:0 0 4px}
  .sub{font-size:12px;color:var(--muted);margin-bottom:22px}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 20px;margin-bottom:18px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin:0 0 14px}
  label{display:block;font-size:12.5px;font-weight:600;margin:0 0 6px}
  input{width:100%;padding:11px 13px;font-size:15px;font-family:inherit;border:1px solid var(--line);
        border-radius:9px;margin-bottom:14px}
  input:focus{outline:none;border-color:var(--gold);box-shadow:0 0 0 3px rgba(185,134,62,.16)}
  button{padding:11px 18px;font-family:inherit;font-size:14px;font-weight:600;color:#fff;
         background:var(--navy);border:1px solid var(--navy);border-radius:9px;cursor:pointer}
  button:hover{background:var(--navy-2)}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);
     padding:0 0 8px;border-bottom:1px solid var(--line)}
  td{padding:10px 0;border-bottom:1px solid var(--line)}
  .wrap{max-width:820px;margin:0 auto}
  td:first-child{word-break:break-all;padding-right:14px}
  .role{color:var(--muted);width:150px}
  .when{color:var(--muted);width:135px}
  .act{width:84px;text-align:right}
  .act form{margin:0}
  button.danger{padding:5px 10px;font-size:12px;font-weight:600;color:var(--danger);background:#fff;
    border:1px solid rgba(179,67,43,.35);border-radius:7px;cursor:pointer}
  button.danger:hover{background:rgba(179,67,43,.08)}
  .pw{width:150px}
  .pw code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;
    background:rgba(185,134,62,.12);border:1px solid rgba(185,134,62,.3);border-radius:6px;padding:2px 6px}
  .muted{color:var(--muted);font-size:12px}
  .sub2{color:var(--muted);font-size:11px;margin-top:2px}
  .tag{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--gold);margin-left:4px}
  tr.off td{opacity:.55}
  .note{font-size:12px;color:var(--muted);margin-top:12px;line-height:1.5}
  .msg{padding:10px 12px;border-radius:9px;font-size:13px;margin-bottom:16px}
  .msg.ok{color:var(--ok);background:rgba(30,127,92,.08);border:1px solid rgba(30,127,92,.25)}
  .msg.bad{color:var(--danger);background:rgba(179,67,43,.08);border:1px solid rgba(179,67,43,.25)}
  a.back{display:inline-block;margin-top:6px;font-size:13px;color:var(--navy)}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Users</h1>
    <div class="sub">Who can sign in to the CRM</div>
    ${added ? `<div class="msg ok">Added ${esc(added)}.</div>` : ''}
    ${removed ? `<div class="msg ok">Deleted ${esc(removed)}. They can no longer sign in.</div>` : ''}
    ${error ? `<div class="msg bad">${esc(error)}</div>` : ''}
    <div class="card">
      <h2>Adding somebody</h2>
      <p>An account is made by adding the person in <b>BOSS &rsaquo; Team Members</b>. Doing it there creates
      their sign-in at the same time, sends them their password, and files their role, branch, reporting line
      and access against the same record &mdash; which is the point: a person and their account are one thing,
      and making them in two places is how the two drift apart.</p>
      <p><a class="btn" href="/">Open BOSS</a></p>
      <p class="hint">A system with nobody in it yet is the one exception, and it has its own way in:
      <code>npm run user -- add you@firm.in &lt;password&gt;</code> from the server.</p>
    </div>
    <div class="card">
      <h2>Existing</h2>
      <table>
        <tr><th>Email</th><th>Role</th><th>Password</th><th>Added</th><th></th></tr>${rows}
      </table>
      <div class="note">Accounts made from the Team Members module carry the password the CRM
        generated and emailed to that person. It is shown here only until they sign in with it;
        after that, issue a new one from their profile in the CRM. An account is deactivated by
        marking the member Inactive, which also ends any session they have open.</div>
    </div>
    <a class="back" href="/">&larr; Back to the CRM</a>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------- sign-in --
// Session cookie is "<expiry>.<hmac>" — no server-side session store to keep in
// sync, and a restart doesn't sign everyone out as long as CRM_SESSION_SECRET
// is set in the environment.
function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(value)).digest('hex');
}
/* The signature also covers a fingerprint of the account's password hash, so
   a new password — chosen, reset or issued by an admin — ends every session
   signed with the old one, including a cookie somebody copied. */
function passwordStamp(userId) {
  const u = findUserById.get(Number(userId));
  return crypto.createHash('sha256').update(String((u && u.password_hash) || '')).digest('hex').slice(0, 16);
}
function issueToken(userId) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  return `${userId}.${exp}.${sign(userId + '.' + exp + '.' + passwordStamp(userId))}`;
}
// After a person changes their own password, the session they are using is
// signed again so it is the one that survives.
function renewSessionCookie(req, res, userId) {
  res.cookie(COOKIE, issueToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}
function userIdFromToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || !/^\d+$/.test(id) || !/^\d+$/.test(exp)) return null;
  if (Number(exp) < Date.now()) return null;
  const expected = Buffer.from(sign(id + '.' + exp + '.' + passwordStamp(id)));
  const given = Buffer.from(sig);
  // Fixed-length compare: timingSafeEqual throws on a length mismatch.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return Number(id);
}
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1));
  }
  return null;
}
function signedInUser(req) {
  const id = userIdFromToken(readCookie(req, COOKIE));
  const user = id ? findUserById.get(id) : undefined;
  // Deactivating somebody in the CRM ends the session they already have, at
  // their next request, rather than whenever the cookie happens to expire.
  if (user && user.active === 0) return undefined;
  return user;
}
function isSignedIn(req) {
  return !!signedInUser(req);
}

// Slow down password guessing. In-memory and per-process, which is all this
// single-process deployment needs.
const attempts = new Map();
const MAX_ATTEMPTS = 8, ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > ATTEMPT_WINDOW_MS) { attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function noteFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > ATTEMPT_WINDOW_MS) attempts.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

// Only ever redirect back to a path on this site, never to an absolute URL
// somebody appended to the query string.
function safeNext(value) {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) ? value : '/';
}

// The CRM keeps its own company branding in the "config" key; reuse whatever
// logo and name have been set there so the door matches the building.
// The mark the door shows before anybody has saved company settings —
// the firm's own, the same drawing the application ships with, rather
// than the generic monogram that used to stand here. Once a logo is set
// in Setup it comes from the data file like everything else in
// branding(), and this is never reached.
const FALLBACK_LOGO = 'data:image/png;base64,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';
// The Finowise build's name for the same fallback.
const DEFAULT_LOGO = FALLBACK_LOGO;
const PREVIOUS_SHIPPED_LOGO_SIG = 'iVBORw0KGgoAAAANSUhEUgAAAlgAAAH7CAYAAAAQBuEBAAEAAElEQVR42ux9d6BlVXX+t/Y+5bb3pjN0UBBwBCwggm3ECoLdIZbYFY0tlp8aEw0h1RSNUWMS';

function branding() {
  const fallback = { name: 'BOSS', tagline: 'Wealth Management', logo: DEFAULT_LOGO };
  try {
    const company = (JSON.parse(store.config || '{}').company) || {};
    return {
      name: company.name || fallback.name,
      tagline: company.tagline || fallback.tagline,
      logo: (company.logoDataUrl && !company.logoDataUrl.includes(PREVIOUS_SHIPPED_LOGO_SIG) ? company.logoDataUrl : null)
        || company.logoUrl || DEFAULT_LOGO,
    };
  } catch (e) { return fallback; }
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* The address of the other platform, from this one: partner.x <-> one.x. */
function platformAddress(req, want) {
  const env = want === 'partner' ? process.env.CRM_PARTNER_URL : process.env.CRM_COMPANY_URL;
  if (env) return env;
  const host = String(req.headers.host || '').replace(/^(partner|one)\./i, '');
  return 'https://' + (want === 'partner' ? 'partner.' : 'one.') + host;
}
function loginPage({ error = null, next = '/', email = '', platform = 'combined' } = {}) {
  const b = branding();
  const mark = `<img class="logo-img" src="${esc(b.logo || FALLBACK_LOGO)}" alt="${esc(b.name)}">`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Sign in — ${esc(b.name)}</title>
<link rel="icon" href="${esc(b.logo || FALLBACK_LOGO)}">
<style>
  :root{
    --navy:#0F1B2D; --navy-2:#152541; --gold:#B9863E; --gold-light:#E8D3AE;
    --card:#FFFFFF; --line:#E4E7EC; --text:#1B2233; --muted:#6B7280; --danger:#B3432B;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif;
  }
  *{box-sizing:border-box}
  body{
    margin:0; min-height:100vh; font-family:var(--font); color:var(--text);
    background:
      radial-gradient(900px 480px at 50% -10%, rgba(185,134,62,.22), transparent 70%),
      linear-gradient(165deg, var(--navy) 0%, var(--navy-2) 55%, #0B1524 100%);
    display:flex; align-items:center; justify-content:center;
    padding:32px 16px;
  }
  .wrap{width:100%; max-width:400px}
  .card{
    background:var(--card); border-radius:14px; padding:36px 30px 28px;
    box-shadow:0 24px 60px rgba(0,0,0,.38), 0 2px 6px rgba(0,0,0,.2);
  }
  /* The mark is the whole of the masthead now — no wordmark under it, no
     tagline — so it carries the card on its own and is sized to. */
  .mark{display:flex; justify-content:center; margin-bottom:4px}
  .logo-img{max-height:128px; max-width:300px; width:auto; display:block}
  .rule{height:1px; background:var(--line); margin:24px 0 22px}
  .platform{text-align:center; margin-top:10px; font-size:12px; font-weight:700; letter-spacing:1.4px;
    text-transform:uppercase; color:var(--gold)}
  label{display:block; font-size:12.5px; font-weight:600; margin-bottom:7px; letter-spacing:.2px}
  input[type=password], input[type=email]{
    width:100%; padding:12px 13px; font-size:15px; font-family:inherit; color:var(--text);
    border:1px solid var(--line); border-radius:9px; background:#fff; transition:border-color .15s, box-shadow .15s;
  }
  input[type=password]:focus, input[type=email]:focus{
    outline:none; border-color:var(--gold); box-shadow:0 0 0 3px rgba(185,134,62,.16);
  }
  button{
    width:100%; margin-top:18px; padding:12px 16px; font-family:inherit;
    font-size:14.5px; font-weight:600; letter-spacing:.3px; color:#fff; cursor:pointer;
    background:var(--navy); border:1px solid var(--navy); border-radius:9px;
    transition:background .15s, transform .05s;
  }
  button:hover{background:var(--navy-2)}
  button:active{transform:translateY(1px)}
  .error{
    margin:0 0 18px; padding:11px 13px; border-radius:9px; font-size:13px;
    color:var(--danger); background:rgba(179,67,43,.08); border:1px solid rgba(179,67,43,.25);
  }
  .foot{
    text-align:center; margin-top:22px; font-size:11.5px; color:rgba(255,255,255,.45);
    letter-spacing:.2px;
  }
  @media (max-width:420px){ .card{padding:30px 22px 24px}
    .logo-img{max-height:96px; max-width:220px} }
</style>
</head>
<body>
  <div class="wrap">
    <form class="card" method="POST" action="/login">
      <input type="hidden" name="next" value="${esc(next)}">
      <div class="mark">${mark}</div>
      ${PLATFORM_LABEL[platform] ? `<div class="platform">${esc(PLATFORM_LABEL[platform])}</div>` : ''}
      <div class="rule"></div>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username"
             autofocus required value="${esc(email)}" placeholder="you@company.com">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password"
             required placeholder="Enter password">
      <button type="submit">Sign in</button>
    </form>
    <div class="foot">Authorised access only</div>
  </div>
</body>
</html>`;
}

app.get('/login', (req, res) => {
  if (isSignedIn(req)) return res.redirect(safeNext(req.query.next));
  const page = loginPage({ next: safeNext(req.query.next), platform: platformOf(req) });
  const done = req.query.done === 'reset'
    ? page.replace('<div class="rule"></div>', '<div class="rule"></div><p class="error" style="color:var(--ok,#047857);background:rgba(4,120,87,.08);border-color:rgba(4,120,87,.25)">Your password is set. Sign in with it.</p>')
    : page;
  res.type('html').set('Cache-Control', 'no-store').send(done);
});

/* ---------------------------------------------------------------------
   PASSWORDS — CHOSEN BY THE PERSON, NEVER READABLE BY ANYBODY

   Stored as a salted scrypt hash (hashPassword), which is what bcrypt is
   for and needs nothing compiled at install time. Nobody, admin included,
   can read one: an issued password is emailed once and must be replaced at
   the next sign-in; an admin who needs somebody back in sends a reset link.
   --------------------------------------------------------------------- */
function passwordFormPage({ title, intro, action, hidden = {}, error = null, withCurrent = false }) {
  const page = loginPage({});
  const hiddenHtml = Object.entries(hidden).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  const form = `<form class="card" method="POST" action="${esc(action)}" autocomplete="off">
      ${hiddenHtml}
      <div class="rule"></div>
      <h2 style="margin:0 0 6px;font-size:18px">${esc(title)}</h2>
      <p style="margin:0 0 14px;font-size:13px;opacity:.85">${esc(intro)}</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      ${withCurrent ? `<label for="current">Current password</label>
      <input id="current" name="current" type="password" autocomplete="current-password" required>` : ''}
      <label for="password">New password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
      <label for="confirm">Confirm new password</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="8">
      <p style="margin:8px 0 0;font-size:12px;opacity:.75">At least 8 characters, with capital and small letters, a number and a symbol.</p>
      <button type="submit">Set password</button>
    </form>`;
  return page.replace(/<form class="card"[\s\S]*?<\/form>/, form);
}
function checkNewPassword(body) {
  const p = String((body || {}).password || ''), c = String((body || {}).confirm || '');
  if (p !== c) return 'The two passwords do not match.';
  return passwordProblem(p);
}

// After signing in with an issued password: choose your own.
app.get('/set-password', (req, res) => {
  const u = signedInUser(req);
  if (!u) return res.redirect('/login');
  res.type('html').set('Cache-Control', 'no-store').send(passwordFormPage({ title: 'Choose your password',
    intro: 'You signed in with a password that was issued to you. Choose your own now — nobody else, admins included, will be able to see it.',
    action: '/set-password', hidden: { next: safeNext(req.query.next) } }));
});
app.post('/set-password', (req, res) => {
  const u = signedInUser(req);
  if (!u) return res.redirect('/login');
  const next = safeNext((req.body || {}).next);
  res.set('Cache-Control', 'no-store');
  const wrong = checkNewPassword(req.body);
  if (wrong) return res.status(400).type('html').send(passwordFormPage({ title: 'Choose your password', error: wrong,
    intro: 'You signed in with a password that was issued to you. Choose your own now.', action: '/set-password', hidden: { next } }));
  if (passwordMatches(String(req.body.password), u.password_hash))
    return res.status(400).type('html').send(passwordFormPage({ title: 'Choose your password', error: 'Choose a password different from the one you were issued.',
      intro: 'You signed in with a password that was issued to you. Choose your own now.', action: '/set-password', hidden: { next } }));
  setOwnPassword.run(hashPassword(String(req.body.password)), u.id);
  renewSessionCookie(req, res, u.id);
  res.redirect(next);
});

// From the profile: change it, knowing the current one.
app.post('/api/me/password', checkApiKey, (req, res) => {
  const u = signedInUser(req);
  res.set('Cache-Control', 'no-store');
  if (!u) return res.status(401).json({ ok: false, message: 'Sign in again first.' });
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) return res.status(429).json({ ok: false, message: 'Too many attempts. Wait a few minutes and try again.' });
  const body = req.body || {};
  if (!u.must_change && !passwordMatches(String(body.current || ''), u.password_hash)) {
    noteFailure(ip);
    return res.status(400).json({ ok: false, message: 'Your current password is not right.' });
  }
  const wrong = checkNewPassword(body);
  if (wrong) return res.status(400).json({ ok: false, message: wrong });
  if (passwordMatches(String(body.password), u.password_hash)) return res.status(400).json({ ok: false, message: 'The new password is the same as the current one.' });
  setOwnPassword.run(hashPassword(String(body.password)), u.id);
  renewSessionCookie(req, res, u.id);
  attempts.delete(ip);
  res.json({ ok: true, account: accountJson(findUserById.get(u.id)) });
});

// An admin sends somebody a link to choose a new password. Only the link's
// hash is kept, it works once, and it stops working after a day.
app.post('/api/users/:memberId/reset', checkApiKey, requireApiAdmin, (req, res) => {
  const user = findUserByMember.get(String(req.params.memberId || ''));
  res.set('Cache-Control', 'no-store');
  if (!user) return res.status(404).json({ ok: false, message: 'That team member has no sign-in account yet.' });
  if (user.active === 0) return res.status(409).json({ ok: false, message: 'That account is deactivated.' });
  const token = crypto.randomBytes(32).toString('base64url');
  const link = originOf(req) + '/reset-password?token=' + encodeURIComponent(token);
  const firm = branding().name;
  sendMail({
    to: user.email,
    subject: 'Set a new password for ' + firm,
    body: 'Hello,\n\nAn administrator has asked for you to set a new password for your ' + firm + ' account (' + user.email + ').\n\n'
      + 'Choose it here — the link works once, within 24 hours:\n\n    ' + link
      + '\n\nUntil you do, the password you have now still works. If you did not expect this, tell an administrator.',
  }, null, (status, json) => {
    if (!(status === 200 && json && json.ok))
      return res.status(503).json({ ok: false, message: 'The link could not be emailed (' + ((json && json.message) || 'the mail server refused it')
        + '). Check the email connector, or issue a temporary password instead.' });
    setResetToken.run(resetHash(token), Date.now() + RESET_TTL_MS, user.id);
    res.json({ ok: true, emailed: user.email, account: accountJson(findUserById.get(user.id)) });
  });
});

function resetUserFor(token) {
  if (!token) return null;
  const u = findUserByReset.get(resetHash(token));
  return u && u.reset_expires > Date.now() && u.active !== 0 ? u : null;
}
app.get('/reset-password', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = String(req.query.token || '');
  if (!resetUserFor(token)) return res.status(410).type('html').send(loginPage({ platform: platformOf(req), error: 'That reset link has expired or has already been used. Ask an administrator for a new one.' }));
  res.type('html').send(passwordFormPage({ title: 'Choose a new password', action: '/reset-password', hidden: { token },
    intro: 'Choose the password you will sign in with. Nobody else, admins included, will be able to see it.' }));
});
app.post('/reset-password', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = String((req.body || {}).token || '');
  const u = resetUserFor(token);
  if (!u) return res.status(410).type('html').send(loginPage({ platform: platformOf(req), error: 'That reset link has expired or has already been used. Ask an administrator for a new one.' }));
  const wrong = checkNewPassword(req.body);
  if (wrong) return res.status(400).type('html').send(passwordFormPage({ title: 'Choose a new password', action: '/reset-password', hidden: { token }, error: wrong,
    intro: 'Choose the password you will sign in with.' }));
  setOwnPassword.run(hashPassword(String(req.body.password)), u.id);
  res.redirect('/login?done=reset');
});

app.post('/login', (req, res) => {
  const next = safeNext((req.body || {}).next);
  const ip = req.ip || 'unknown';
  res.set('Cache-Control', 'no-store');

  if (tooManyAttempts(ip)) {
    return res.status(429).type('html')
      .send(loginPage({ platform: platformOf(req), error: 'Too many attempts. Wait a few minutes and try again.', next,
                       email: String((req.body || {}).email || '').trim() }));
  }
  const email = String((req.body || {}).email || '').trim();
  const password = String((req.body || {}).password || '');
  const user = findUserByEmail.get(email);
  // A member who has been deactivated in the CRM cannot sign in. Same message
  // as a wrong password, so the page still says nothing about who exists.
  if (user && user.active === 0) {
    noteFailure(ip);
    return res.status(401).type('html')
      .send(loginPage({ platform: platformOf(req), error: 'That email and password do not match.', next, email }));
  }
  // One message for both cases, so this cannot be used to discover which emails exist.
  if (!user || !passwordMatches(password, user.password_hash)) {
    noteFailure(ip);
    return res.status(401).type('html')
      .send(loginPage({ platform: platformOf(req), error: 'That email and password do not match.', next, email }));
  }
  attempts.delete(ip);
  /* Partners sign in on the partner platform, employees on the company
     platform (access.js). The password was right, so saying where to go
     gives nothing away. */
  {
    const platform = platformOf(req);
    if (!access.mayUsePlatform(access.principal(user), platform)) {
      return res.status(403).type('html').send(loginPage({ next, email, platform,
        error: platform === 'partner'
          ? 'This is the Partner Platform. Company staff sign in at ' + platformAddress(req, 'company') + '.'
          : 'This is the Company Platform. Partners sign in at ' + platformAddress(req, 'partner') + '.' }));
    }
  }
  if (user.two_factor) {
    // The password was right; the session waits for the emailed code.
    const ch = newOtpChallenge(user, 'login', next);
    return sendOtp(ch, (err) => {
      if (err) {
        otpChallenges.delete(ch.id);
        return res.status(503).type('html').send(loginPage({ platform: platformOf(req), next, email,
          error: 'Your account uses two-step sign-in, but the code could not be emailed (' + err
            + '). Ask an administrator to check the email connector.' }));
      }
      res.cookie(OTP_COOKIE, ch.id, { httpOnly: true, sameSite: 'lax', path: '/login',
        secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: OTP_TTL_MS * 2 });
      res.redirect('/login/otp');
    });
  }
  completeSignIn(req, res, user, next);
});

function completeSignIn(req, res, user, next) {
  // They have used the password they were sent, so the copy an admin could
  // read is deleted. Anyone who needs to give them one again issues a new one.
  noteUserLogin.run(user.id);
  noteLoginAlert(req, user);
  res.cookie(COOKIE, issueToken(user.id), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
  // A password somebody else issued is replaced before anything else.
  const fresh = findUserById.get(user.id);
  if (fresh && fresh.must_change) return res.redirect('/set-password?next=' + encodeURIComponent(next));
  res.redirect(next);
}

/* ---------------------------------------------------------------------
   TWO-STEP SIGN-IN

   An account with two_factor on is not signed in by its password alone:
   a six-digit code is emailed to the account's own address and the
   session is issued only once it is typed. The code is random
   (crypto.randomInt), kept only as a keyed hash, good for five minutes
   and for five wrong tries, and can be sent again up to three times, no
   sooner than thirty seconds apart. Challenges live in memory: a restart
   in the middle of one simply means signing in again.

   Turning it on, and off, takes a code too, so a session left open on
   somebody's desk cannot quietly switch it off, and nobody can turn it
   on with an address that never receives mail and lock themselves out.
   If the mailbox is lost, an administrator on the server runs
     npm run user -- 2fa someone@company.com off
   --------------------------------------------------------------------- */
const OTP_COOKIE = 'finowise_otp';
const OTP_TTL_MS = 5 * 60 * 1000, OTP_MAX_TRIES = 5, OTP_RESEND_GAP_MS = 30 * 1000, OTP_MAX_RESENDS = 3;
const otpChallenges = new Map();
function otpHash(id, code) { return sign('otp.' + id + '.' + code); }
function newOtpChallenge(user, purpose, next) {
  for (const [k, c] of otpChallenges) if (c.expires < Date.now() - OTP_TTL_MS) otpChallenges.delete(k);
  // One pending challenge per account and purpose: a new one replaces the old.
  for (const [k, c] of otpChallenges) if (c.userId === user.id && c.purpose === purpose) otpChallenges.delete(k);
  const ch = { id: crypto.randomBytes(24).toString('hex'), userId: user.id, email: user.email, purpose,
    next: next || '/', tries: 0, resends: 0, sentAt: 0, expires: 0, hash: '' };
  otpChallenges.set(ch.id, ch);
  return ch;
}
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return email;
  return name.slice(0, 2) + '*'.repeat(Math.max(1, name.length - 2)) + '@' + domain;
}
function sendOtp(ch, cb) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  ch.hash = otpHash(ch.id, code);
  ch.sentAt = Date.now();
  ch.expires = Date.now() + OTP_TTL_MS;
  ch.tries = 0;
  const what = ch.purpose === 'login' ? 'sign in to'
    : ch.purpose === 'enable' ? 'turn on two-step sign-in for' : 'turn off two-step sign-in for';
  const firm = branding().name;
  sendMail({
    to: ch.email,
    subject: code + ' is your ' + firm + ' verification code',
    body: 'Your verification code to ' + what + ' your ' + firm + ' account is:\n\n    ' + code
      + '\n\nIt expires in 5 minutes. Nobody from the firm will ever ask you for it.\n\n'
      + 'If you did not just try to do this, someone may know your password: change it, and tell an administrator.',
  }, null, (status, json) => {
    if (status === 200 && json && json.ok) return cb(null);
    cb((json && json.message) || 'the mail server refused it');
  });
}
// null when the code is right; otherwise why not. A wrong try is counted.
function checkOtp(ch, code) {
  if (!ch || ch.expires < Date.now()) return 'expired';
  if (ch.tries >= OTP_MAX_TRIES) return 'locked';
  const given = Buffer.from(otpHash(ch.id, String(code || '').replace(/\s/g, '')));
  const want = Buffer.from(ch.hash);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return null;
  ch.tries++;
  return ch.tries >= OTP_MAX_TRIES ? 'locked' : 'wrong';
}
function resendProblem(ch) {
  if (ch.resends >= OTP_MAX_RESENDS) return 'The code has been sent ' + (OTP_MAX_RESENDS + 1) + ' times already. Start again.';
  const wait = Math.ceil((ch.sentAt + OTP_RESEND_GAP_MS - Date.now()) / 1000);
  if (wait > 0) return 'Wait ' + wait + ' more second' + (wait === 1 ? '' : 's') + ' before asking for another code.';
  return null;
}

/* A sign-in is told to the person it belongs to, inside BOSS, when they
   have asked for desktop notifications: every tab they have open hears
   it, and a sign-in they did not make is something they find out about
   at once rather than never. */
function noteLoginAlert(req, user) {
  if (!user || !user.member_id) return;
  try {
    const team = JSON.parse(store.team || '[]');
    const member = Array.isArray(team) ? team.find((t) => t && t.id === user.member_id) : null;
    if (!member || !member.desktopNotifEnabled) return;
    const list = JSON.parse(store.notifications || '[]');
    if (!Array.isArray(list)) return;
    const ua = String(req.get('user-agent') || '');
    const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    const now = new Date();
    list.push({ id: 'NTF-' + crypto.randomBytes(6).toString('hex'), at: now.toISOString(), userId: member.id,
      title: 'New sign-in to your account',
      body: 'Signed in from ' + browser + ' (' + (req.ip || 'unknown address') + ') at '
        + now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC. If this was not you, change your password now.',
      view: 'profile', arg: '', kind: 'login-alert', by: member.id });
    store.notifications = JSON.stringify(list);
    writeToDisk();
    publishChange(['notifications'], 'server');
  } catch (e) { /* an alert that cannot be written must not stop the sign-in */ }
}

function otpPage({ ch, error = null, info = null }) {
  const page = loginPage({ next: ch.next });
  const form = `<form class="card" method="POST" action="/login/otp">
      <div class="rule" style="margin-top:0"></div>
      <h2 style="margin:0 0 6px;font-size:18px">Enter your sign-in code</h2>
      <p style="margin:0 0 18px;font-size:13px;color:var(--muted)">We emailed a 6-digit code to
        <b>${esc(maskEmail(ch.email))}</b>. It expires in 5 minutes.</p>
      ${error ? `<p class="error">${esc(error)}</p>` : ''}
      ${info ? `<p class="error" style="color:#166534;background:rgba(22,101,52,.08);border-color:rgba(22,101,52,.25)">${esc(info)}</p>` : ''}
      <label for="code">Code</label>
      <input id="code" name="code" type="password" inputmode="numeric" autocomplete="one-time-code"
             maxlength="6" pattern="[0-9]{6}" autofocus required placeholder="123456"
             style="width:100%;padding:12px 13px;font-size:18px;letter-spacing:6px;border:1px solid var(--line);border-radius:9px">
      <button type="submit">Verify and sign in</button>
      <button type="submit" formaction="/login/otp/resend" formnovalidate
        style="background:#fff;color:var(--navy);margin-top:10px">Send a new code</button>
      <p style="margin:16px 0 0;font-size:12.5px;text-align:center"><a href="/login">Use a different account</a></p>
    </form>`;
  return page.replace(/<form class="card"[\s\S]*?<\/form>/, () => form);
}
function otpChallengeOf(req) {
  const ch = otpChallenges.get(readCookie(req, OTP_COOKIE) || '');
  return ch && ch.purpose === 'login' ? ch : null;
}
function otpRestart(res, why) {
  res.clearCookie(OTP_COOKIE, { path: '/login' });
  return res.status(401).type('html').send(loginPage({ platform: platformOf(res.req), error: why }));
}
app.get('/login/otp', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ch = otpChallengeOf(req);
  if (!ch || ch.expires < Date.now()) return otpRestart(res, 'That sign-in has expired. Sign in again to get a new code.');
  res.type('html').send(otpPage({ ch }));
});
app.post('/login/otp', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = req.ip || 'unknown';
  const ch = otpChallengeOf(req);
  if (!ch) return otpRestart(res, 'That sign-in has expired. Sign in again to get a new code.');
  const why = checkOtp(ch, (req.body || {}).code);
  if (why === 'expired') { otpChallenges.delete(ch.id); return otpRestart(res, 'That code has expired. Sign in again to get a new one.'); }
  if (why === 'locked') { otpChallenges.delete(ch.id); noteFailure(ip); return otpRestart(res, 'Too many wrong codes. Sign in again to get a new one.'); }
  if (why) {
    noteFailure(ip);
    return res.status(401).type('html').send(otpPage({ ch,
      error: 'That code is not right. ' + (OTP_MAX_TRIES - ch.tries) + ' tr' + (OTP_MAX_TRIES - ch.tries === 1 ? 'y' : 'ies') + ' left.' }));
  }
  otpChallenges.delete(ch.id);
  const user = findUserById.get(ch.userId);
  if (!user || user.active === 0) return otpRestart(res, 'That email and password do not match.');
  res.clearCookie(OTP_COOKIE, { path: '/login' });
  completeSignIn(req, res, user, ch.next);
});
app.post('/login/otp/resend', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ch = otpChallengeOf(req);
  if (!ch) return otpRestart(res, 'That sign-in has expired. Sign in again to get a new code.');
  const wait = resendProblem(ch);
  if (wait) return res.status(429).type('html').send(otpPage({ ch, error: wait }));
  ch.resends++;
  sendOtp(ch, (err) => {
    if (err) return res.status(503).type('html').send(otpPage({ ch, error: 'The new code could not be emailed: ' + err }));
    res.type('html').send(otpPage({ ch, info: 'A new code is on its way. Only the newest code works.' }));
  });
});

app.post('/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/login'); });
app.get('/logout',  (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.redirect('/login'); });

// Everything below this line needs a session. /api/health stays open so the
// deploy script can tell a release apart from a broken one without a password.
//
// (the users routes sit after this gate, so they are signed in by the time
// they are reached, and the admin check below is the only extra condition)
// A client with a form link has no account and should not need one. The page
// itself, and the three endpoints it uses, are open; every one of them checks
// the token and serves nothing beyond what that token names. /config.js is
// open too, and simply hands out nothing when nobody is signed in.
const PUBLIC_DIR = path.join(__dirname, 'public');
function isPublicCodeFile(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!/\.(js|css)$/.test(req.path) || req.path.startsWith('/api/')) return false;
  const file = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(req.path));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  try { return fs.statSync(file).isFile(); } catch (e) { return false; }
}
const PUBLIC_ASSET = /^\/(?:[\w-]+\.js|review\/[\w-]+\.(?:js|css)|lib\/[\w-]+\/[\w.-]+\.js)$/;
function isClientLinkRequest(req) {
  if (req.path.startsWith('/api/public/')) return true;
  // A partner prospect's registration form. The page holds nothing; what it
  // shows comes from /api/public/pps-form, on the token in its address.
  if (req.method === 'GET' && req.path === '/partner-form' && req.query.pf) return true;
  // The empanelment form is on its token, like the one above.
  if (req.method === 'GET' && req.path === '/empanelment' && req.query.t) return true;
  if (req.path === '/config.js') return true;
  /* The page's own scripts and styles are code, not data, and a client's
     form page needs them as much as the CRM does: left behind the sign-in
     they came back as the login page, multi-asset.js never ran, and the
     form died on "maLoadRows is not defined". index.html and every store
     stay behind the sign-in. */
  if (isPublicCodeFile(req)) return true;
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return false;
  const token = req.query.doc || req.query.support;
  return !!(token && publicScope(String(token)));
}
/* WHAT IS LIVE, readable without signing in: one line written by the
   server's auto-deployer (deploy/boss-finowise/autodeploy.sh) — "LIVE
   <commit>", or "ROLLED BACK to <commit> — <commit> failed". It names a
   commit and nothing else, so whoever pushed a deploy can see whether it
   took. Read before the sign-in gate on purpose. */
const DEPLOY_STATUS_FILE = process.env.CRM_DEPLOY_STATUS
  || path.join(path.dirname(path.dirname(path.resolve(DB_FILE))), 'deploy-status.txt');
app.get('/deploy-status.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'no-store');
  fs.readFile(DEPLOY_STATUS_FILE, 'utf8', (err, txt) => {
    if (err) return res.send('no auto-deploy has run on this server yet\n');
    res.send(String(txt).split('\n')[0].slice(0, 300) + '\n');
  });
});

/* SIGNED IN WITH A PASSWORD SOMEBODY ELSE ISSUED: choose your own first.
   Only the page that does that, signing out, and the code files are open
   until then; any other page goes there, and the data says why it refuses. */
const MUST_CHANGE_OPEN = new Set(['/set-password', '/logout', '/api/health', '/api/me/password', '/api/account/password', '/config.js', '/sw.js', '/deploy-status.txt']);
app.use((req, res, next) => {
  const u = signedInUser(req);
  if (!u || !u.must_change || MUST_CHANGE_OPEN.has(req.path) || isPublicCodeFile(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Choose your own password first.', mustChangePassword: true });
  res.redirect('/set-password?next=' + encodeURIComponent(req.originalUrl));
});
app.use((req, res, next) => {
  if (isSignedIn(req) || req.path === '/api/health') return next();
  // A reset link is for somebody who cannot sign in.
  if (req.path === '/reset-password') return next();
  // The service worker script carries no data; a browser fetches it without
  // being asked to sign in again, and it is what shows a push.
  if (req.path === '/sw.js') return next();
  // The app's own code — multi-asset.js, client-merge.js, the review report's
  // script and stylesheet, the PDF and zip readers — is code, not data. A
  // client opening the form link they were sent is not signed in, and when
  // these answered with the sign-in page instead, the page that needs them
  // stopped dead ("maLoadRows is not defined"). Scripts and stylesheets only,
  // and only files that are really in public/.
  if (isPublicCodeFile(req)) return next();
  if (isClientLinkRequest(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

// Minimal shared-secret gate. Real per-user authentication is a separate, larger
// project (see README.md) — this only stops the API being wide open to anyone
// who finds the URL.
// Compares two secrets in constant time, so the answer's timing says nothing
// about how much of a guess was right.
function sameSecret(given, want) {
  const a = crypto.createHash('sha256').update(String(given == null ? '' : given)).digest();
  const b = crypto.createHash('sha256').update(String(want == null ? '' : want)).digest();
  return crypto.timingSafeEqual(a, b) && String(given) === String(want);
}
function checkApiKey(req, res, next) {
  if (!API_KEY) return next(); // no key configured — open access, fine for local/dev use only, see README
  const provided = req.get('X-API-Key');
  if (!sameSecret(provided, API_KEY)) return res.status(401).json({ error: 'Invalid or missing X-API-Key header' });
  next();
}

/* THE WRITE LOG — who changed which records, from which platform. Kept by
   the server, one JSON line per save, so it holds whatever the page does or
   does not remember to record itself: created, modified and removed ids,
   and every refused attempt. Admins read it at /api/audit/writes. */
const AUDIT_FILE = process.env.CRM_AUDIT_FILE || path.join(path.dirname(DB_FILE), 'access-audit.log');
function auditDiff(beforeText, afterText, patch) {
  if (patch && patch.kind === 'rows') {
    return { changed: (patch.changes || []).map((c) => c && c.id).filter((x) => x !== undefined).slice(0, 200),
      added: (patch.adds || []).map((r) => r && r.id).filter((x) => x !== undefined).slice(0, 200),
      removed: (patch.removed || []).slice(0, 200) };
  }
  const a = parseOr(beforeText || '[]', []), b = parseOr(afterText || '[]', []);
  if (!Array.isArray(a) || !Array.isArray(b)) return { whole: true };
  const was = new Map(a.map((r) => [rowKey(r), r]));
  const now = new Map(b.map((r) => [rowKey(r), r]));
  const changed = [], added = [], removed = [];
  now.forEach((r, k) => { if (k === null) return; const w = was.get(k); if (!w) added.push(k); else if (!sameRow(w, r)) changed.push(k); });
  was.forEach((r, k) => { if (k !== null && !now.has(k)) removed.push(k); });
  return { changed: changed.slice(0, 200), added: added.slice(0, 200), removed: removed.slice(0, 200) };
}
function writeAudit(req, who, key, detail) {
  const d = detail || {};
  if (!d.refused && !d.whole && !(d.changed || []).length && !(d.added || []).length && !(d.removed || []).length) return;
  const line = JSON.stringify(Object.assign({
    at: new Date().toISOString(),
    by: (who && who.user && who.user.email) || (signedInUser(req) || {}).email || '',
    member: (who && who.member && who.member.id) || '',
    as: (who && who.label) || '',
    platform: platformOf(req),
    key,
  }, d));
  fs.appendFile(AUDIT_FILE, line + '\n', () => {});
}
app.get('/api/audit/writes', checkApiKey, (req, res) => {
  const u = signedInUser(req);
  if (!u || u.role !== 'admin') return res.status(403).json({ error: 'Only an admin can read the write log.' });
  fs.readFile(AUDIT_FILE, 'utf8', (err, text) => {
    const lines = err ? [] : String(text).trim().split('\n').filter(Boolean);
    const key = String(req.query.key || ''), id = String(req.query.id || ''), by = String(req.query.by || '').toLowerCase();
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < Math.min(Number(req.query.limit) || 200, 2000); i--) {
      let r; try { r = JSON.parse(lines[i]); } catch (e) { continue; }
      if (key && r.key !== key) continue;
      if (by && String(r.by || '').toLowerCase() !== by) continue;
      if (id && ![].concat(r.changed || [], r.added || [], r.removed || []).map(String).includes(id)) continue;
      rows.push(r);
    }
    res.set('Cache-Control', 'no-store').json({ rows });
  });
});
/* Who the signed-in person is, as the server will treat them. */
app.get('/api/me/access', checkApiKey, (req, res) => {
  const p = access.principal(signedInUser(req));
  res.set('Cache-Control', 'no-store').json(access.summary(p, platformOf(req)) || {});
});

// GET /api/storage/:key -> { key, value } | 404
app.get('/api/storage/:key', checkApiKey, (req, res) => {
  const raw = store[req.params.key];
  if (raw === undefined) return res.status(404).json({ error: 'not found' });
  // Only the records this person may see (access.js). A store that is not
  // theirs to read at all answers as if it were not there.
  const reader = signedInUser(req);
  let value = access.read(req.params.key, raw, access.principal(reader));
  if (value === null) return res.status(404).json({ error: 'not found' });
  // The course library: only the courses this person has been given (skill-center-server.js).
  if (req.params.key === 'sdcCourses') value = sdcServer.filterCourses(value, reader);
  res.json({ key: req.params.key, value });
});

/* AN ATTENDANCE ROW IS WRITTEN ONCE AND NOT EDITED.

   Everything else in BOSS is a whole-array PUT, which means the browser
   decides what the store holds. For attendance that is not good enough:
   a punch is a claim about where somebody was and when, and the one
   thing it must not be is adjustable afterwards by whoever has the page
   open. Nothing in the UI offers to edit one, but "the UI does not offer
   it" is not the same as "it cannot happen".

   So this is append-only, checked here rather than in the browser. A
   write may add a day, add a session to a day, and close an open session
   by setting its punch-out and that punch-out's location. It may not
   change a punch-in, change a punch-out that is already set, change or
   add a location to a punch already recorded, drop a session, or drop a
   day. Anything else comes back 409 naming what it tried to move.

   Since the punch clock allows Punch Out to be pressed again, a
   punch-out may also MOVE — but only later, and only with the one it
   replaces appended to that session's outHistory, so the earlier punch
   is still on the record. And a day has one punch-in: a second session
   cannot be added to a day that already has one.

   One exception, deliberate and narrow: an empty array is allowed
   through, because Reset System wipes every store and an administrator
   clearing the system is not the thing this is guarding against. What it
   guards against is a quiet edit to one timestamp among hundreds. */
const ATT_FIXED = ['in', 'inBy', 'inLoc', 'out', 'outBy', 'outLoc'];
const ATT_OUT = ['out', 'outBy', 'outLoc'];
// A later punch-out replacing an earlier one, with the earlier one kept.
function attendanceOutMoved(a, b) {
  if (!a.out || !b.out || b.out === a.out) return false;
  if (!(new Date(b.out).getTime() > new Date(a.out).getTime())) return false;
  const oldH = Array.isArray(a.outHistory) ? a.outHistory : [];
  const newH = Array.isArray(b.outHistory) ? b.outHistory : [];
  if (newH.length !== oldH.length + 1) return false;
  if (JSON.stringify(newH.slice(0, oldH.length)) !== JSON.stringify(oldH)) return false;
  const kept = newH[newH.length - 1] || {};
  return ATT_OUT.every((k) => JSON.stringify(kept[k] === undefined ? null : kept[k]) === JSON.stringify(a[k] === undefined ? null : a[k]));
}
function attendanceGuard(before, after) {
  let old;
  try { old = JSON.parse(before || '[]'); } catch (e) { return null; }
  let next;
  try { next = JSON.parse(after); } catch (e) { return 'that is not valid JSON'; }
  if (!Array.isArray(old) || !Array.isArray(next)) return null;
  if (!next.length) return null;                       // a full wipe: see above
  const byId = new Map(old.filter((r) => r && r.id).map((r) => [r.id, r]));
  const seen = new Set();
  for (const row of next) {
    if (!row || !row.id) continue;
    seen.add(row.id);
    const was = byId.get(row.id);
    if (!was) {                                        // a new day
      if (Array.isArray(row.sessions) && row.sessions.length > 1)
        return 'attendance ' + row.id + ' tried to start a day with more than one punch-in';
      continue;
    }
    if (row.userId !== was.userId || row.date !== was.date)
      return 'attendance ' + row.id + ' tried to move to another person or another date';
    const oldS = Array.isArray(was.sessions) ? was.sessions : [];
    const newS = Array.isArray(row.sessions) ? row.sessions : [];
    if (newS.length < oldS.length)
      return 'attendance ' + row.id + ' tried to drop a session';
    if (newS.length > oldS.length && oldS.length >= 1)
      return 'attendance ' + row.id + ' already has a punch-in for that day';
    for (let i = 0; i < oldS.length; i++) {
      const a = oldS[i] || {}, b = newS[i] || {};
      const moved = attendanceOutMoved(a, b);
      if (!moved && JSON.stringify(a.outHistory || []) !== JSON.stringify(b.outHistory || []))
        return 'attendance ' + row.id + ' tried to change an earlier punch-out';
      for (const k of ATT_FIXED) {
        const had = a[k] !== undefined && a[k] !== null;
        if (!had) continue;                            // not set yet: may be set now
        if (moved && ATT_OUT.includes(k)) continue;    // a later punch-out, the earlier one kept
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k]))
          return 'attendance ' + row.id + ' tried to change a recorded ' + k;
      }
    }
  }
  for (const r of old) if (r && r.id && !seen.has(r.id))
    return 'attendance ' + r.id + ' was dropped';
  return null;
}

/* A CLIENT RECORD IS CHECKED HERE TOO, NOT ONLY IN THE FORM.

   The Add New Client form checks every box as it is typed. This is the
   half that cannot be bypassed: whatever arrives as the clients store is
   read again, and a value that breaks one of the form's rules is refused
   before it reaches data.json.

   Only what CHANGED is judged — a field on a record that this write does
   not touch is left alone, so a client saved years ago with an
   eleven-digit mobile does not stop somebody else's edit of a different
   client. And the full Aadhaar number never belongs in this store at all:
   it lives in the vault below, and only its last four digits come here. */
const CLIENT_RULES = {
  cmsName:      { test: (v) => /[A-Za-z]/.test(v) && /^[A-Za-z][A-Za-z .'\-]*$/.test(v), message: 'Please enter a valid client name.' },
  mobile:       { kind: 'mobile', message: 'Please enter a valid 10-digit mobile number.' },
  secondMobile: { kind: 'mobile', message: 'Please enter a valid 10-digit mobile number.' },
  email:        { kind: 'email', message: 'Please enter a valid email address.' },
  pan:          { kind: 'pan', message: 'Please enter a valid PAN number.' },
  aadhaar:      { test: (v) => /^[0-9]{4}$/.test(v), message: 'Only the last four digits of an Aadhaar number are kept on a client record.' },
  mailingZip:   { test: (v) => /^[1-9][0-9]{5}$/.test(v), message: 'Please enter a valid 6-digit PIN code.' },
  ifsc:         { test: (v) => /^[A-Z]{4}0[A-Z0-9]{6}$/i.test(v), message: 'Please enter a valid IFSC code.' },
  accNo:        { test: (v) => /^[0-9]{9,18}$/.test(v), message: 'Please enter a valid bank account number.' },
  uccNo:        { test: (v) => /^[A-Za-z0-9]{3,20}$/.test(v), message: 'Please enter a valid UCC number.' },
};
function clientsGuard(before, after, strict) {
  let old;
  try { old = JSON.parse(before || '[]'); } catch (e) { old = []; }
  let next;
  try { next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(next)) return null;
  const byId = new Map((Array.isArray(old) ? old : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const problems = [];
  const uccSeen = new Map();
  next.forEach((r) => {
    if (r && !r.deletedAt && r.uccNo) {
      const k = String(r.uccNo).trim().toUpperCase();
      uccSeen.set(k, (uccSeen.get(k) || 0) + 1);
    }
  });
  for (const row of next) {
    if (!row || typeof row !== 'object' || row.deletedAt) continue;
    const was = byId.get(row.id) || {};
    /* Other screens (imports, quick edits, workflows) write clients too and
       were never held to the form's rules; holding them now would refuse a
       whole import over one odd name. Those writes get the one rule that
       is about privacy, not tidiness: a full Aadhaar number is cut to its
       last four digits instead of being stored. */
    if (!strict) {
      if (row.aadhaar != null && /^[0-9]{12}$/.test(String(row.aadhaar).replace(/\s/g, '')))
        row.aadhaar = String(row.aadhaar).replace(/\s/g, '').slice(-4);
      continue;
    }
    for (const [k, rule] of Object.entries(CLIENT_RULES)) {
      const v = row[k];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      if (String(v) === String(was[k] === undefined || was[k] === null ? '' : was[k])) continue;
      const s = String(v).trim();
      const ok = rule.kind ? checkValue(rule.kind, s).ok : rule.test(s);
      if (!ok) problems.push((row.cmsName || row.id) + ' — ' + rule.message);
      if (k === 'uccNo' && ok && uccSeen.get(s.toUpperCase()) > 1)
        problems.push((row.cmsName || row.id) + ' — UCC ' + s + ' is already on another client.');
    }
  }
  return problems.length ? { problems } : { value: strict ? after : JSON.stringify(next) };
}

/* WHEN A PUNCH IS ALLOWED, decided here and not only by a greyed-out button.
   A new punch in has to land inside the punch clock's hours on the firm's
   clock, on a day there is attendance, by somebody not on an approved
   full-day leave, and be stamped with the time it actually happened. A punch
   out has to land before the clock closes. Rows for other days (a restore,
   an import) are not judged: only a punch made today is a punch made now. */
function attendanceRulesGuard(before, after) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(old) || !Array.isArray(next)) return null;
  const now = bizNow();
  const cfg = hrConfigNow();
  const from = minsOf(cfg.day.from), until = minsOf(cfg.day.until);
  const byId = new Map(old.filter((r) => r && r.id).map((r) => [r.id, r]));
  for (const row of next) {
    if (!row || !row.id || row.date !== now.date) continue;
    const was = byId.get(row.id) || {};
    const oldS = Array.isArray(was.sessions) ? was.sessions : [];
    const newS = Array.isArray(row.sessions) ? row.sessions : [];
    if (newS.length > oldS.length) {
      const closed = cfg.compOffEnabled ? '' : hrClosedWhy(row.date, cfg);
      if (closed) return 'You cannot punch in today. ' + closed;
      const leave = hrApprovedLeave(row.userId, row.date);
      if (leave && !hrLeaveIsHalf(leave, cfg))
        return 'You cannot punch in today: you are on approved leave' + (leave.type ? ' (' + leave.type + ')' : '') + '.';
      if (now.mins < from) return 'Punch In opens at ' + cfg.day.from + '.';
      if (now.mins >= until) return 'The punch clock closed at ' + cfg.day.until + ' today.';
      const at = new Date((newS[newS.length - 1] || {}).in).getTime();
      // (The test suites lay down days punched in hours ago to drive; they run with CRM_ATTENDANCE_ANY_DAY=1.)
      if (process.env.CRM_ATTENDANCE_ANY_DAY !== '1' && (!isFinite(at) || Math.abs(Date.now() - at) > 10 * 60000))
        return 'A punch in has to carry the time it was made.';
    }
    for (let i = 0; i < Math.min(oldS.length, newS.length); i++) {
      const a = oldS[i] || {}, b = newS[i] || {};
      if (b.out && b.out !== a.out) {
        if (!cfg.compOffEnabled && hrClosedWhy(row.date, cfg)) return 'You cannot punch out today. ' + hrClosedWhy(row.date, cfg);
        if (now.mins >= until) return 'Punch Out closed at ' + cfg.day.until + '. Ask for a regularization if your last punch out is wrong.';
      }
    }
  }
  return null;
}

/* A service task's Due Date cannot be earlier than its Assigned Date. Only a
   task this write adds, or whose dates it changes, is judged: an old row
   with odd dates does not block somebody else's edit. */
// Depth in the reporting tree (parentUserId), the same measure the page uses
// for "your level and below". A ring counts as top level.
function teamDepths(team) {
  const by = {};
  team.forEach((t) => { if (t && t.id) by[t.id] = t; });
  const depth = {};
  Object.keys(by).forEach((start) => {
    if (depth[start] !== undefined) return;
    const path = []; const walked = new Set();
    let cur = start;
    while (cur && by[cur] && !walked.has(cur) && depth[cur] === undefined) { walked.add(cur); path.push(cur); cur = by[cur].parentUserId; }
    if (cur && walked.has(cur)) { path.forEach((id) => { depth[id] = 0; }); return; }
    let d = (cur && depth[cur] !== undefined) ? depth[cur] : -1;
    for (let i = path.length - 1; i >= 0; i--) depth[path[i]] = ++d;
  });
  return depth;
}
// May this member give work to that one? Administrators and people who
// administer users may give it to anybody; everyone else to their own level
// of the reporting tree or below, never upwards.
function mayAssignTask(member, toId, team) {
  if (!member || !toId || toId === member.id) return true;
  const f = member.adminFlags || {};
  if (member.role === 'Admin' || f.manageUsers || f.managePermissions) return true;
  const d = teamDepths(team);
  return (d[toId] === undefined ? 0 : d[toId]) >= (d[member.id] === undefined ? 0 : d[member.id]);
}
function tasksGuard(before, after, member, fromForm) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(next)) return null;
  const byId = new Map((Array.isArray(old) ? old : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const team = storeList('team');
  const today = bizNow().date;
  for (const t of next) {
    if (!t || t.deletedAt) continue;
    const was = byId.get(t.id);
    if (member && t.assignTo && (!was || was.assignTo !== t.assignTo) && !mayAssignTask(member, t.assignTo, team)) {
      const to = team.find((x) => x && x.id === t.assignTo);
      return 'You can assign or reassign a task only to people at your own level or below you in the reporting line. '
        + ((to && to.name) || t.assignTo) + ' is above you' + (t.id ? ' (' + t.id + ')' : '') + '.';
    }
    if (fromForm && t.assignedDate && (!was || was.assignedDate !== t.assignedDate)
        && String(t.assignedDate).slice(0, 10) < today)
      return 'Assigned Date cannot be in the past. Please select today or a later date.';
  }
  for (const t of next) {
    if (!t || t.deletedAt || !t.assignedDate || !t.dueDate) continue;
    const was = byId.get(t.id);
    if (was && was.assignedDate === t.assignedDate && was.dueDate === t.dueDate) continue;
    if (String(t.dueDate).slice(0, 10) < String(t.assignedDate).slice(0, 10))
      return 'Due Date cannot be earlier than Assigned Date. Please select a valid Due Date.'
        + (t.id ? ' (' + t.id + (t.taskType ? ', ' + t.taskType : '') + ')' : '');
  }
  return null;
}

// Leave: one active request per person per date. A new or changed request
// that is Pending or Approved must not overlap another Pending or Approved
// request of the same person. Rows already on the server count even when the
// page sending this write never saw them, so two requests sent at the same
// moment cannot both land. Untouched older rows are left as they are.
function leaveGuard(before, after) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(next)) return null;
  const ACTIVE = ['Pending', 'Approved'];
  const day = (v) => String(v || '').slice(0, 10);
  const byId = new Map((Array.isArray(old) ? old : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const all = new Map(byId);
  next.forEach((r) => { if (r && r.id) all.set(r.id, r); });
  /* Cancelling: the request must say which dates went, those dates must be
     its own, and whatever is kept is written as requests that sit inside
     the original and on none of the cancelled dates. */
  const CANCELLED = ['Cancelled', 'Partially Cancelled'];
  const datesOf = (r) => {
    const out = [], d = new Date(day(r.from) + 'T00:00:00Z'), end = day(r.to || r.from);
    for (let i = 0; i < 400 && !isNaN(d) && d.toISOString().slice(0, 10) <= end; i++) {
      out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  };
  for (const r of next) {
    if (!r || !r.id) continue;
    const was = byId.get(r.id);
    if (was && ACTIVE.indexOf(was.status) >= 0 && CANCELLED.indexOf(r.status) >= 0) {
      const c = r.cancellation || {};
      const own = datesOf(was);
      if (!Array.isArray(c.dates) || !c.dates.length) return 'A cancelled leave must say which dates were cancelled.';
      if (c.dates.some((d) => own.indexOf(day(d)) < 0)) return 'Only dates inside the leave itself can be cancelled.';
      const kept = own.filter((d) => c.dates.map(day).indexOf(d) < 0);
      if ((r.status === 'Cancelled') !== (kept.length === 0))
        return r.status === 'Cancelled' ? 'Some dates of this leave are still kept, so it is Partially Cancelled, not Cancelled.'
          : 'Every date of this leave was cancelled, so it is Cancelled, not Partially Cancelled.';
    }
    if (!was && r.remainderOf && ACTIVE.indexOf(r.status) >= 0) {
      const o = all.get(r.remainderOf);
      if (!o || CANCELLED.indexOf(o.status) < 0) return 'Kept dates can only follow a cancellation of the leave they belong to.';
      const own = datesOf(o), gone = ((o.cancellation || {}).dates || []).map(day);
      if (datesOf(r).some((d) => own.indexOf(d) < 0 || gone.indexOf(d) >= 0))
        return 'The kept dates must lie inside the original leave and not on a cancelled date.';
    }
  }
  for (const r of next) {
    if (!r || !r.id || ACTIVE.indexOf(r.status) < 0 || !r.from) continue;
    const was = byId.get(r.id);
    if (was && was.status === r.status && day(was.from) === day(r.from) && day(was.to) === day(r.to)) continue;
    const a1 = day(r.from), a2 = day(r.to || r.from);
    for (const o of all.values()) {
      if (!o || o.id === r.id || o.userId !== r.userId || ACTIVE.indexOf(o.status) < 0 || !o.from) continue;
      const b1 = day(o.from), b2 = day(o.to || o.from);
      if (a1 <= b2 && b1 <= a2)
        return 'Leave is already ' + (o.status === 'Approved' ? 'approved' : 'requested') + ' for ' + b1
          + (b2 !== b1 ? ' to ' + b2 : '') + ', which overlaps ' + a1 + (a2 !== a1 ? ' to ' + a2 : '')
          + '. Choose dates that do not overlap, or cancel the earlier request first.';
    }
  }
  return null;
}

// Comp-off: one record per person per extra working day, so the same day
// can never be credited twice, and a decided record keeps the credit it was
// decided at. Untouched older rows are left as they are.
function compOffGuard(before, after) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(next)) return null;
  const byId = new Map((Array.isArray(old) ? old : []).filter((r) => r && r.id).map((r) => [r.id, r]));
  const seen = new Map();
  for (const r of next) {
    if (!r || !r.id || !r.userId || !r.date) continue;
    const k = r.userId + '|' + String(r.date).slice(0, 10);
    if (seen.has(k)) return 'Comp-off for ' + String(r.date).slice(0, 10) + ' is already recorded. One day can be credited only once.';
    seen.set(k, r.id);
    const was = byId.get(r.id);
    if (was && ['Approved', 'Rejected'].indexOf(was.status) >= 0
        && (was.status !== r.status || Number(was.credit) !== Number(r.credit)))
      return 'This comp-off was already ' + was.status.toLowerCase() + ' and cannot be changed.';
  }
  return null;
}

// PUT /api/storage/:key  body: { value: "..." } -> { key, value }
/* A SAVE NEVER DROPS A RECORD IT DID NOT MEAN TO.

   The browser saves a store by sending the whole list it holds. A tab a
   moment behind — a colleague created a lead a minute ago and this tab has
   not read it yet — sent a list without that lead, and replacing the store
   with it deleted the lead. A read that failed was worse: the tab took the
   store for empty, and its next save sent back almost nothing. That is how
   records "deleted themselves".

   So a list of records is merged, not replaced: a record the server holds
   that is missing from what was sent is kept, unless the browser says it
   removed it (body.removed — the ids it had read and has taken out: a
   purge, a merge, a lead converted to a client). A reset or a restore,
   which really do mean "this and nothing else", says so with
   X-CRM-Replace. Edits to the same record are still the newest save's. */
/* =====================================================================
   SAVING WITHOUT OVERWRITING ANYBODY (changes 14-11-2026)

   A browser used to send a whole store — every lead, every client — on
   every save, and the server took its copy of every record. A tab that had
   missed an update (asleep in the background, its live connection dropped)
   then put its old copies back over newer ones the moment it saved
   anything at all: a lead qualified a minute earlier went back to "Ready
   for Qualification", an FQ result that had come in vanished.

   Two rules now, on the side that cannot be bypassed:

   1. A patch. A browser sends only what it changed — the records it added,
      and for each record it edited only the fields it edited — and the
      server applies those fields to the record as it holds it now. Fields
      nobody touched stay as they are, whoever changed them last. Two people
      editing different fields of one record both keep their change.

   2. A stamp. Every record carries _mt, set here whenever the record
      changes. A whole-store write (a tab still running the old page, a
      reset) whose copy of a record is older than the stored one does not
      replace it: the stored record is kept, and the tab is sent it.
   ===================================================================== */
let mtLast = 0;
function nextMt() { const n = Date.now(); mtLast = n > mtLast ? n : mtLast + 1; return mtLast; }
function rowKey(r) { return r && typeof r === 'object' && r.id !== undefined && r.id !== null ? String(r.id) : null; }
function sameRow(a, b) {
  if (!a || !b) return false;
  const strip = (r) => { const o = Object.assign({}, r); delete o._mt; return JSON.stringify(o); };
  return strip(a) === strip(b);
}
/* Stamp the records that changed between two versions of a list. */
function stampRows(beforeList, afterList) {
  if (!Array.isArray(afterList)) return afterList;
  const was = new Map();
  (Array.isArray(beforeList) ? beforeList : []).forEach((r) => { const k = rowKey(r); if (k !== null) was.set(k, r); });
  const mt = nextMt();
  return afterList.map((r) => {
    const k = rowKey(r);
    if (k === null) return r;
    const old = was.get(k);
    if (old && sameRow(old, r)) return old._mt !== undefined && r._mt !== old._mt ? Object.assign({}, r, { _mt: old._mt }) : r;
    return Object.assign({}, r, { _mt: mt });
  });
}
function parseOr(text, fallback) { try { const v = JSON.parse(text); return v === undefined ? fallback : v; } catch (e) { return fallback; } }
/* Apply a browser's patch to the store as the server holds it now. */
function applyStorePatch(storedText, patch) {
  let cur = storedText === undefined ? null : parseOr(storedText, undefined);
  if (cur === undefined) return { error: 'the stored value could not be read' };
  if (patch.kind === 'rows') {
    if (cur === null) cur = [];
    if (!Array.isArray(cur)) return { error: 'this store is not a list' };
    cur = cur.slice();
    const at = new Map();
    cur.forEach((r, i) => { const k = rowKey(r); if (k !== null) at.set(k, i); });
    const touched = new Set(), gone = [], conflicts = [];
    const j = (v) => (v === undefined ? '\u0000none' : JSON.stringify(v));
    (Array.isArray(patch.changes) ? patch.changes : []).forEach((c) => {
      if (!c || c.id === undefined || c.id === null) return;
      const k = String(c.id), i = at.get(k);
      if (i === undefined) { gone.push(k); return; }      // removed meanwhile; an edit cannot bring it back
      /* A field somebody else changed after this browser read it, and that
         this save changes too: the save goes through, and the browser is
         told what the other person had, to review. */
      if (c.base && typeof c.base === 'object') {
        const has = new Set(Array.isArray(c.baseHas) ? c.baseHas : Object.keys(c.base));
        const fields = Object.keys(c.set && typeof c.set === 'object' ? c.set : {}).concat(Array.isArray(c.unset) ? c.unset : []);
        fields.forEach((f) => {
          if (f === 'id' || f === '_mt') return;
          const was = has.has(f) ? c.base[f] : undefined, now = cur[i][f];
          const mine = c.set && Object.prototype.hasOwnProperty.call(c.set, f) ? c.set[f] : undefined;
          if (j(now) !== j(was) && j(now) !== j(mine)) conflicts.push({ id: c.id, field: f, theirs: now, mine, base: was });
        });
      }
      const row = Object.assign({}, cur[i]);
      Object.entries(c.set && typeof c.set === 'object' ? c.set : {}).forEach(([f, v]) => { if (f !== 'id' && f !== '_mt') row[f] = v; });
      (Array.isArray(c.unset) ? c.unset : []).forEach((f) => { if (f !== 'id' && f !== '_mt') delete row[f]; });
      cur[i] = row; touched.add(k);
    });
    (Array.isArray(patch.adds) ? patch.adds : []).forEach((r) => {
      const k = rowKey(r); if (k === null) return;
      const add = Object.assign({}, r); delete add._mt;
      const i = at.get(k);
      if (i !== undefined) cur[i] = Object.assign({}, cur[i], add);
      else { at.set(k, cur.length); cur.push(add); }
      touched.add(k);
    });
    const rm = new Set((Array.isArray(patch.removed) ? patch.removed : []).map(String));
    if (rm.size) cur = cur.filter((r) => { const k = rowKey(r); return k === null || !rm.has(k); });
    return { value: cur, touched, gone, conflicts };
  }
  if (patch.kind === 'obj') {
    if (cur === null) cur = {};
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return { error: 'this store is not a record' };
    cur = Object.assign({}, cur);
    Object.entries(patch.set && typeof patch.set === 'object' ? patch.set : {}).forEach(([f, v]) => { cur[f] = v; });
    (Array.isArray(patch.unset) ? patch.unset : []).forEach((f) => { delete cur[f]; });
    return { value: cur };
  }
  return { error: 'unknown patch' };
}
/* A whole-store write: a record whose copy is older than the stored one is
   not taken; the stored record stays. */
function keepNewerRows(storedText, incomingText) {
  const old = parseOr(storedText || '[]', null), next = parseOr(incomingText, null);
  if (!Array.isArray(old) || !Array.isArray(next)) return null;
  const was = new Map();
  old.forEach((r) => { const k = rowKey(r); if (k !== null) was.set(k, r); });
  const kept = [];
  const out = next.map((r) => {
    const k = rowKey(r); if (k === null) return r;
    const s = was.get(k);
    /* Judged only when the copy carries a stamp: a copy read before stamps
       existed (or built by hand) cannot be told old from new, and is taken
       as a whole write always was. */
    if (s && r._mt !== undefined && r._mt !== null && Number(s._mt || 0) > Number(r._mt) && !sameRow(s, r)) { kept.push(k); return s; }
    return r;
  });
  return kept.length ? { value: JSON.stringify(out), kept } : null;
}

function mergeRecordList(before, after, removed) {
  let old, next;
  try { old = JSON.parse(before || '[]'); next = JSON.parse(after); } catch (e) { return null; }
  if (!Array.isArray(old) || !Array.isArray(next)) return null;
  const sent = new Set(next.filter((r) => r && typeof r === 'object' && r.id !== undefined && r.id !== null).map((r) => String(r.id)));
  const gone = new Set((Array.isArray(removed) ? removed : []).map(String));
  const keep = old.filter((r) => r && typeof r === 'object' && r.id !== undefined && r.id !== null
    && !sent.has(String(r.id)) && !gone.has(String(r.id)));
  if (!keep.length) return null;
  return { value: JSON.stringify(next.concat(keep)), kept: keep.length };
}
app.put('/api/storage/:key', checkApiKey, (req, res) => {
  let { value } = req.body || {};
  let patch = (req.body || {}).patch;
  const before = store[req.params.key];
  /* Somebody restricted (a partner, their staff, an employee with Own / Team
     / Branch scope) may change only records in their reach; a whole-list
     save from them becomes a patch against what they were shown. */
  const who = access.principal(signedInUser(req));
  // The course library is written by admins and course managers only.
  if (req.params.key === 'sdcCourses' && !sdcServer.mayManage(signedInUser(req))) {
    writeAudit(req, who, req.params.key, { refused: 'not a course manager' });
    return res.status(403).json({ error: 'Only an admin or a course manager can change the course library.', refused: true });
  }
  if (access.restricted(who)) {
    const v = access.authorize(req.params.key, before, req.body || {}, req.headers, who);
    if (v.error) {
      writeAudit(req, who, req.params.key, { refused: v.error });
      return res.status(403).json({ error: v.error, refused: true });
    }
    if (v.patch) { patch = v.patch; value = undefined; }
  }
  let merged = 0, touched = null, gone = [], keptStale = [], conflicts = [];
  if (patch && typeof patch === 'object') {
    /* Only what the browser changed, applied to the store as it is now. */
    const r = applyStorePatch(before, patch);
    if (r.error) return res.status(409).json({ error: r.error });
    value = JSON.stringify(r.value);
    touched = r.touched || null; gone = r.gone || []; conflicts = r.conflicts || [];
  } else {
    if (typeof value !== 'string') return res.status(400).json({ error: 'body.value must be a string (the CRM already JSON.stringifies before sending)' });
    if (req.get('X-CRM-Replace') !== '1' && before !== undefined) {
      const k = keepNewerRows(before, value);
      if (k) { value = k.value; keptStale = k.kept; }
      const m = mergeRecordList(before, value, (req.body || {}).removed);
      if (m) { value = m.value; merged = m.kept; }
    }
  }
  if (req.params.key === 'hrAttendance') {
    const wrong = attendanceGuard(store.hrAttendance, value);
    if (wrong) return res.status(409).json({ error: 'attendance is append-only: ' + wrong });
    const refused = attendanceRulesGuard(store.hrAttendance, value);
    if (refused) return res.status(409).json({ error: refused });
  }
  /* Any list holding five or more live records is not emptied by an
     ordinary write: an empty array is what a page that failed to load the
     store would send back. Reset System, Restore Backup and an import
     being reversed say so with X-CRM-Bulk. */
  if (req.get('X-CRM-Bulk') !== '1' && value === '[]') {
    let had = [];
    try { had = JSON.parse(store[req.params.key] || '[]'); } catch (e) { had = []; }
    const live = Array.isArray(had) ? had.filter((r) => r && !r.deletedAt).length : 0;
    if (live >= 5) {
      console.error('Refused emptying ' + req.params.key + ' (' + live + ' live records)');
      return res.status(409).set('X-CRM-Guard', 'emptied').json({ error: 'Not saved: this would empty ' + req.params.key
        + ', which holds ' + live + ' records. The page probably did not load it properly — reload it and try again.' });
    }
  }
  if (req.params.key === 'team' && req.get('X-CRM-Bulk') !== '1') {
    const wrong = teamGuard(store.team, value);
    if (wrong) {
      console.error('Refused a team write:', wrong);
      return res.status(409).json({ error: wrong });
    }
  }
  if (req.params.key === 'hrLeave') {
    const wrong = leaveGuard(store.hrLeave, value);
    if (wrong) return res.status(422).json({ error: wrong });
  }
  if (req.params.key === 'hrCompOff') {
    const wrong = compOffGuard(store.hrCompOff, value);
    if (wrong) return res.status(422).json({ error: wrong });
  }
  if (req.params.key === 'tasks') {
    const wrong = tasksGuard(store.tasks, value, memberOfUser(signedInUser(req)), req.get('X-CRM-Form') === 'dst');
    if (wrong) return res.status(422).json({ error: wrong });
  }
  if (req.params.key === 'clients') {
    const checked = clientsGuard(store.clients, value, req.get('X-CRM-Form') === 'client');
    if (checked && checked.problems) {
      const wrong = checked.problems;
      return res.status(422).json({ error: 'Not saved: ' + wrong.slice(0, 5).join(' '), problems: wrong });
    }
    if (checked) value = checked.value;
  }
  /* Every record that changed is stamped. */
  const finalList = parseOr(value, null);
  if (Array.isArray(finalList)) {
    const stamped = stampRows(parseOr(before || '[]', []), finalList);
    value = JSON.stringify(stamped);
    store[req.params.key] = value;
    writeToDisk();
    /* What the tab needs back: the records it touched as they now stand,
       and any it does not hold the server's version of. */
    let sent = null;
    if (!patch) { const inc = parseOr((req.body || {}).value, null); if (Array.isArray(inc)) { sent = new Map(); inc.forEach((r) => { const k = rowKey(r); if (k !== null) sent.set(k, r); }); } }
    const rows = stamped.filter((r) => {
      const k = rowKey(r); if (k === null) return false;
      if (touched) return touched.has(k);
      if (!sent) return false;
      const mine = sent.get(k);
      return !mine || mine._mt !== r._mt || !sameRow(mine, r);
    });
    publishChange([req.params.key], (merged || keptStale.length) ? '' : (req.get('X-Client-Id') || ''));
    writeAudit(req, who, req.params.key, auditDiff(before, value, patch));
    return res.json({ key: req.params.key, ok: true, rows, gone, kept: keptStale, merged, conflicts });
  }
  store[req.params.key] = value;
  writeToDisk();
  publishChange([req.params.key], merged ? '' : (req.get('X-Client-Id') || ''));
  writeAudit(req, who, req.params.key, { whole: true });
  res.json({ key: req.params.key, ok: true, value: patch ? value : undefined, merged });
});

// DELETE /api/storage/:key -> { key, deleted } | 404
// The CRM uses this to drop stores belonging to features that were removed (the Incentive
// and Appraisal modules, the old partner/level hierarchy), so their rows don't linger in
// data.json or reappear in a full-system export.
const CORE_STORE_KEYS = ['team', 'clients', 'leads', 'reviews', 'tasks', 'transactions', 'queries',
  'queryReplies', 'docLinks', 'docSubmissions', 'recommendations', 'businessEntries', 'communications',
  'hrAttendance', 'hrLeave', 'hrCompOff', 'auditLog', 'approvals', 'config', 'settings', 'apiConnectors',
  'assetUploads', 'platformHoldings', 'platformSips', 'importBatches', 'partnerWebinars', 'pjOnboarding'];
app.delete('/api/storage/:key', checkApiKey, (req, res) => {
  if (store[req.params.key] === undefined) return res.status(404).json({ error: 'not found' });
  /* Deleting a key is emptying it in one go, past every guard a PUT has.
     The firm's core lists and settings are only removed by an admin (Reset
     System, a migration an admin runs). The per-upload stores and files
     that ordinary work deletes are not in this list. */
  {
    const u = signedInUser(req);
    const admin = !!(u && u.role === 'admin');
    if (req.params.key === 'sdcCourses' && !sdcServer.mayManage(u))
      return res.status(403).json({ error: 'Only an admin or a course manager can remove the course library.' });
    if (!access.deletable(req.params.key, access.principal(u)))
      return res.status(403).json({ error: 'Not deleted: ' + req.params.key + ' is not yours to remove.' });
    if (CORE_STORE_KEYS.includes(req.params.key) && !admin) {
      console.error('Refused deleting ' + req.params.key + ' for a non-admin');
      return res.status(403).json({ error: 'Not deleted: only an admin can remove ' + req.params.key + '.' });
    }
  }
  delete store[req.params.key];
  writeToDisk();
  publishChange([req.params.key], req.get('X-Client-Id') || '');
  res.json({ key: req.params.key, deleted: true });
});

/* ---------------------------------------------------------------------
   CONNECTIONS API
   The browser sends configuration and, when the user types one, a secret.
   Secrets go into connections.json and are never sent back: the only thing
   the UI learns is whether one is stored, which is what lets the password
   box honestly say "leave blank to keep existing".

   The catalog of connectors — their labels, provider presets and help text —
   lives in public/index.html (search for CONNECTOR_CATALOG). This table is
   the half the server needs: which connectors exist, and how each one is
   actually tested. Field keys must agree between the two.
   --------------------------------------------------------------------- */
const CONNECTOR_KIND = {
  email:       'smtp',
  whatsapp:    'https',
  sms:         'https',
  gcal:        'https',
  outlook:     'graph',
  txnplatform: 'https',
  exchange:    'https',
  // AI Insights. Two of these are APIs the server can call and two are
  // editors that can only call us, so they are not the same kind of thing
  // and are not implemented as though they were.
  claude:      'https',
  gemini:      'https',
  vscode:      'inbound',
  cursor:      'inbound',
  /* A model the firm runs itself, or an enterprise gateway it controls, behind
     an OpenAI-compatible endpoint — Ollama, vLLM, LM Studio, a private
     deployment. This is the only shape in which "our data does not leave our
     control" can be true rather than promised, so it is the one the assistant
     prefers and the only kind that is privacy-verified by its nature. */
  bossai:      'selfhosted',
};
/* Which connectors the AI Assistant may speak through at all. The others are
   mail, calendars and transaction platforms: nothing about them is a model. */
const AI_CONNECTORS = ['bossai', 'claude', 'gemini'];
/* Where a connector's traffic goes. 'private' is an endpoint the firm runs or
   contracts for; 'public' is somebody else's multi-tenant API. The distinction
   is not cosmetic: it decides whether BOSS will put business data through it.
   An inbound connector sends nothing anywhere, so it is neither. */
const CONNECTOR_REACH = { bossai: 'private', claude: 'public', gemini: 'public' };
/* An administrator attests, per connector, that its privacy terms have been
   read and meet the firm's requirements — zero retention, no training on our
   data, no sharing. Until they do, a public endpoint is refused business data,
   whatever its key says. A private endpoint the firm runs is verified by what
   it is, because the data never leaves their own infrastructure.

   This is deliberately a gate and not a warning. The requirement BOSS was
   given says: if the privacy requirements cannot be verified, do not transmit
   confidential data to that connector. A banner nobody reads is not that. */
function aiPrivacyState(id) {
  const c = connections[id] || {};
  const config = c.config || {};
  const reach = CONNECTOR_REACH[id] || null;
  if (!reach) return { ok: false, reach: null, why: 'This connector is not a model BOSS can talk to.' };
  if (reach === 'private') {
    return { ok: true, reach, verified: true, by: 'deployment',
      why: 'A private endpoint this firm runs or contracts for. Nothing is sent to a shared service.' };
  }
  if (config.privacyVerified === true) {
    return { ok: true, reach, verified: true, by: config.privacyVerifiedBy || 'an administrator',
      at: config.privacyVerifiedAt || null, note: config.privacyNote || '',
      why: 'An administrator has recorded that this provider\'s terms meet the firm\'s requirements.' };
  }
  return { ok: false, reach, verified: false,
    why: 'This is a public API and nobody has recorded that its privacy terms were checked. '
       + 'BOSS will not send business data through it until an administrator verifies it in Setup \u2192 Connections.' };
}
/* The four things a connector's status can honestly be. */
function connectorStatusOf(id) {
  const c = connections[id] || {};
  const stored = c.status || 'Not Connected';
  if (AI_CONNECTORS.indexOf(id) >= 0 && stored === 'Connected') {
    const p = aiPrivacyState(id);
    if (!p.ok) return 'Privacy Requirements Not Verified';
  }
  if (/^Configured/.test(stored)) return 'Configuration Error';
  return stored;
}
/* An editor is not an API with an endpoint to probe. VS Code and Cursor
   reach BOSS, not the other way round: the connector issues a key, the
   extension sends it to /api/ai/hello, and only then — once a call has
   actually arrived and been accepted — does the connector read Connected.
   Nothing here ever claims a connection that has not happened. */
const INBOUND_CONNECTORS = ['vscode', 'cursor'];

// Presets write URLs like .../Accounts/{{accountSid}}.json; fill them from the
// connector's own configuration so the user edits an ID field, not a URL.
function fillTemplate(text, config) {
  // An empty field is not a value: leave the placeholder in place so the test
  // reports which field is missing instead of calling a half-built URL.
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => (config && config[k] !== undefined && config[k] !== null && String(config[k]).length ? String(config[k]) : m));
}

// Turns the saved auth style into the header (or query string) the provider wants.
function buildHttpsProbe(config, secrets) {
  let url = fillTemplate(config.testUrl, config);
  const headers = {};
  const style = config.authStyle || 'Bearer token';
  if (style === 'Bearer token') {
    if (!secrets.token) return { error: 'No access token is stored yet. Enter one and save first.' };
    headers.Authorization = 'Bearer ' + secrets.token;
  } else if (style === 'API key header') {
    if (!secrets.apiKey) return { error: 'No API key is stored yet. Enter one and save first.' };
    headers[config.headerName || 'X-API-Key'] = secrets.apiKey;
  } else if (style === 'Basic auth') {
    if (!secrets.password) return { error: 'No password or auth token is stored yet. Enter one and save first.' };
    headers.Authorization = 'Basic ' + Buffer.from((config.username || '') + ':' + secrets.password).toString('base64');
  } else if (style === 'Query parameter') {
    if (!secrets.apiKey) return { error: 'No API key is stored yet. Enter one and save first.' };
    url += (url.indexOf('?') === -1 ? '?' : '&') + encodeURIComponent(config.paramName || 'key') + '=' + encodeURIComponent(secrets.apiKey);
  } else {
    return { error: 'Unknown authentication style "' + style + '".' };
  }
  // Some providers want a second, non-secret header alongside the credential
  // — Anthropic's API version, for one. The connector's preset carries it.
  String(config.staticHeaders || '').split(/[\n;]+/).forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  });
  if (!url) return { error: 'No test endpoint is set for this connector.' };
  if (/\{\{\w+\}\}/.test(url)) return { error: 'The test endpoint still contains a placeholder (' + (url.match(/\{\{\w+\}\}/) || [])[0] + '). Fill in that field and save.' };
  return { url, method: config.testMethod || 'GET', headers };
}

// GET /api/connections -> [{ id, config, hasSecret, enabled, status, ... }]
app.get('/api/connections', checkApiKey, (req, res) => {
  const ids = Object.keys(CONNECTOR_KIND);
  // An API connector's credential lives in the same file under its own
  // prefix; it is not one of these and is never listed here.
  Object.keys(connections).forEach(id => {
    if (id.indexOf('apiconn:') === 0) return;
    if (ids.indexOf(id) === -1) ids.push(id);
  });
  res.json({ connections: ids.map(publicConnection) });
});

// PUT /api/connections/:id  body: { config, enabled, secrets }
// A secret arriving as an empty string means "keep what is stored"; sending
// null for one clears it.
app.put('/api/connections/:id', checkApiKey, requireApiAdmin, (req, res) => {
  const id = req.params.id;
  if (!CONNECTOR_KIND[id]) return res.status(404).json({ error: 'unknown connector: ' + id });
  const body = req.body || {};
  const existing = connections[id] || { config: {}, secrets: {} };
  if (body.config && typeof body.config === 'object') existing.config = Object.assign({}, existing.config, body.config);
  if (typeof body.enabled === 'boolean') existing.enabled = body.enabled;
  existing.secrets = existing.secrets || {};
  if (body.secrets && typeof body.secrets === 'object') {
    Object.keys(body.secrets).forEach(k => {
      const v = body.secrets[k];
      if (v === null) { delete existing.secrets[k]; return; }   // explicitly cleared
      if (typeof v === 'string' && v.length) existing.secrets[k] = v;
      // '' — the user left the box blank, so the stored value stands
    });
  }
  // Changing the configuration invalidates an earlier successful test.
  if (body.config || (body.secrets && Object.keys(body.secrets).length)) {
    if (existing.status === 'Connected') existing.status = 'Configured — not tested since the last change';
    existing.lastTestOk = false;
  }
  existing.updatedAt = new Date().toISOString();
  connections[id] = existing;
  writeConnections();
  res.json({ connection: publicConnection(id) });
});

/* ---------------------------------------------------------------------
   MAIL — sending for real, through the stored Email connector.

   The CRM has always recorded what it "sent"; with SMTP credentials on the
   server it can actually send. If the connector is not set up, this says so
   and sends nothing: the caller records an honest "not sent" rather than a
   cheerful lie.
   --------------------------------------------------------------------- */
function encodeHeader(text) {
  const str = String(text || '');
  // Plain ASCII goes as-is; anything else is encoded so accents and ₹ survive.
  return /^[\x20-\x7E]*$/.test(str) ? str : '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}
function b64lines(buf) {
  return Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');
}
// A filename a mail client will accept: no quotes, no CR/LF, nothing that could
// smuggle another header in, and non-ASCII encoded rather than sent raw.
function safeFilename(name) {
  const clean = String(name || 'attachment').replace(/[\r\n"\\]/g, '').replace(/[\/]/g, '-').trim().slice(0, 120);
  return clean || 'attachment';
}
const ATTACH_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,60}$/;
function buildMessage({ fromEmail, fromName, to, cc, replyTo, subject, body, html, attachments }) {
  const boundaryDate = new Date().toUTCString();
  const id = '<' + crypto.randomBytes(12).toString('hex') + '@finowise-crm>';
  // base64 keeps UTF-8 intact and sidesteps line-length limits entirely.
  // base64 also means no body line can begin with a dot, so the lone dot that
  // ends DATA is never forged by the message itself.
  const encoded = b64lines(Buffer.from(String(body || ''), 'utf8'));
  const files = Array.isArray(attachments) ? attachments.filter(a => a && a.content) : [];
  const headers = [
    'From: ' + (fromName ? encodeHeader(fromName) + ' <' + fromEmail + '>' : fromEmail),
    'To: ' + to.join(', '),
  ];
  if (cc && cc.length) headers.push('Cc: ' + cc.join(', '));
  // Reply-To arrives from the caller: one plain address, or nothing. A CR or
  // LF in it would start a header of the caller's own.
  const reply = String(replyTo || '').trim();
  if (reply && ADDRESS_RE.test(reply)) headers.push('Reply-To: ' + reply);
  headers.push('Subject: ' + encodeHeader(subject));
  headers.push('Date: ' + boundaryDate);
  headers.push('Message-ID: ' + id);
  headers.push('MIME-Version: 1.0');
  if (!files.length) {
    headers.push('Content-Type: text/' + (html ? 'html' : 'plain') + '; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    return { text: headers.join('\r\n') + '\r\n\r\n' + encoded, messageId: id };
  }
  // With attachments the message becomes multipart/mixed: the note first, then
  // one part per file. The boundary is random, so nothing in a document can
  // accidentally (or deliberately) end a part early.
  const boundary = '=_finowise_' + crypto.randomBytes(16).toString('hex');
  headers.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  const parts = [
    '--' + boundary,
    'Content-Type: text/' + (html ? 'html' : 'plain') + '; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encoded,
  ];
  files.forEach(a => {
    const name = safeFilename(a.filename);
    const type = ATTACH_TYPE_RE.test(String(a.contentType || '')) ? a.contentType : 'application/octet-stream';
    parts.push('--' + boundary,
      'Content-Type: ' + type + '; name="' + name + '"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="' + name + '"',
      '',
      b64lines(Buffer.from(String(a.content), 'base64')));
  });
  parts.push('--' + boundary + '--', '');
  return { text: headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n'), messageId: id };
}
const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function cleanAddresses(value) {
  return String(value == null ? '' : value).split(/[,;]/).map(a => a.trim()).filter(Boolean);
}

// The client-credentials flow, which is what a server-to-server integration
// uses: no user sits in front of this, so there is nobody to send to a consent
// screen. The secret never leaves this process.
function graphToken(config, secrets, cb) {
  cb = callOnce(cb);
  const body = new URLSearchParams({
    client_id: config.clientId || '',
    client_secret: secrets.clientSecret || '',
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();
  const target = new URL('https://login.microsoftonline.com/' + encodeURIComponent(config.tenantId || '') + '/oauth2/v2.0/token');
  const req = https.request({
    hostname: target.hostname, path: target.pathname, method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    timeout: 12000,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', d => { if (data.length < 8000) data += d; });
    res.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(data); } catch (e) { /* fall through to the message below */ }
      if (res.statusCode >= 200 && res.statusCode < 300 && parsed.access_token) return cb(null, parsed.access_token);
      const why = parsed.error_description ? String(parsed.error_description).split('\n')[0] : (parsed.error || ('HTTP ' + res.statusCode));
      cb('Microsoft refused the credentials — ' + why);
    });
  });
  req.on('timeout', () => { req.destroy(); cb('Microsoft did not answer within 12 seconds.'); });
  req.on('error', e => cb('Could not reach Microsoft — ' + e.message));
  req.write(body);
  req.end();
}

// POST /api/outlook/meeting  { subject, start, end }
// Creates a real Teams meeting on the connected mailbox and returns its join
// link. 409 when the connector is not set up, so the UI can say which part.
app.post('/api/outlook/meeting', checkApiKey, (req, res) => {
  const c = connections.outlook;
  const config = (c && c.config) || {}, secrets = (c && c.secrets) || {};
  if (!c || !config.tenantId || !config.clientId) return res.status(409).json({ ok: false, notConfigured: true,
    message: 'Microsoft 365 is not connected. Add it under Setup → Connections.' });
  if (!c.enabled) return res.status(409).json({ ok: false, notConfigured: true,
    message: 'The Microsoft 365 connector is switched off. Tick "Enable this channel" on it.' });
  if (!config.userId) return res.status(409).json({ ok: false, notConfigured: true,
    message: 'The connector has no mailbox on it. Set the user principal name (you@firm.com) that meetings should be created under.' });
  const body = req.body || {};
  const start = body.start ? new Date(body.start) : new Date();
  if (isNaN(start)) return res.status(400).json({ ok: false, message: 'That start time is not a date.' });
  const end = body.end ? new Date(body.end) : new Date(start.getTime() + 60 * 60 * 1000);
  graphToken(config, secrets, (err, token) => {
    if (err) return res.status(502).json({ ok: false, message: err });
    const payload = JSON.stringify({
      startDateTime: start.toISOString(),
      endDateTime: (isNaN(end) ? new Date(start.getTime() + 3600000) : end).toISOString(),
      subject: String(body.subject || 'Meeting').slice(0, 250),
    });
    httpsProbeJson({
      url: 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(config.userId) + '/onlineMeetings',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: payload,
    }, (r) => {
      if (!r.ok) return res.status(502).json({ ok: false, message: 'Microsoft refused to create the meeting — ' + r.message });
      const join = r.json && (r.json.joinWebUrl || r.json.joinUrl);
      if (!join) return res.status(502).json({ ok: false, message: 'Microsoft created the meeting but returned no join link.' });
      res.json({ ok: true, joinUrl: join, id: r.json.id || '' });
    });
  });
});

// POST /api/mail/send  { to, cc?, subject, body, html?, replyTo?, attachments? }
// attachments: [{ filename, contentType, content }] where content is base64.
// 200 with { ok:true } only when the mail server took the message.
app.post('/api/mail/send', checkApiKey, (req, res) => sendMailRequest(req.body || {}, res, null));

/* ---------------------------------------------------------------------
   PIN AND IFSC LOOKUPS

   A team member's PIN fills their city, state and country; their IFSC
   fills the bank and the branch. Both are public directories — India
   Post's PIN list and the RBI IFSC list Razorpay publishes — asked from
   here rather than from the page, because a browser cannot call either
   without CORS they do not grant. The answer is cached, since a PIN or
   an IFSC does not move. Either base URL can be pointed elsewhere by
   environment variable, which is how the tests run without the internet.
   --------------------------------------------------------------------- */
const PIN_LOOKUP_URL = process.env.CRM_PIN_LOOKUP_URL || 'https://api.postalpincode.in/pincode/';
const IFSC_LOOKUP_URL = process.env.CRM_IFSC_LOOKUP_URL || 'https://ifsc.razorpay.com/';
const lookupCache = new Map();
async function lookupJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Finowise-CRM/1.0' },
    signal: AbortSignal.timeout(8000) });
  let json = null;
  try { json = await res.json(); } catch (e) { /* a 404 page is not JSON, which is itself the answer */ }
  return { status: res.status, json };
}
function cachedLookup(key, work, res) {
  if (lookupCache.has(key)) return res.json(lookupCache.get(key));
  work().then((answer) => {
    if (answer.ok || answer.notFound) {
      if (lookupCache.size > 5000) lookupCache.clear();
      lookupCache.set(key, answer);
    }
    res.status(answer.ok || answer.notFound ? 200 : 502).json(answer);
  }).catch((e) => res.status(502).json({ ok: false,
    message: e && e.name === 'TimeoutError' ? 'the directory did not answer in time' : 'the directory could not be reached' }));
}
/* Two-step sign-in, from My Profile. Status, then a code to the account's
   own address, then the code back — and only then is it switched. */
const meOtp = new Map();   // userId -> challenge for enabling or disabling
app.get('/api/me/2fa', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'not signed in' });
  res.set('Cache-Control', 'no-store').json({ ok: true, enabled: !!user.two_factor, email: maskEmail(user.email) });
});
app.post('/api/me/2fa/start', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'not signed in' });
  const action = (req.body || {}).action === 'disable' ? 'disable' : 'enable';
  if ((action === 'enable') === !!user.two_factor)
    return res.status(409).json({ ok: false, message: 'Two-step sign-in is already ' + (user.two_factor ? 'on' : 'off') + '.' });
  const was = meOtp.get(user.id);
  if (was && was.purpose === action && (req.body || {}).resend) {
    const wait = resendProblem(was);
    if (wait) return res.status(429).json({ ok: false, message: wait });
    was.resends++;
    return sendOtp(was, (err) => err ? res.status(503).json({ ok: false, message: 'The code could not be emailed: ' + err })
      : res.json({ ok: true, sentTo: maskEmail(user.email), resendsLeft: OTP_MAX_RESENDS - was.resends }));
  }
  const ch = newOtpChallenge(user, action);
  otpChallenges.delete(ch.id);           // not a sign-in: it lives in meOtp only
  meOtp.set(user.id, ch);
  sendOtp(ch, (err) => {
    if (err) { meOtp.delete(user.id); return res.status(503).json({ ok: false, message: 'The code could not be emailed: ' + err }); }
    res.json({ ok: true, sentTo: maskEmail(user.email), resendsLeft: OTP_MAX_RESENDS });
  });
});
app.post('/api/me/2fa/verify', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'not signed in' });
  const ch = meOtp.get(user.id);
  if (!ch) return res.status(409).json({ ok: false, message: 'Ask for a code first.' });
  const why = checkOtp(ch, (req.body || {}).code);
  if (why === 'expired' || why === 'locked') {
    meOtp.delete(user.id);
    return res.status(401).json({ ok: false, restart: true, message: why === 'expired'
      ? 'That code has expired. Ask for a new one.' : 'Too many wrong codes. Ask for a new one.' });
  }
  if (why) return res.status(401).json({ ok: false, message: 'That code is not right. '
    + (OTP_MAX_TRIES - ch.tries) + ' tr' + (OTP_MAX_TRIES - ch.tries === 1 ? 'y' : 'ies') + ' left.' });
  meOtp.delete(user.id);
  setUserTwoFactor.run(ch.purpose === 'enable' ? 1 : 0, user.id);
  res.json({ ok: true, enabled: ch.purpose === 'enable' });
});

function pinLookup(req, res) {
  const pin = String(req.params.pin || '');
  if (!/^[1-9][0-9]{5}$/.test(pin)) return res.status(400).json({ ok: false, message: 'A PIN code is 6 digits.' });
  cachedLookup('pin:' + pin, async () => {
    const { json } = await lookupJson(PIN_LOOKUP_URL + pin);
    const row = Array.isArray(json) ? json[0] : null;
    if (!row || typeof row !== 'object') return { ok: false, message: 'the PIN directory gave no usable answer' };
    const offices = Array.isArray(row.PostOffice) ? row.PostOffice : [];
    if (String(row.Status) !== 'Success' || !offices.length) return { ok: false, notFound: true };
    const first = offices[0] || {};
    return { ok: true, pin, city: first.District || first.Block || '', state: first.State || '',
      country: first.Country || 'India', offices: offices.slice(0, 20).map((o) => o && o.Name).filter(Boolean) };
  }, res);
}
app.get('/api/lookup/pincode/:pin', checkApiKey, pinLookup);
/* A client filling their own form types a PIN too, and their city, state
   and country fill the same way. The link's token is the permission: a
   PIN is public information, but the lookup is not offered to anyone
   who does not hold a live link. */
app.get('/api/public/pincode/:pin', (req, res) => {
  if (!publicScope(String(req.query.token || ''))) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  pinLookup(req, res);
});
app.get('/api/lookup/ifsc/:code', checkApiKey, (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return res.status(400).json({ ok: false, message: 'An IFSC is 11 characters, like SBIN0001234.' });
  cachedLookup('ifsc:' + code, async () => {
    const { status, json } = await lookupJson(IFSC_LOOKUP_URL + code);
    if (status === 404) return { ok: false, notFound: true };
    if (status !== 200 || !json || !json.BANK) return { ok: false, message: 'the IFSC directory gave no usable answer' };
    return { ok: true, ifsc: code, bank: json.BANK, branch: json.BRANCH || '', city: json.CITY || '',
      state: json.STATE || '', address: json.ADDRESS || '' };
  }, res);
});

/* ---------------------------------------------------------------------
   THE AADHAAR VAULT.

   A client record keeps the last four digits of an Aadhaar number and
   nothing more, because data.json is handed to every signed-in browser.
   The full number, where the firm needs it, lives here instead: in its
   own file beside data.json, encrypted, and served by this process only
   to an account management has approved by name or by role.

   Approval is decided here, against the sign-in account, not by hiding a
   button in the page — the page only asks. An admin account is
   management: it grants and withdraws access, and it is not exempt
   itself; an admin who wants to see a number approves themselves, and
   that approval is on the record like anybody else's. Every look, and
   every refusal, is written to the vault's own log.
   --------------------------------------------------------------------- */
const AADHAAR_FILE = process.env.CRM_AADHAAR_FILE || path.join(path.dirname(DB_FILE), 'aadhaar-vault.json');
const AADHAAR_KEY_FILE = AADHAAR_FILE.replace(/\.json$/, '') + '.key';
function aadhaarKey() {
  if (process.env.CRM_AADHAAR_KEY) return crypto.createHash('sha256').update(process.env.CRM_AADHAAR_KEY).digest();
  if (process.env.CRM_SESSION_SECRET) {
    return crypto.createHash('sha256').update(process.env.CRM_SESSION_SECRET + ':aadhaar-vault').digest();
  }
  // No secret configured (a laptop): a key of its own, kept beside the vault.
  try { return Buffer.from(fs.readFileSync(AADHAAR_KEY_FILE, 'utf8').trim(), 'hex'); } catch (e) { /* first run */ }
  const k = crypto.randomBytes(32);
  fs.writeFileSync(AADHAAR_KEY_FILE, k.toString('hex'), { mode: 0o600 });
  return k;
}
function vaultRead() {
  try {
    const v = JSON.parse(fs.readFileSync(AADHAAR_FILE, 'utf8'));
    return { clients: v.clients || {}, approved: { emails: (v.approved || {}).emails || [], roles: (v.approved || {}).roles || [] },
      log: Array.isArray(v.log) ? v.log : [] };
  } catch (e) { return { clients: {}, approved: { emails: [], roles: [] }, log: [] }; }
}
function vaultWrite(v) {
  v.log = v.log.slice(-5000);
  const tmp = AADHAAR_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
  fs.renameSync(tmp, AADHAAR_FILE);
}
function vaultSeal(number) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aadhaarKey(), iv);
  const enc = Buffer.concat([c.update(number, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), enc: enc.toString('hex') };
}
function vaultOpen(row) {
  const d = crypto.createDecipheriv('aes-256-gcm', aadhaarKey(), Buffer.from(row.iv, 'hex'));
  d.setAuthTag(Buffer.from(row.tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(row.enc, 'hex')), d.final()]).toString('utf8');
}
// The same check the page makes: 12 digits, not starting 0 or 1, Verhoeff check digit.
const VH_D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
  [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
  [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VH_P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
function aadhaarValid(d) {
  if (!/^[2-9][0-9]{11}$/.test(d)) return false;
  let c = 0;
  d.split('').reverse().forEach((ch, i) => { c = VH_D[c][VH_P[i % 8][Number(ch)]]; });
  return c === 0;
}
function aadhaarApproved(user, v) {
  if (!user) return false;
  const email = String(user.email || '').toLowerCase();
  if (v.approved.emails.some((e) => String(e).toLowerCase() === email)) return true;
  return !!user.crm_role && v.approved.roles.indexOf(user.crm_role) >= 0;
}
function vaultLog(v, user, action, clientId, note) {
  v.log.push({ at: new Date().toISOString(), by: (user && user.email) || '', action, clientId: clientId || '', note: note || '' });
}
// Who may see, and whether the person asking is one of them.
app.get('/api/aadhaar/access', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const v = vaultRead();
  const admin = !!(user && user.role === 'admin');
  res.set('Cache-Control', 'no-store').json({ ok: true, me: { email: (user && user.email) || '', admin,
    approved: aadhaarApproved(user, v) }, approved: admin ? v.approved : undefined,
    log: admin ? v.log.slice(-200).reverse() : undefined });
});
app.put('/api/aadhaar/access', checkApiKey, requireApiAdmin, (req, res) => {
  const user = signedInUser(req);
  const b = req.body || {};
  const v = vaultRead();
  const list = (x) => Array.from(new Set((Array.isArray(x) ? x : []).map((s) => String(s).trim()).filter(Boolean)));
  const before = JSON.stringify(v.approved);
  v.approved = { emails: list(b.emails).map((e) => e.toLowerCase()), roles: list(b.roles) };
  if (JSON.stringify(v.approved) !== before) {
    vaultLog(v, user, 'access changed', '', 'accounts: ' + (v.approved.emails.join(', ') || 'none')
      + '; roles: ' + (v.approved.roles.join(', ') || 'none'));
  }
  vaultWrite(v);
  res.json({ ok: true, approved: v.approved });
});
// Store a full number. Anybody who may edit a client may put one in; seeing
// it again is the approved question.
app.put('/api/aadhaar/:clientId', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const id = String(req.params.clientId || '');
  const number = String((req.body || {}).number || '').replace(/[\s-]/g, '');
  if (!id) return res.status(400).json({ ok: false, message: 'Which client?' });
  const v = vaultRead();
  if (!number) {
    if (v.clients[id]) { delete v.clients[id]; vaultLog(v, user, 'removed', id); vaultWrite(v); }
    return res.json({ ok: true, removed: true });
  }
  if (!aadhaarValid(number)) return res.status(422).json({ ok: false, message: 'Please enter a valid Aadhaar number.' });
  v.clients[id] = Object.assign(vaultSeal(number), { last4: number.slice(-4), at: new Date().toISOString(),
    by: (user && user.email) || '' });
  vaultLog(v, user, 'stored', id, 'ending ' + number.slice(-4));
  vaultWrite(v);
  res.json({ ok: true, last4: number.slice(-4) });
});
app.get('/api/aadhaar/:clientId', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const id = String(req.params.clientId || '');
  const v = vaultRead();
  res.set('Cache-Control', 'no-store');
  if (!aadhaarApproved(user, v)) {
    vaultLog(v, user, 'refused', id); vaultWrite(v);
    return res.status(403).json({ ok: false, message: 'The full Aadhaar number is shown only to people management has approved.' });
  }
  const row = v.clients[id];
  if (!row) return res.status(404).json({ ok: false, message: 'Only the last four digits of this Aadhaar number are on file.' });
  let number;
  try { number = vaultOpen(row); } catch (e) {
    return res.status(500).json({ ok: false, message: 'The stored number could not be read.' });
  }
  vaultLog(v, user, 'viewed', id, 'ending ' + row.last4); vaultWrite(v);
  res.json({ ok: true, number });
});

/* ---------------------------------------------------------------------
   LIVE NAVs

   AMFI publishes every scheme's latest NAV in one public text file, once
   each business day. The page cannot read it (no CORS), so it asks here:
   it sends the scheme names (and ISINs, when an import gave them) of the
   holdings it is drawing, and gets back each one's latest NAV and its
   date. The file is read at most once every thirty minutes. The URL can be
   pointed elsewhere by environment variable, which is how the tests run
   without the internet.
   --------------------------------------------------------------------- */
const NAV_URL = process.env.CRM_NAV_URL || 'https://www.amfiindia.com/spages/NAVAll.txt';
let navCache = null, navLoading = null;
const NAV_DROP = new Set(['fund', 'plan', 'option', 'growth', 'the', 'india', 'scheme', 'of', 'mutual', 'mf']);
function navTokens(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !NAV_DROP.has(w));
}
async function navList() {
  if (navCache && Date.now() - navCache.at < 30 * 60 * 1000) return navCache;
  if (navLoading) return navLoading;
  navLoading = (async () => {
    const res = await fetch(NAV_URL, { headers: { 'User-Agent': 'Finowise-CRM/1.0' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('AMFI answered ' + res.status);
    const rows = [];
    String(await res.text()).split(/\r?\n/).forEach((line) => {
      const f = line.split(';');
      if (f.length < 6 || !/^\d+$/.test(f[0].trim())) return;
      const nav = parseFloat(f[4]);
      if (!isFinite(nav)) return;
      const name = f[3].trim();
      rows.push({ code: f[0].trim(), isin: [f[1].trim(), f[2].trim()].filter((x) => x && x !== '-'), name, nav, date: f[5].trim(),
        toks: new Set(navTokens(name)), direct: /\bdirect\b/i.test(name), growth: /growth/i.test(name) && !/idcw|dividend|bonus/i.test(name) });
    });
    if (!rows.length) throw new Error('the NAV file had no schemes in it');
    navCache = { at: Date.now(), fetchedAt: new Date().toISOString(), rows };
    return navCache;
  })();
  try { return await navLoading; } finally { navLoading = null; }
}
/* The scheme a holding is: by ISIN when there is one; otherwise the AMFI
   name holding every word of the holding's name, the same plan (direct
   or regular) and the growth option preferred, the shortest name winning. */
function navMatch(list, q) {
  const isin = String(q.isin || '').trim().toUpperCase();
  if (isin) { const hit = list.rows.find((r) => r.isin.includes(isin)); if (hit) return hit; }
  const want = navTokens(q.name).filter((w) => !['direct', 'regular', 'idcw', 'dividend', 'payout', 'reinvestment'].includes(w));
  if (!want.length) return null;
  const direct = /\bdirect\b/i.test(q.name || '');
  let best = null, score = -1;
  for (const r of list.rows) {
    if (!want.every((w) => r.toks.has(w))) continue;
    const s = (r.direct === direct ? 4 : 0) + (r.growth ? 2 : 0) - r.toks.size / 100;
    if (s > score) { score = s; best = r; }
  }
  return best;
}
app.post('/api/market/nav', checkApiKey, async (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 500) : [];
  try {
    const list = await navList();
    const results = items.map((q) => {
      const hit = navMatch(list, q || {});
      return hit ? { name: q.name, isin: q.isin || '', code: hit.code, scheme: hit.name, nav: hit.nav, date: hit.date } : { name: q.name, isin: q.isin || '', missing: true };
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, source: 'AMFI', fetchedAt: list.fetchedAt, results });
  } catch (e) {
    // A 200 with ok:false, not a 5xx: AMFI being down is an answer the
    // client card shows ("statement values shown"), not a failed request
    // for the browser to log against the page.
    res.set('Cache-Control', 'no-store').json({ ok: false, message: e && e.name === 'TimeoutError' ? 'AMFI did not answer in time' : 'the AMFI NAV list could not be read: ' + (e && e.message || e) });
  }
});

/* ---------------------------------------------------------------------
   LIVE MARKET PRICES

   "HDFC Bank ka share live dikhao", "Reliance ya TCS, konsa loon?": LEXI
   reads any listed company or index here. The page sends a name or a
   symbol; this resolves it to an NSE (or BSE) listing, reads a year of
   daily prices and works out what an advisor looks at: the day's move,
   where it sits in its 52-week range, returns, RSI and the 20/50/200-day
   averages. Headlines come with the search.

   The source is Yahoo Finance's public chart and search endpoints, which
   need no key. They are unofficial and can change or be rate-limited, so
   everything that knows their shape is in the two functions below: a
   licensed feed replaces them without touching anything else. Answers are
   kept for a minute. CRM_MARKET_URL points it elsewhere (the tests).
   --------------------------------------------------------------------- */
const MARKET_URL = String(process.env.CRM_MARKET_URL || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
const MARKET_SOURCE = 'Yahoo Finance';
const marketCache = new Map();
// How long a price answer is kept; the tests set CRM_MARKET_CACHE_SECONDS=0 so a second read sees the feed's new price.
const marketTtl = (ms) => (process.env.CRM_MARKET_CACHE_SECONDS ? Number(process.env.CRM_MARKET_CACHE_SECONDS) * 1000 : ms);
async function marketGet(path, ttl) {
  const url = MARKET_URL + path;
  const hit = marketCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.json;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Finowise-CRM/1.0)', Accept: 'application/json' },
    signal: AbortSignal.timeout(12000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('the price feed answered ' + res.status);
  const json = await res.json();
  marketCache.set(url, { at: Date.now(), json });
  if (marketCache.size > 400) marketCache.delete(marketCache.keys().next().value);
  return json;
}
// The names people use for the indices, mapped to the feed's symbols.
const MARKET_ALIASES = {
  'nifty': '^NSEI', 'nifty 50': '^NSEI', 'nifty50': '^NSEI', 'sensex': '^BSESN', 'bse sensex': '^BSESN',
  'bank nifty': '^NSEBANK', 'banknifty': '^NSEBANK', 'nifty bank': '^NSEBANK', 'nifty it': '^CNXIT',
  'nifty midcap': '^NSEMDCP50', 'midcap': '^NSEMDCP50', 'nifty pharma': '^CNXPHARMA', 'nifty auto': '^CNXAUTO',
};
const marketIndian = (s) => /\.(NS|BO)$/.test(s) || /^\^/.test(s);
/* A name or a symbol to listings, best first: NSE before BSE, and the
   headlines the search returned. */
async function marketSearch(q) {
  const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
  if (MARKET_ALIASES[key]) return { listings: [{ symbol: MARKET_ALIASES[key], name: q.toUpperCase(), type: 'INDEX' }], news: [] };
  const json = await marketGet('/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=10&newsCount=6&lang=en-IN&region=IN', 10 * 60 * 1000);
  const quotes = ((json && json.quotes) || []).filter((x) => x && x.symbol && marketIndian(x.symbol)
    && /^(EQUITY|INDEX|ETF)$/i.test(x.quoteType || 'EQUITY'));
  quotes.sort((a, b) => (/\.NS$/.test(b.symbol) - /\.NS$/.test(a.symbol)));
  const seen = new Set(), listings = [];
  quotes.forEach((x) => {
    const base = x.symbol.replace(/\.(NS|BO)$/, '');
    if (seen.has(base)) return; seen.add(base);
    listings.push({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, type: x.quoteType || 'EQUITY',
      sector: x.sectorDisp || x.sector || '', industry: x.industryDisp || x.industry || '' });
  });
  // A bare NSE code ("TCS", "HDFCBANK") that the search did not return still gets tried as itself.
  if (!listings.length && /^[A-Z0-9&-]{2,20}$/i.test(q.trim())) listings.push({ symbol: q.trim().toUpperCase() + '.NS', name: q.trim().toUpperCase(), type: 'EQUITY' });
  const news = ((json && json.news) || []).slice(0, 6).map((n) => ({ title: n.title, publisher: n.publisher || '',
    time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : '' }));
  return { listings, news };
}
const marketRound = (n, d = 2) => (n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
function marketSma(c, n) { return c.length >= n ? c.slice(-n).reduce((a, b) => a + b, 0) / n : null; }
function marketRsi(c, n = 14) {
  if (c.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n; loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
/* The checks a chartist runs, computed here so the model reads them and never
   works them out: trend strength (ADX), momentum (MACD, RSI), volatility (ATR,
   Bollinger Bands), the nearest levels, volume against its norm and how many
   of the standard checks lean up. A checklist of what the chart shows, not a
   forecast. */
function marketEma(c, n) {
  if (c.length < n) return [];
  const k = 2 / (n + 1), out = new Array(c.length).fill(null);
  let e = c.slice(0, n).reduce((a, b) => a + b, 0) / n; out[n - 1] = e;
  for (let i = n; i < c.length; i++) { e = c[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function marketAdx(H, L, C, n = 14) {
  if (C.length < n * 2 + 1) return null;
  let tr = 0, pdm = 0, ndm = 0; const dx = [];
  for (let i = 1; i <= C.length - 1; i++) {
    const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
    const t = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; pdm += p; ndm += m; }
    else { tr = tr - tr / n + t; pdm = pdm - pdm / n + p; ndm = ndm - ndm / n + m; }
    if (i >= n && tr > 0) {
      const pdi = 100 * pdm / tr, ndi = 100 * ndm / tr;
      dx.push({ dx: pdi + ndi === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi), pdi, ndi });
    }
  }
  if (dx.length < n) return null;
  let adx = dx.slice(0, n).reduce((a, b) => a + b.dx, 0) / n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i].dx) / n;
  const last = dx[dx.length - 1];
  return { adx, plusDi: last.pdi, minusDi: last.ndi };
}
function marketAtr(H, L, C, n = 14) {
  if (C.length <= n) return null;
  const tr = (i) => Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
  let a = 0; for (let i = 1; i <= n; i++) a += tr(i); a /= n;
  for (let i = n + 1; i < C.length; i++) a = (a * (n - 1) + tr(i)) / n;
  return a;
}
function marketTechnicals(C, H, L, V, price, rsi, sma50, sma200) {
  const R = marketRound, t = {};
  const e12 = marketEma(C, 12), e26 = marketEma(C, 26);
  if (e26.length) {
    const line = []; for (let i = 0; i < C.length; i++) if (e26[i] != null) line.push(e12[i] - e26[i]);
    const sig = marketEma(line, 9);
    if (sig.length) {
      const m = line[line.length - 1], sg = sig[sig.length - 1], h = m - sg, hp = line[line.length - 2] - sig[sig.length - 2];
      t.macd = { line: R(m, 2), signal: R(sg, 2), histogram: R(h, 2), histogramRising: h > hp,
        state: m > sg ? (m > 0 ? 'above its signal line and above zero: bullish momentum' : 'above its signal line but still below zero: a recovery attempt')
          : (m < 0 ? 'below its signal line and below zero: bearish momentum' : 'below its signal line but above zero: momentum fading') };
    }
  }
  if (C.length >= 20) {
    const w = C.slice(-20), mid = w.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / 20);
    const up = mid + 2 * sd, lo = mid - 2 * sd;
    t.bollinger = { upper: R(up), middle: R(mid), lower: R(lo), percentB: sd ? R((price - lo) / (up - lo) * 100, 0) : null, bandwidthPct: mid ? R(4 * sd / mid * 100, 1) : null };
  }
  const adx = marketAdx(H, L, C);
  if (adx) t.trendStrength = { adx: R(adx.adx, 0), plusDi: R(adx.plusDi, 0), minusDi: R(adx.minusDi, 0),
    reading: adx.adx >= 40 ? 'very strong trend' : adx.adx >= 25 ? 'a trending market' : adx.adx >= 20 ? 'a trend is forming' : 'no real trend: a range-bound market',
    direction: adx.plusDi > adx.minusDi ? 'buyers lead' : 'sellers lead' };
  const atr = marketAtr(H, L, C);
  if (atr) t.atr14 = { value: R(atr), pctOfPrice: price ? R(atr / price * 100, 1) : null };
  if (C.length > 20) {
    const r = []; for (let i = C.length - 60 > 0 ? C.length - 60 : 1; i < C.length; i++) r.push(Math.log(C[i] / C[i - 1]));
    const mu = r.reduce((a, b) => a + b, 0) / r.length;
    t.volatilityPct = R(Math.sqrt(r.reduce((a, b) => a + (b - mu) ** 2, 0) / (r.length - 1)) * Math.sqrt(252) * 100, 1);
  }
  const lv = {}; [20, 60].forEach((n) => { if (L.length >= n) { lv['low' + n] = R(Math.min(...L.slice(-n))); lv['high' + n] = R(Math.max(...H.slice(-n))); } });
  if (lv.low20 != null) {
    t.levels = lv;
    t.levels.note = 'support is the recent lows, resistance the recent highs; ' + (price <= lv.low20 * 1.01 ? 'price is sitting on its 20-day support' : price >= lv.high20 * 0.99 ? 'price is pressing its 20-day resistance' : 'price is between them');
  }
  const vs = V.filter((v) => v > 0);
  if (V.length >= 21 && V[V.length - 1] > 0 && vs.length > V.length * 0.8) {
    const avg = V.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    if (avg > 0) t.volumeVsAvg20 = R(V[V.length - 1] / avg, 2);
  }
  // A cross of the 50- and 200-day averages in the last 30 sessions.
  if (C.length >= 230) {
    const sm = (i, n) => C.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
    let was = null;
    for (let i = C.length - 31; i < C.length; i++) { const above = sm(i, 50) > sm(i, 200); if (was != null && above !== was) t.crossLast30 = above ? 'golden cross (50-day moved above the 200-day)' : 'death cross (50-day moved below the 200-day)'; was = above; }
  }
  // The checklist: one point each way, so the advisor sees how broad the lean is.
  const checks = [];
  const add = (label, ok) => { if (ok != null) checks.push({ label, up: !!ok }); };
  if (sma50 != null) add('price vs 50-day average', price > sma50);
  if (sma200 != null) add('price vs 200-day average', price > sma200);
  if (sma50 != null && sma200 != null) add('50-day vs 200-day average', sma50 > sma200);
  if (t.macd) { add('MACD vs signal line', t.macd.line > t.macd.signal); add('MACD histogram direction', t.macd.histogramRising); }
  if (rsi != null) add('RSI vs 50', rsi > 50);
  if (t.trendStrength) add('buyers vs sellers (+DI vs -DI)', t.trendStrength.plusDi > t.trendStrength.minusDi);
  const ups = checks.filter((c) => c.up).length;
  if (checks.length >= 4) {
    const share = ups / checks.length;
    t.checklist = { positive: ups, of: checks.length, bias: share >= 0.75 ? 'bullish' : share <= 0.25 ? 'bearish' : share >= 0.55 ? 'leaning bullish' : share <= 0.45 ? 'leaning bearish' : 'neutral',
      againstTheLean: checks.filter((c) => c.up !== (share >= 0.5)).map((c) => c.label) };
  }
  if (rsi != null) t.rsiReading = rsi >= 70 ? 'overbought: stretched, prone to a pause' : rsi <= 30 ? 'oversold: stretched down, prone to a bounce' : rsi >= 55 ? 'firm' : rsi <= 45 ? 'weak' : 'neutral';
  return t;
}
/* One listing's year of daily prices, read down to what an advisor uses. */
async function marketQuote(symbol) {
  const json = await marketGet('/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1y&interval=1d', marketTtl(60 * 1000));
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.meta) return null;
  const m = r.meta, q = ((r.indicators || {}).quote || [])[0] || {};
  const bars = (r.timestamp || []).map((t, i) => ({ t: t * 1000, c: (q.close || [])[i], h: (q.high || [])[i], l: (q.low || [])[i], v: (q.volume || [])[i] || 0 }))
    .filter((b) => b.c != null && isFinite(b.c));
  if (!bars.length && m.regularMarketPrice == null) return null;
  const price = m.regularMarketPrice != null ? m.regularMarketPrice : bars[bars.length - 1].c;
  const time = m.regularMarketTime ? m.regularMarketTime * 1000 : bars[bars.length - 1].t;
  // The previous session's close: the last bar from an earlier trading day than the price's own (in IST).
  const istDay = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
  const earlier = bars.filter((b) => istDay(b.t) < istDay(time));
  const prev = earlier.length ? earlier[earlier.length - 1].c : (m.previousClose != null ? m.previousClose : null);
  const closes = bars.map((b) => b.c);
  if (closes.length && istDay(bars[bars.length - 1].t) === istDay(time)) closes[closes.length - 1] = price; else closes.push(price);
  const history = bars.map((b) => [istDay(b.t), marketRound(b.c)]);
  if (history.length && history[history.length - 1][0] === istDay(time)) history[history.length - 1][1] = marketRound(price); else history.push([istDay(time), marketRound(price)]);
  const back = (n) => (closes.length > n ? (price / closes[closes.length - 1 - n] - 1) * 100 : null);
  const hi = m.fiftyTwoWeekHigh != null ? m.fiftyTwoWeekHigh : Math.max(...bars.map((b) => b.h || b.c));
  const lo = m.fiftyTwoWeekLow != null ? m.fiftyTwoWeekLow : Math.min(...bars.map((b) => b.l || b.c));
  const sma50 = marketSma(closes, 50), sma200 = marketSma(closes, 200);
  // High, low and volume lined up with `closes` (a live price on a new day adds a bar of its own).
  const H = bars.map((b) => (b.h != null && isFinite(b.h) ? b.h : b.c)), L = bars.map((b) => (b.l != null && isFinite(b.l) ? b.l : b.c)), V = bars.map((b) => b.v);
  if (closes.length > H.length) { H.push(price); L.push(price); V.push(0); } else { H[H.length - 1] = Math.max(H[H.length - 1], price); L[L.length - 1] = Math.min(L[L.length - 1], price); }
  const technical = marketTechnicals(closes, H, L, V, price, marketRsi(closes), sma50, sma200);
  return {
    symbol: m.symbol || symbol, name: m.longName || m.shortName || symbol, exchange: m.fullExchangeName || m.exchangeName || '',
    currency: m.currency || 'INR', price: marketRound(price), time: new Date(time).toISOString(),
    prevClose: marketRound(prev), change: prev ? marketRound(price - prev) : null, changePct: prev ? marketRound((price / prev - 1) * 100) : null,
    dayHigh: marketRound(m.regularMarketDayHigh), dayLow: marketRound(m.regularMarketDayLow),
    high52: marketRound(hi), low52: marketRound(lo), fromHigh52Pct: hi ? marketRound((price / hi - 1) * 100) : null,
    returnsPct: { week: marketRound(back(5)), month: marketRound(back(21)), quarter: marketRound(back(63)), halfYear: marketRound(back(126)),
      year: closes.length > 200 ? marketRound((price / closes[0] - 1) * 100) : null },
    technical,
    rsi14: marketRound(marketRsi(closes), 1), sma20: marketRound(marketSma(closes, 20)), sma50: marketRound(sma50), sma200: marketRound(sma200),
    trend: sma50 && sma200 ? (price > sma50 && sma50 > sma200 ? 'uptrend: above the 50-day average, which is above the 200-day'
      : price < sma50 && sma50 < sma200 ? 'downtrend: below the 50-day average, which is below the 200-day'
      : 'mixed: between its 50-day and 200-day averages') : null,
    closes: bars.slice(-60).map((b, i, a) => [istDay(b.t), marketRound(i === a.length - 1 && istDay(b.t) === istDay(time) ? price : b.c)]),
    // The whole year, for the large chart a click on the card opens. Not sent to the model.
    history: history,
  };
}
const MARKET_SYMBOL_RE = /^[\^A-Za-z0-9.&_-]{1,30}$/;
// GET /api/market/quote?q=<company, index or symbol>, or ?symbol=<the feed's own symbol> to refresh one listing without searching
app.get('/api/market/quote', checkApiKey, async (req, res) => {
  const sym = String(req.query.symbol || '').trim();
  if (sym) {
    res.set('Cache-Control', 'no-store');
    if (!MARKET_SYMBOL_RE.test(sym)) return res.json({ ok: false, message: 'That is not a symbol.' });
    try {
      const quote = await marketQuote(sym);
      if (!quote) return res.json({ ok: false, notFound: true, query: sym, message: 'No price for "' + sym + '".' });
      return res.json({ ok: true, source: MARKET_SOURCE, fetchedAt: new Date().toISOString(), query: sym, quote, news: [], alternatives: [] });
    } catch (e) {
      return res.json({ ok: false, query: sym, message: 'live prices could not be read: ' + (e && e.message || e) });
    }
  }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.status(400).json({ ok: false, message: 'Say which company or index.' });
  res.set('Cache-Control', 'no-store');
  try {
    const found = await marketSearch(q);
    for (const l of found.listings.slice(0, 3)) {
      const quote = await marketQuote(l.symbol);
      if (!quote) continue;
      if (l.sector) quote.sector = l.sector;
      if (l.industry) quote.industry = l.industry;
      return res.json({ ok: true, source: MARKET_SOURCE, fetchedAt: new Date().toISOString(), query: q, quote,
        news: found.news, alternatives: found.listings.filter((x) => x.symbol !== l.symbol).slice(0, 3) });
    }
    res.json({ ok: false, notFound: true, query: q, message: 'No NSE or BSE listing matched "' + q + '".' });
  } catch (e) {
    // As with NAVs: the feed being down is an answer for LEXI to pass on, not a failed request.
    res.json({ ok: false, query: q, message: e && e.name === 'TimeoutError' ? 'the price feed did not answer in time' : 'live prices could not be read: ' + (e && e.message || e) });
  }
});

/* The candles behind the large chart: open, high, low, close and volume for
   the timeframe asked, in the feed's own bar size for it. */
const MARKET_RANGES = { '1D': ['1d', '5m'], '5D': ['5d', '15m'], '1M': ['1mo', '1d'], '3M': ['3mo', '1d'], '6M': ['6mo', '1d'],
  YTD: ['ytd', '1d'], '1Y': ['1y', '1d'], '5Y': ['5y', '1wk'], ALL: ['max', '1mo'] };
// GET /api/market/candles?symbol=<the feed's symbol>&range=1D|5D|1M|3M|6M|YTD|1Y|5Y|ALL
app.get('/api/market/candles', checkApiKey, async (req, res) => {
  const symbol = String(req.query.symbol || '').trim(), range = String(req.query.range || '6M').toUpperCase(), rg = MARKET_RANGES[range];
  res.set('Cache-Control', 'no-store');
  if (!MARKET_SYMBOL_RE.test(symbol) || !rg) return res.json({ ok: false, message: 'Say which symbol and which range.' });
  try {
    const json = await marketGet('/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=' + rg[0] + '&interval=' + rg[1],
      marketTtl(rg[1].endsWith('m') && rg[1] !== '1mo' ? 20 * 1000 : 45 * 1000));
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.meta) return res.json({ ok: false, notFound: true, symbol, message: 'No prices for "' + symbol + '".' });
    const m = r.meta, q = ((r.indicators || {}).quote || [])[0] || {};
    const candles = (r.timestamp || []).map((t, i) => [t * 1000, (q.open || [])[i], (q.high || [])[i], (q.low || [])[i], (q.close || [])[i], (q.volume || [])[i] || 0])
      .filter((c) => [1, 2, 3, 4].every((k) => c[k] != null && isFinite(c[k])))
      .map((c) => [c[0], marketRound(c[1]), marketRound(c[2]), marketRound(c[3]), marketRound(c[4]), c[5]]);
    res.json({ ok: true, source: MARKET_SOURCE, fetchedAt: new Date().toISOString(), symbol: m.symbol || symbol, range, interval: rg[1],
      currency: m.currency || 'INR', price: marketRound(m.regularMarketPrice), time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : '',
      prevClose: marketRound(m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose), candles });
  } catch (e) {
    res.json({ ok: false, symbol, message: e && e.name === 'TimeoutError' ? 'the price feed did not answer in time' : 'candles could not be read: ' + (e && e.message || e) });
  }
});

// One send, whether it came from the CRM or from a client's own page. `allowed`
// is null for a signed-in sender and a list of addresses for a public one, so a
// form link can write to the people it concerns and to nobody else.
function sendMailRequest(body, res, allowed) {
  sendMail(body, allowed, (status, json) => res.status(status).json(json));
}
// The same send for the server's own letters (a sign-in code), which have
// no request to answer: done(status, { ok, message }).
function sendMail(body, allowed, done) {
  const c = connections.email;
  const config = (c && c.config) || {}, secrets = (c && c.secrets) || {};
  const to = cleanAddresses(body.to), cc = cleanAddresses(body.cc);
  if (!to.length) return done(400, { ok: false, message: 'No recipient.' });
  const bad = to.concat(cc).find(a => !ADDRESS_RE.test(a));
  if (bad) return done(400, { ok: false, message: '"' + bad + '" is not a usable email address.' });
  if (allowed) {
    const set = new Set(allowed.filter(Boolean).map((a) => String(a).toLowerCase()));
    const outside = to.concat(cc).find((a) => !set.has(a.toLowerCase()));
    if (outside) return done(403, { ok: false,
      message: 'This link may only write to the people it concerns, not to ' + outside + '.' });
  }

  if (!c || !config.host) return done(409, { ok: false, notConfigured: true,
    message: 'No email connector is set up yet. Add your SMTP details under Setup → Developer Hub → Connections.' });
  if (!c.enabled) return done(409, { ok: false, notConfigured: true,
    message: 'The email connector is switched off. Tick "Enable this channel" on it and test the connection.' });
  if (c.status !== 'Connected') return done(409, { ok: false, notConfigured: true,
    message: 'The email connector has not passed a connection test' + (c.lastTestMessage ? ' — ' + c.lastTestMessage : '') + '.' });

  const fromEmail = (config.fromEmail || config.username || '').trim();
  if (!ADDRESS_RE.test(fromEmail)) return done(409, { ok: false, notConfigured: true,
    message: 'The connector has no usable From address. Set From Email on it.' });

  // Attachments are capped well under the JSON body limit, so a huge file is
  // refused with a sentence rather than by the request dying halfway.
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [];
  let attachBytes = 0;
  for (const a of attachments) {
    if (!a || typeof a.content !== 'string') return done(400, { ok: false, message: 'An attachment had no content.' });
    if (!/^[A-Za-z0-9+/=\s]*$/.test(a.content)) return done(400, { ok: false, message: 'An attachment was not base64.' });
    attachBytes += Math.ceil(a.content.replace(/\s/g, '').length * 3 / 4);
  }
  if (attachBytes > 12 * 1024 * 1024) return done(413, { ok: false,
    message: 'The attachments come to ' + Math.round(attachBytes / (1024 * 1024)) + 'MB. Most mailboxes refuse anything over about 10MB — send a link instead.' });

  const msg = buildMessage({
    fromEmail, fromName: config.fromName, to, cc,
    replyTo: (body.replyTo || '').trim() || undefined,
    subject: body.subject || '(no subject)',
    body: body.body || '',
    html: !!body.html,
    attachments,
  });
  smtpSession({
    host: config.host,
    port: Number(config.port) || (config.secure ? 465 : 587),
    secure: !!config.secure,
    username: config.username || '',
    password: secrets.password || '',
    message: { from: fromEmail, to: to.concat(cc), body: msg.text },
  }, (result) => {
    done(200, { ok: !!result.ok, message: result.message, messageId: result.ok ? msg.messageId : undefined,
      from: fromEmail, to, cc });
  });
}

/* ---------------------------------------------------------------------
   API CONNECTORS

   A connector is a piece of configuration the firm writes in Setup: an
   external system, a URL, an authentication method, a module and a
   field map. It lives in the CRM's own store like everything else the
   firm configures — except its credential, which lives here, beside the
   SMTP password, in connections.json outside the repository. The
   browser can set it and can say whether one is stored; it can never
   read one back.

   Three things have to happen on the server rather than in the page.

   1. THE CREDENTIAL. A key in the browser is a key in the DOM, in the
      backup file and in anybody's devtools. It is written once and
      never served.
   2. THE CALL. A page cannot call an arbitrary API anyway — the browser
      refuses it without CORS the other side has no reason to grant —
      and a call made here can have the credential attached without the
      page ever holding it.
   3. THE OTHER DIRECTION. An external system that wants BOSS data, or
      wants to push into BOSS, needs somewhere to knock. That is
      /api/share/:id, authorised by a token held here, which answers
      from this server's own copy of the store.

   The proxy is an admin tool that makes the server fetch a URL, so it
   is deliberately narrow: https only, no private or loopback address,
   one call per request, a size cap and a timeout.
   --------------------------------------------------------------------- */
const API_CONN_PREFIX = 'apiconn:';
function apiConnEntry(id) {
  return connections[API_CONN_PREFIX + id] || { secrets: {} };
}
/* An address this server must not be talked into fetching. The proxy is
   open to an administrator by design; it is not a way to reach whatever
   else happens to be listening on this machine or its network. */
function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '[::1]') return true;
  if (/\.(internal|local|lan|home|intranet)$/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}
function hostOf(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { return ''; }
}
/* Where a connector's stored credential may go: the hosts saved with it,
   or, for a credential saved before that, the base URL and token URL on the
   connector as configured. */
function apiConnHosts(id) {
  const entry = apiConnEntry(id);
  if (Array.isArray(entry.hosts) && entry.hosts.length) return entry.hosts;
  const c = shareConnector(id) || {};
  return [c.baseUrl, (c.auth || {}).tokenUrl].map(hostOf).filter(Boolean);
}
function credentialHostProblem(id, url) {
  const allowed = apiConnHosts(id);
  const h = hostOf(url);
  if (!h) return 'That is not a valid URL.';
  if (!allowed.includes(h))
    return 'The stored credential belongs to ' + (allowed.join(', ') || 'no saved address') + ', not ' + h + '. Save the connector with this address first.';
  return '';
}
/* privateHost looks at the name as written; a public name can still point
   at this machine or its network. The address the name resolves to is
   checked as the connection is made. */
const dns = require('dns');
function privateAddress(ip) {
  const a = String(ip || '').toLowerCase().replace(/^::ffff:/, '');
  if (a === '::1' || a === '::' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd')) return true;
  return privateHost(a);
}
function publicOnlyLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (list.some((x) => privateAddress(x.address)))
      return cb(Object.assign(new Error('that address is on this server\'s own network'), { code: 'EPRIVATE' }));
    cb(null, address, family);
  });
}
/* The one outbound call, with the stored credential put on it here. */
function apiConnFetch(opts, cb) {
  cb = callOnce(cb);
  let target;
  try { target = new URL(opts.url); } catch (e) { return cb({ ok: false, status: 0, message: 'That is not a valid URL.' }); }
  if (target.protocol !== 'https:')
    return cb({ ok: false, status: 0, message: 'Use an https:// endpoint — a credential must not travel over plain http.' });
  if (privateHost(target.hostname))
    return cb({ ok: false, status: 0, message: 'That address is on this server\'s own network, which a connector may not reach.' });
  const started = Date.now();
  const req = https.request({
    hostname: target.hostname, port: target.port || 443,
    path: target.pathname + target.search, method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'BOSS-CRM/1.0', 'Accept': 'application/json' }, opts.headers || {}),
    timeout: Math.min(Math.max(Number(opts.timeout) || 20000, 1000), 60000),
    lookup: publicOnlyLookup,
  }, (res) => {
    let data = '', over = false;
    res.setEncoding('utf8');
    res.on('data', d => { if (data.length < 400000) data += d; else over = true; });
    res.on('end', () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      let json = null;
      try { json = JSON.parse(data); } catch (e) { /* not json, which is itself informative */ }
      cb({
        ok, status: res.statusCode, json,
        text: json ? null : data.slice(0, 4000),
        truncated: over, ms: Date.now() - started,
        message: ok ? ('HTTP ' + res.statusCode)
          : ('HTTP ' + res.statusCode + ' ' + (res.statusMessage || '')
             + (data ? ' — ' + data.trim().replace(/\s+/g, ' ').slice(0, 300) : '')),
      });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, status: 0, message: 'The external system did not answer in time.' }); });
  req.on('error', e => cb({ ok: false, status: 0, message: 'Could not reach it — ' + e.message }));
  if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
  req.end();
}
// GET /api/apiconnectors -> which connectors hold a credential, and nothing else
app.get('/api/apiconnectors', checkApiKey, (req, res) => {
  const out = {};
  Object.keys(connections).forEach(k => {
    if (k.indexOf(API_CONN_PREFIX) !== 0) return;
    const s = connections[k].secrets || {};
    out[k.slice(API_CONN_PREFIX.length)] = {
      hasSecret: !!(s.secret && String(s.secret).length),
      hasShareToken: !!(s.shareToken && String(s.shareToken).length),
      updatedAt: connections[k].updatedAt || null,
    };
  });
  res.json({ connectors: out });
});
/* PUT /api/apiconnectors/:id  { secret, shareToken }
   '' leaves what is stored alone; null clears it; anything else replaces
   it. Nothing here is ever read back out. */
app.put('/api/apiconnectors/:id', checkApiKey, requireApiAdmin, (req, res) => {
  const id = String(req.params.id || '').slice(0, 80);
  if (!/^[A-Za-z0-9_\-:.]+$/.test(id)) return res.status(400).json({ error: 'bad connector id' });
  const key = API_CONN_PREFIX + id;
  const entry = connections[key] || { secrets: {} };
  entry.secrets = entry.secrets || {};
  ['secret', 'shareToken'].forEach(k => {
    const v = (req.body || {})[k];
    if (v === null) { delete entry.secrets[k]; return; }
    if (typeof v === 'string' && v.length) entry.secrets[k] = v;
  });
  /* The hosts the credential is for, set by the admin who saved it. A call
     that carries the credential anywhere else is refused, so the proxy is
     not a way to post somebody's API key to a server of one's own. */
  const hosts = [(req.body || {}).baseUrl, (req.body || {}).tokenUrl].map(hostOf).filter(Boolean);
  if (hosts.length) entry.hosts = Array.from(new Set(hosts));
  entry.updatedAt = new Date().toISOString();
  connections[key] = entry;
  writeConnections();
  const s = entry.secrets;
  res.json({ id, hasSecret: !!s.secret, hasShareToken: !!s.shareToken });
});
app.delete('/api/apiconnectors/:id', checkApiKey, requireApiAdmin, (req, res) => {
  const key = API_CONN_PREFIX + req.params.id;
  if (!connections[key]) return res.status(404).json({ error: 'nothing stored for that connector' });
  delete connections[key];
  writeConnections();
  res.json({ id: req.params.id, deleted: true });
});
/* POST /api/apiconnectors/:id/call  { url, method, headers, body, auth }
   auth says where the stored credential goes; the credential itself is
   never in the request and never in the reply. */
app.post('/api/apiconnectors/:id/call', checkApiKey, (req, res) => {
  const id = String(req.params.id || '');
  const b = req.body || {};
  const secret = (apiConnEntry(id).secrets || {}).secret || '';
  const auth = b.auth || {};
  const headers = {};
  Object.keys(b.headers || {}).forEach(k => { headers[k] = String((b.headers || {})[k]); });
  let url = String(b.url || '');
  if (auth.kind && auth.kind !== 'none') {
    if (!secret) return res.json({ ok: false, status: 0,
      message: 'No credential is stored for this connector. Paste it in Setup and save, then try again.' });
    const wrongHost = credentialHostProblem(id, url);
    if (wrongHost) return res.json({ ok: false, status: 0, message: wrongHost });
    if (auth.kind === 'bearer') headers['Authorization'] = 'Bearer ' + secret;
    else if (auth.kind === 'basic') headers['Authorization'] = 'Basic ' + Buffer.from(String(auth.username || '') + ':' + secret).toString('base64');
    else if (auth.kind === 'header') headers[String(auth.headerName || 'X-API-Key')] = String(auth.prefix || '') + secret;
    else if (auth.kind === 'query') {
      const sep = url.indexOf('?') >= 0 ? '&' : '?';
      url += sep + encodeURIComponent(String(auth.paramName || 'api_key')) + '=' + encodeURIComponent(secret);
    }
  }
  apiConnFetch({ url, method: b.method || 'GET', headers, body: b.body, timeout: b.timeout }, (r) => res.json(r));
});
/* POST /api/apiconnectors/:id/token  { url, clientId, scope }
   OAuth 2.0 client credentials: the one grant a server can complete on
   its own. The client secret is the stored credential, so it never
   leaves this process; what comes back is handed to the caller as a
   bearer token to use for the next call and nothing is kept. */
app.post('/api/apiconnectors/:id/token', checkApiKey, (req, res) => {
  const b = req.body || {};
  const secret = (apiConnEntry(String(req.params.id || '')).secrets || {}).secret || '';
  if (!secret) return res.json({ ok: false, message: 'No client secret is stored for this connector.' });
  const wrongHost = credentialHostProblem(String(req.params.id || ''), b.url);
  if (wrongHost) return res.json({ ok: false, message: wrongHost });
  const form = 'grant_type=client_credentials'
    + '&client_id=' + encodeURIComponent(String(b.clientId || ''))
    + '&client_secret=' + encodeURIComponent(secret)
    + (b.scope ? '&scope=' + encodeURIComponent(String(b.scope)) : '');
  apiConnFetch({
    url: String(b.url || ''), method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    body: form,
  }, (r) => {
    const tok = r.json && (r.json.access_token || r.json.accessToken);
    if (!r.ok || !tok) return res.json({ ok: false, message: r.message || 'No access_token came back.' });
    res.json({ ok: true, token: tok, expiresIn: r.json.expires_in || null });
  });
});
/* ---- the other direction: a door the external system knocks on ----
   GET  /api/share/:id?token=…  hands over the rows that connector shares.
   POST /api/share/:id?token=…  takes rows it pushes, into a queue BOSS
   drains. Both are authorised by that connector's own share token, held
   in connections.json and compared here; neither uses the CRM's API key,
   so giving a partner a token does not give them the CRM. */
function shareConnector(id) {
  let list = [];
  try { list = JSON.parse(store['apiConnectors'] || '[]'); } catch (e) { list = []; }
  return (Array.isArray(list) ? list : []).find(c => c && c.id === id) || null;
}
function shareAuthorised(req, id) {
  const want = (apiConnEntry(id).secrets || {}).shareToken || '';
  const got = String(req.query.token || req.get('X-Share-Token') || '');
  if (!want) return 'No share token is set for this connector.';
  if (!sameSecret(got, want)) return 'That token is not the one for this connector.';
  return '';
}
app.get('/api/share/:id', (req, res) => {
  const id = String(req.params.id || '');
  const conn = shareConnector(id);
  if (!conn) return res.status(404).json({ error: 'unknown connector' });
  if (conn.active === false) return res.status(403).json({ error: 'that connector is switched off' });
  if (conn.direction === 'in') return res.status(403).json({ error: 'that connector only imports; it shares nothing' });
  const why = shareAuthorised(req, id);
  if (why) return res.status(401).json({ error: why });
  const cap = Number(conn.shareLimit) || 1000;
  const read = (key) => {
    let rows = [];
    try { rows = JSON.parse(store[key] || '[]'); } catch (e) { rows = []; }
    return Array.isArray(rows) ? rows.filter(r => r && !r.deletedAt) : [];
  };
  /* A whole-system connector answers in BOSS's own export shape — the
     same { modules: { … } } the Export screen writes — so a mirror or a
     second BOSS needs no field map and no translation. */
  if (conn.module === '*') {
    const want = Array.isArray(conn.stores) && conn.stores.length ? conn.stores : [];
    if (!want.length) return res.status(409).json({
      error: 'that connector carries no module — open it in Setup and choose what it should share' });
    const modules = {};
    let count = 0;
    want.forEach(k => { modules[k] = read(k).slice(0, cap); count += modules[k].length; });
    return res.json({ source: 'BOSS', connector: conn.name || id, exportedAt: new Date().toISOString(),
      count, modules });
  }
  /* The connector names the store its module lives in; the browser
     writes it when the connector is saved, so this process needs no
     second copy of that map to fall out of step with. */
  if (!conn.store) return res.status(409).json({
    error: 'that connector does not say which store it reads — open it in Setup and save it again' });
  const maps = (conn.map || []).filter(m => m && m.boss && m.ext);
  const out = read(conn.store).slice(0, cap)
    .map(r => {
      const o = {};
      maps.forEach(m => { o[m.ext] = r[m.boss] === undefined ? null : r[m.boss]; });
      return o;
    });
  res.json({ connector: conn.name || id, module: conn.module || '', count: out.length, records: out });
});
app.post('/api/share/:id', (req, res) => {
  const id = String(req.params.id || '');
  const conn = shareConnector(id);
  if (!conn) return res.status(404).json({ error: 'unknown connector' });
  if (conn.active === false) return res.status(403).json({ error: 'that connector is switched off' });
  if (conn.direction === 'out') return res.status(403).json({ error: 'that connector only shares; it imports nothing' });
  const why = shareAuthorised(req, id);
  if (why) return res.status(401).json({ error: why });
  const body = req.body || {};
  /* A whole-system push is one object carrying every module, and goes
     into the queue as one item; anything else is a list of records. */
  const whole = conn.module === '*';
  const rows = whole ? [body]
    : (Array.isArray(body) ? body : (Array.isArray(body.records) ? body.records : [body]));
  if (whole && !(body.modules && typeof body.modules === 'object'))
    return res.status(400).json({ error: 'a whole-system connector expects {"modules":{"leads":[…]}} — the shape the Export screen writes' });
  if (!rows.length) return res.status(400).json({ error: 'no records in that body' });
  if (!whole && rows.length > 500) return res.status(413).json({ error: 'send at most 500 records at a time' });
  let inbox = [];
  try { inbox = JSON.parse(store['apiInbox'] || '[]'); } catch (e) { inbox = []; }
  if (!Array.isArray(inbox)) inbox = [];
  inbox.push({ id: 'IN-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    connectorId: id, at: new Date().toISOString(), rows, from: req.ip || '' });
  while (inbox.length > 200) inbox.shift();          // a queue, not an archive
  store['apiInbox'] = JSON.stringify(inbox);
  writeToDisk();
  publishChange(['apiInbox'], '');
  res.json({ ok: true, queued: whole
      ? Object.values(body.modules).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
      : rows.length,
    note: 'Queued. BOSS maps and applies these the moment a session picks the change up.' });
});

// DELETE /api/connections/:id — forgets the stored credential entirely, for
// when a connector is being retired or a key has to be revoked.
app.delete('/api/connections/:id', checkApiKey, requireApiAdmin, (req, res) => {
  const id = req.params.id;
  if (!connections[id]) return res.status(404).json({ error: 'nothing stored for ' + id });
  delete connections[id];
  writeConnections();
  res.json({ id, deleted: true, connection: publicConnection(id) });
});

// POST /api/connections/:id/test -> runs a real check and records what happened
app.post('/api/connections/:id/test', checkApiKey, requireApiAdmin, (req, res) => {
  const id = req.params.id;
  const kind = CONNECTOR_KIND[id];
  if (!kind) return res.status(404).json({ error: 'unknown connector: ' + id });
  const c = connections[id] || { config: {}, secrets: {} };
  const config = c.config || {}, secrets = c.secrets || {};

  const finish = (result) => {
    c.status = result.ok ? 'Connected' : 'Not Connected';
    c.lastTestAt = new Date().toISOString();
    c.lastTestOk = !!result.ok;
    c.lastTestMessage = result.message;
    connections[id] = c;
    writeConnections();
    res.json({ ok: !!result.ok, message: result.message, connection: publicConnection(id) });
  };

  // Microsoft Graph speaks OAuth rather than a bearer token you can paste, so
  // the test is the token exchange itself: if the tenant, the application and
  // the secret line up, a token comes back and the mailbox is reachable.
  if (kind === 'graph') {
    if (!config.tenantId || !config.clientId) return finish({ ok: false,
      message: 'Microsoft 365 needs a Directory (tenant) ID and an Application (client) ID. Both are on the app registration in Entra ID.' });
    if (!secrets.clientSecret) return finish({ ok: false,
      message: 'No client secret is stored. Paste the secret VALUE (not its ID) from Certificates & secrets, then save.' });
    return graphToken(config, secrets, (err, token) => {
      if (err) return finish({ ok: false, message: err });
      if (!config.userId) return finish({ ok: true,
        message: 'Microsoft 365 issued a token, so the tenant, application and secret are right. Add the mailbox (a user principal name, like you@firm.com) to create meeting links.' });
      httpsProbe({
        url: 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(config.userId),
        headers: { Authorization: 'Bearer ' + token },
      }, (r) => finish(r.ok
        ? { ok: true, message: 'Connected. Microsoft 365 issued a token and the mailbox ' + config.userId + ' was found.' }
        : { ok: false, message: 'A token was issued, but the mailbox could not be read — ' + r.message }));
    });
  }

  if (kind === 'smtp') {
    if (!config.host) return finish({ ok: false, message: 'No SMTP host is set. Fill the form in and save first.' });
    if (config.username && !secrets.password) return finish({ ok: false, message: 'A username is set but no password is stored. Enter the password and save first.' });
    return smtpTest({
      host: config.host,
      port: Number(config.port) || (config.secure ? 465 : 587),
      secure: !!config.secure,
      username: config.username || '',
      password: secrets.password || '',
    }, finish);
  }

  /* The firm's own model. The honest test is to ask it what it serves: a
     model list that answers proves the endpoint is up, reachable from this
     server, and speaking the protocol the assistant will use. */
  if (kind === 'selfhosted') {
    const base = String(config.baseUrl || '').replace(/\/+$/, '');
    if (!base) return finish({ ok: false, message: 'No endpoint is set. Put your model server\u2019s base URL here \u2014 the one ending /v1 on most of them.' });
    const headers = {};
    if (secrets.apiKey) headers.Authorization = 'Bearer ' + secrets.apiKey;
    return httpProbeJsonAny({ url: base + '/models', headers }, (r) => {
      if (!r.ok) return finish({ ok: false, message: r.message });
      const list = ((r.json && r.json.data) || []).map(m => m && m.id).filter(Boolean);
      if (config.model && list.length && list.indexOf(config.model) === -1)
        return finish({ ok: false, message: 'The server answered, but it does not serve \u201c' + config.model
          + '\u201d. It serves: ' + list.slice(0, 8).join(', ') + '.' });
      return finish({ ok: true, message: 'Connected. Your own model server answered'
        + (list.length ? ' and serves ' + list.length + ' model(s)' : '')
        + '. Nothing from BOSS leaves your infrastructure through this connector.' });
    });
  }

  if (kind === 'inbound') {
    if (!secrets.apiKey) return finish({ ok: false,
      message: 'No key has been issued yet. Save one here, then paste it — with this BOSS address — into the editor extension.' });
    if (!config.lastSeenAt) return finish({ ok: false,
      message: 'The key is stored, but no editor has called in with it yet. Until one does this stays Not Connected.' });
    return finish({ ok: true,
      message: 'Connected. The last call in was at ' + config.lastSeenAt + (config.lastSeenAgent ? ' from ' + config.lastSeenAgent : '') + '.' });
  }

  const probe = buildHttpsProbe(config, secrets);
  if (probe.error) return finish({ ok: false, message: probe.error });
  httpsProbe(probe, finish);
});


/* ---------------------------------------------------------------------
   THE AI SERVICE LAYER

   One endpoint, one place credentials live, one place the privacy rules
   are enforced. No module calls a provider itself and no key ever reaches
   a browser: the page sends what it wants said, the server decides whether
   it may be said at all and, if so, says it.

   What this will not do:
     - talk to a connector that is not enabled, not connected, or whose
       privacy terms nobody has verified;
     - write a prompt, a completion or anything out of a record to disk.
       The access log keeps who asked, through which connector, how long
       the exchange was and whether it worked. It does not keep what was
       in it, because an application log is the easiest place in a system
       for client data to end up by accident;
     - act on anything. It returns text. Every change to a BOSS record is
       made by BOSS, by a user who pressed something.
   --------------------------------------------------------------------- */
const AI_MAX_CHARS = 120000;      // a request larger than this is a mistake, not a prompt
const AI_TIMEOUT_MS = 60000;
let aiCallSeq = 0;
/* Zero-retention / no-training controls, where the provider publishes one.
   Sent on every call so the posture does not depend on somebody having
   ticked a box in a console. */
function aiPrivacyHeaders(id) {
  if (id === 'claude') return { 'anthropic-version': '2023-06-01' };
  return {};
}
function aiProviderCall({ id, kind, config, secrets, system, messages, maxTokens, temperature }, cb) {
  const cap = Math.min(Number(maxTokens) || 1500, 4000);
  const temp = temperature === undefined ? 0.2 : Math.max(0, Math.min(1, Number(temperature) || 0));
  if (id === 'claude') {
    const model = config.model;
    if (!model) return cb({ ok: false, message: 'No model is set on the Claude connector. Put the model identifier from your account’s documentation in its Model field.' });
    return httpsProbeJson({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: Object.assign({ 'x-api-key': secrets.apiKey || '', 'Content-Type': 'application/json' }, aiPrivacyHeaders(id)),
      body: JSON.stringify({ model, max_tokens: cap, temperature: temp,
        system: system || undefined, messages }),
    }, (r) => {
      if (!r.ok) return cb({ ok: false, message: r.message });
      const parts = (r.json && r.json.content) || [];
      const text = parts.filter(p => p && p.type === 'text').map(p => p.text).join('').trim();
      cb(text ? { ok: true, text } : { ok: false, message: 'The provider answered, but with nothing in it.' });
    });
  }
  if (id === 'gemini') {
    const model = config.model;
    if (!model) return cb({ ok: false, message: 'No model is set on the Gemini connector. Put the model identifier from Google’s documentation in its Model field.' });
    const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }] }));
    return httpsProbeJson({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model)
         + ':generateContent?key=' + encodeURIComponent(secrets.apiKey || ''),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ contents,
        generationConfig: { maxOutputTokens: cap, temperature: temp } },
        system ? { systemInstruction: { parts: [{ text: system }] } } : {})),
    }, (r) => {
      if (!r.ok) return cb({ ok: false, message: r.message });
      const cands = (r.json && r.json.candidates) || [];
      const text = ((cands[0] || {}).content || {}).parts
        ? cands[0].content.parts.map(p => p.text || '').join('').trim() : '';
      cb(text ? { ok: true, text } : { ok: false, message: 'The provider answered, but with nothing in it.' });
    });
  }
  // The firm's own model, behind an OpenAI-compatible endpoint. Ollama, vLLM,
  // LM Studio and every enterprise gateway worth the name speak this, so one
  // adapter covers them all and the firm is not locked to a vendor.
  if (kind === 'selfhosted') {
    const base = String(config.baseUrl || '').replace(/\/+$/, '');
    if (!base) return cb({ ok: false, message: 'No endpoint is set. Put your model server’s base URL in the connector.' });
    const model = config.model;
    if (!model) return cb({ ok: false, message: 'No model is set on the connector.' });
    const msgs = (system ? [{ role: 'system', content: system }] : []).concat(messages);
    const headers = { 'Content-Type': 'application/json' };
    if (secrets.apiKey) headers.Authorization = 'Bearer ' + secrets.apiKey;
    return httpProbeJsonAny({
      url: base + '/chat/completions', method: 'POST', headers,
      body: JSON.stringify({ model, messages: msgs, max_tokens: cap, temperature: temp, stream: false }),
    }, (r) => {
      if (!r.ok) return cb({ ok: false, message: r.message });
      const ch = ((r.json && r.json.choices) || [])[0] || {};
      const text = String((ch.message && ch.message.content) || ch.text || '').trim();
      cb(text ? { ok: true, text } : { ok: false, message: 'The model answered, but with nothing in it.' });
    });
  }
  cb({ ok: false, message: 'That connector is not a model BOSS can talk to.' });
}
/* A model the firm runs is often on its own network over plain http, which is
   fine — the traffic never leaves their infrastructure — so this one allows
   it where the outward-facing probe does not. Everything else is identical. */
function httpProbeJsonAny(opts, cb) {
  cb = callOnce(cb);
  let target;
  try { target = new URL(opts.url); } catch (e) { return cb({ ok: false, message: 'That is not a valid URL.' }); }
  const lib = target.protocol === 'http:' ? http : https;
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    return cb({ ok: false, message: 'Use an http:// or https:// endpoint.' });
  const req = lib.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'http:' ? 80 : 443),
    path: target.pathname + target.search,
    method: opts.method || 'GET',
    headers: Object.assign({ 'User-Agent': 'Finowise-BOSS/1.0', 'Accept': 'application/json' }, opts.headers || {}),
    timeout: AI_TIMEOUT_MS,
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { if (data.length < 400000) data += d; });
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(data); } catch (e) { /* reported below */ }
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      cb({ ok, json, message: ok ? 'ok'
        : 'The model server answered ' + res.statusCode + ' ' + (res.statusMessage || '')
          + (data ? ' — ' + data.trim().replace(/\s+/g, ' ').slice(0, 220) : '') });
    });
  });
  req.on('timeout', () => { req.destroy(); cb({ ok: false, message: 'The model server did not answer within 60 seconds.' }); });
  req.on('error', (e) => cb({ ok: false, message: 'Could not reach the model server — ' + e.message }));
  if (opts.body) req.write(opts.body);
  req.end();
}

// POST /api/ai/chat  { connector, system?, messages:[{role,content}], maxTokens?, temperature? }
// Returns { ok, text } or { ok:false, message, reason }. Signed-in users only.
app.post('/api/ai/chat', checkApiKey, (req, res) => {
  const t0 = Date.now();
  const seq = ++aiCallSeq;
  const body = req.body || {};
  const id = String(body.connector || '').toLowerCase();
  const deny = (code, message, extra) => {
    console.log('[ai] #' + seq + ' ' + (id || '?') + ' refused: ' + code);
    res.status(code === 'not_configured' ? 409 : 403)
       .json(Object.assign({ ok: false, reason: code, message }, extra || {}));
  };
  if (AI_CONNECTORS.indexOf(id) === -1)
    return deny('unknown', 'That is not a connector the assistant can speak through.');
  const c = connections[id];
  if (!c) return deny('not_configured', 'That connector has not been set up yet.');
  if (!c.enabled) return deny('disabled', 'That connector is switched off. Tick “Enable this channel” on it.');
  if (c.status !== 'Connected')
    return deny('not_connected', 'That connector is not connected. Test it in Setup → Connections first.');
  /* The gate. A public API with unverified terms gets nothing, however good
     its key is — which is the whole point of the requirement. */
  const p = aiPrivacyState(id);
  if (!p.ok) return deny('privacy', p.why, { privacy: p });

  const messages = Array.isArray(body.messages) ? body.messages
    .filter(m => m && typeof m.content === 'string' && m.content.length)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }))
    : [];
  if (!messages.length) return res.status(400).json({ ok: false, message: 'There is nothing to ask.' });
  const size = messages.reduce((n, m) => n + m.content.length, 0) + String(body.system || '').length;
  if (size > AI_MAX_CHARS)
    return res.status(413).json({ ok: false, reason: 'too_big',
      message: 'That is ' + Math.round(size / 1000) + 'KB of context. Narrow the request — a filter, a shorter period, fewer records — so only what the task needs is sent.' });

  aiProviderCall({ id, kind: CONNECTOR_KIND[id], config: c.config || {}, secrets: c.secrets || {},
    system: body.system ? String(body.system) : '', messages,
    maxTokens: body.maxTokens, temperature: body.temperature }, (r) => {
    /* What goes in the log: who, through what, how big, how long, and whether
       it worked. Not the prompt, not the answer, not a record id. */
    console.log('[ai] #' + seq + ' ' + id + ' ' + (r.ok ? 'ok' : 'failed')
      + ' in=' + size + 'ch out=' + (r.ok ? String(r.text).length : 0) + 'ch '
      + (Date.now() - t0) + 'ms');
    if (!r.ok) return res.status(502).json({ ok: false, reason: 'provider', message: r.message });
    res.json({ ok: true, text: r.text, connector: id, reach: p.reach, via: p.by || p.reach });
  });
});
// GET /api/ai/status -> which connectors the assistant may actually use, and why not where it may not.
app.get('/api/ai/status', checkApiKey, (req, res) => {
  res.json({ connectors: AI_CONNECTORS.map(id => {
    const c = connections[id] || {};
    const p = aiPrivacyState(id);
    return { id, enabled: !!c.enabled, status: connectorStatusOf(id), reach: p.reach,
             usable: !!c.enabled && c.status === 'Connected' && p.ok, privacy: p };
  }) });
});

/* The editors' way in. Not behind the CRM's API key: an extension running on
   somebody's laptop holds the connector's own key and nothing else, which is
   exactly the credential being checked here. A wrong key is a 401 and is not
   recorded; a right one marks the connector Connected and stamps when. */
app.post('/api/ai/hello', (req, res) => {
  const body = req.body || {};
  const id = String(body.connector || '').toLowerCase();
  if (INBOUND_CONNECTORS.indexOf(id) === -1) return res.status(404).json({ ok: false, error: 'unknown editor connector' });
  const c = connections[id];
  const stored = c && c.secrets && c.secrets.apiKey;
  if (!stored) return res.status(409).json({ ok: false, error: 'no key has been issued for this connector yet' });
  const given = String(body.key || '');
  if (given.length !== String(stored).length
      || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(String(stored)))) {
    return res.status(401).json({ ok: false, error: 'that key does not match the one stored' });
  }
  c.config = c.config || {};
  c.config.lastSeenAt = new Date().toISOString();
  c.config.lastSeenAgent = String(body.agent || '').slice(0, 120);
  c.status = 'Connected';
  c.lastTestAt = c.config.lastSeenAt;
  c.lastTestOk = true;
  c.lastTestMessage = 'The editor called in' + (c.config.lastSeenAgent ? ' from ' + c.config.lastSeenAgent : '') + '.';
  connections[id] = c;
  writeConnections();
  res.json({ ok: true, connector: id, at: c.config.lastSeenAt });
});

/* GET /api/events — the stream. Signed in, like the rest of the CRM; the
   browser cannot put a header on an EventSource, so the session cookie is
   what authenticates it, and the payload carries no record data either way. */
app.get('/api/events', (req, res) => {
  if (!isSignedIn(req) && API_KEY && req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'sign in first' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // nginx must not buffer a stream
  });
  res.write('retry: 3000\n\n');
  liveStreams.add(res);
  // What the version is right now, so a browser that reconnects can tell
  // whether it missed anything while it was away.
  liveSend(res, 'hello', { v: storeVersion, at: new Date().toISOString() });
  const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch (e) {} }, 25000);
  const stop = () => { clearInterval(beat); liveStreams.delete(res); };
  req.on('close', stop);
  req.on('error', stop);
});

/* GET /api/changes?since=N - what this browser has missed.
   The stream's safety net: the same information, pulled rather than
   pushed, so a tab that was asleep, behind a buffering proxy or off the
   network catches up by asking instead of by being reloaded by hand.
   `gap` says the log no longer reaches back that far, so the browser
   should re-read everything rather than trust a partial list. */
app.get('/api/changes', (req, res) => {
  if (!isSignedIn(req) && API_KEY && req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'sign in first' });
  }
  const since = Number(req.query.since || 0) || 0;
  const oldestHeld = changeLog.length ? changeLog[0].v : storeVersion + 1;
  res.set('Cache-Control', 'no-store').json({
    version: storeVersion,
    gap: since > 0 && since < oldestHeld - 1,
    changes: changeLog.filter((c) => c.v > since),
  });
});

/* The build being served, so a browser can say which one it has. Taken
   from the file itself rather than from git: the deploy script lives on
   the server and this has to be true whatever put the file there. */
function currentBuild() {
  try {
    const st = fs.statSync(path.join(__dirname, 'public', 'index.html'));
    return String(Math.round(st.mtimeMs)).slice(-9) + '-' + st.size;
  } catch (e) { return 'unknown'; }
}
const buildStamp = currentBuild();
app.get('/api/health', (req, res) => res.set('Cache-Control', 'no-store').json({
  ok: true, keys: Object.keys(store).length, version: storeVersion,
  build: currentBuild(), startedBuild: buildStamp,
}));

// Hands the browser the shared API key from the environment, so the secret
// stays out of git. Not itself a secret channel — the whole site sits behind
// nginx basic auth in production; see README.md on what this key does and doesn't do.
function requireAdmin(req, res, next) {
  const user = signedInUser(req);
  if (user && user.role === 'admin') return next();
  res.status(403).type('html').send(
    '<p style="font-family:system-ui;padding:24px">Only an admin can manage users. '
    + '<a href="/">Back to the CRM</a></p>');
}

app.get('/users', requireAdmin, (req, res) => {
  res.type('html').set('Cache-Control', 'no-store')
     .send(usersPage({ meId: (signedInUser(req) || {}).id }));
});

// Deleting an account is the other half of adding one. The person's records in
// the CRM are left exactly as they are — this only takes away the way in, and
// their session stops working at their next request.
app.post('/users/delete', requireAdmin, (req, res) => {
  const me = signedInUser(req) || {};
  const id = Number((req.body || {}).id);
  res.set('Cache-Control', 'no-store');
  const user = id ? findUserById.get(id) : null;
  if (!user) return res.status(404).type('html').send(usersPage({ error: 'No such account.', meId: me.id }));
  if (user.id === me.id) {
    return res.status(409).type('html')
      .send(usersPage({ error: 'That is the account you are signed in with.', meId: me.id }));
  }
  // Never leave the system with nobody who can manage accounts.
  if (user.role === 'admin' && listUsers.all().filter((u) => u.role === 'admin' && u.active !== 0).length <= 1) {
    return res.status(409).type('html')
      .send(usersPage({ error: 'That is the only admin account — make somebody else an admin first.', meId: me.id }));
  }
  deleteUserById.run(user.id);
  res.type('html').send(usersPage({ removed: user.email, meId: me.id }));
});

/* Accounts are made in one place: Team Members, which creates the person
   and the account they sign in with in the same breath. This page used to
   be a second way, and a second way is how a person and their account
   drift apart — an account with no team member behind it has no role, no
   branch, no reporting line and no access, and nothing in the CRM to
   attach them to. The form is gone and so is the route behind it, because
   a route left answering is a form somebody can still post to.

   A system with nobody in it is the one case this cannot cover, and that
   has the command line: npm run user -- add <email> <password>. */
app.post('/users', requireAdmin, (req, res) => {
  res.status(410).set('Cache-Control', 'no-store').type('html').send(usersPage({
    error: 'Accounts are made in BOSS \u203a Team Members now, which creates the person and their sign-in '
         + 'together. Nothing was added.',
    meId: (signedInUser(req) || {}).id,
  }));
});

// ------------------------------------------------- accounts, from the CRM --
// The Team Members module owns these. It creates a member, and the account
// that member signs in with is created here in the same breath — same email,
// same role, and a generated password the CRM mails to them. Nothing is typed
// in twice, and the two cannot drift apart.
function requireApiAdmin(req, res, next) {
  const user = signedInUser(req);
  if (user && user.role === 'admin') return next();
  res.status(403).json({ ok: false, message: 'Only an admin can manage sign-in accounts.' });
}

// Every account, for the CRM's Team Members screens.
app.get('/api/users', checkApiKey, requireApiAdmin, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ok: true, users: listUsers.all().map(accountJson) });
});

// Create or update the account a team member signs in with. Called whenever a
// member is saved, so it has to be safe to call again with nothing changed.
/* An admin manages every account. A partner on L5 or above (buildTeam)
   manages the accounts of their own team, and only as ordinary users. */
function requireAccountManager(req, res, next) {
  const user = signedInUser(req);
  if (user && user.role === 'admin') return next();
  const p = access.principal(user);
  const memberId = String((req.body || {}).memberId || '').trim();
  const row = storeList('team').find((t) => t && t.id === memberId);
  if (p && p.kind === 'partner' && !p.unrestricted && p.level && PartnerLevelsLib.has(p.level, 'buildTeam')
      && row && row.partnerTeamOf === p.member.id) { req.teamOnly = true; return next(); }
  res.status(403).json({ ok: false, message: 'Only an admin can manage sign-in accounts.' });
}
const PartnerLevelsLib = require('./public/partner-levels.js');
/* A partner below L7, or a partner's staff, is never a company admin,
   whatever their CRM flags say: L6's administrative controls are the ones
   assigned to it, not company-wide access. */
function partnerMayBeAdmin(memberId) {
  const m = storeList('team').find((t) => t && t.id === memberId);
  if (!m) return true;
  if (m.partnerTeamOf) return false;
  if (!m.partnerPobId) return true;
  const lv = PartnerLevelsLib.level((storeValue('config', {}) || {}).partnerLevels, m.partnerLevel || 'L1');
  return !!(lv && PartnerLevelsLib.has(lv, 'superAdmin'));
}
app.post('/api/users/sync', checkApiKey, requireAccountManager, (req, res) => {
  const body = req.body || {};
  const memberId = String(body.memberId || '').trim();
  const email = String(body.email || '').trim();
  const crmRole = String(body.crmRole || '').trim();
  const role = body.admin && !req.teamOnly && partnerMayBeAdmin(memberId) ? 'admin' : 'user';
  const active = body.active === false ? 0 : 1;
  res.set('Cache-Control', 'no-store');
  if (!memberId) return res.status(400).json({ ok: false, message: 'Which team member is this for?' });
  if (!ADDRESS_RE.test(email)) return res.status(400).json({ ok: false, message: '"' + email + '" is not a usable email address.' });

  const byMember = findUserByMember.get(memberId);
  let byEmail = findUserByEmail.get(email);
  // An account on this address linked to a team member who is gone (deleted,
  // or added again under a new record) belongs to nobody: it is this member's.
  if (byEmail && byEmail.member_id && byEmail.member_id !== memberId && !accountOwnerLive(byEmail)) {
    byEmail = Object.assign({}, byEmail, { member_id: null });
  }
  if (byEmail && byMember && byEmail.id !== byMember.id) {
    return res.status(409).json({ ok: false, message: email + ' already signs in as somebody else.' });
  }
  // An account that exists for this member, or one already on this address that
  // nobody owns yet — adopt it rather than refusing, so a CRM installed after
  // the accounts were made lines up with them.
  const existing = byMember || (byEmail && !byEmail.member_id ? byEmail : null);
  if (existing) {
    // The last active admin cannot be demoted or deactivated: nobody would
    // be left who can manage accounts. /users/delete has the same rule.
    if (existing.role === 'admin' && (role !== 'admin' || !active)
        && listUsers.all().filter((u) => u.role === 'admin' && u.active !== 0).length <= 1) {
      return res.status(409).json({ ok: false, message: 'This is the only admin account. Make somebody else an admin first.' });
    }
    updateUserAccount.run(email, role, memberId, crmRole, active, existing.id);
    const after = findUserById.get(existing.id);
    return res.json({ ok: true, created: false, adopted: !byMember, account: accountJson(after) });
  }
  if (byEmail) return res.status(409).json({ ok: false, message: email + ' already signs in as ' + accountOwnerName(byEmail) + '.' });

  const password = String(body.password || '') || generatePassword();
  if (password.length < 8) return res.status(400).json({ ok: false, message: 'A password needs at least 8 characters.' });
  insertMemberUser.run(email, hashPassword(password), role, memberId, crmRole, active);
  const made = findUserByEmail.get(email);
  res.json({ ok: true, created: true, password, account: accountJson(made) });
});

/* The team member an account is linked to, if they are still on the team.
   A member deleted, or added again under a new record, leaves their account
   linked to an id nobody has any more. */
function accountOwner(u) {
  if (!u || !u.member_id) return null;
  return storeList('team').find((t) => t && t.id === u.member_id) || null;
}
function accountOwnerLive(u) {
  const t = accountOwner(u);
  return !!(t && !t.deletedAt);
}
function accountOwnerName(u) {
  const t = accountOwner(u);
  return t && !t.deletedAt ? (t.name || 'another team member') : 'another team member';
}

/* WHAT A PASSWORD HAS TO BE. The same rules are shown on the page as the
   person types; this is where they are enforced. */
function passwordProblems(pw, email) {
  const out = [];
  pw = String(pw || '');
  if (pw.length < 8) out.push('at least 8 characters');
  if (pw.length > 128) out.push('no more than 128 characters');
  if (!/[a-z]/.test(pw)) out.push('a lowercase letter');
  if (!/[A-Z]/.test(pw)) out.push('an uppercase letter');
  if (!/[0-9]/.test(pw)) out.push('a number');
  if (!/[^A-Za-z0-9]/.test(pw)) out.push('a symbol');
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) out.push('not your email name');
  return out;
}
/* A signed-in person sets or changes their own password. The current one
   is asked for every time, so a session left open is not a way to take the
   account over. Only the hash is kept. */
app.post('/api/account/password', checkApiKey, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const user = signedInUser(req);
  if (!user) return res.status(401).json({ ok: false, message: 'Sign in first.' });
  const key = 'pw:' + user.id;
  if (tooManyAttempts(key)) return res.status(429).json({ ok: false, message: 'Too many attempts. Wait a few minutes and try again.' });
  const body = req.body || {};
  const current = String(body.current || ''), next = String(body.password || ''), confirm = String(body.confirm || '');
  if (!passwordMatches(current, user.password_hash)) {
    noteFailure(key);
    return res.status(400).json({ ok: false, field: 'current', message: 'Your current password is not right.' });
  }
  if (next !== confirm) return res.status(400).json({ ok: false, field: 'confirm', message: 'The two new passwords are not the same.' });
  const wrong = passwordProblems(next, user.email);
  if (wrong.length) return res.status(400).json({ ok: false, field: 'password', message: 'The new password needs ' + wrong.join(', ') + '.' });
  if (passwordMatches(next, user.password_hash)) return res.status(400).json({ ok: false, field: 'password', message: 'Choose a password different from the current one.' });
  attempts.delete(key);
  setOwnPassword.run(hashPassword(next), user.id);
  renewSessionCookie(req, res, user.id);
  res.json({ ok: true, account: accountJson(findUserById.get(user.id)) });
});

// A fresh password for a member who never got theirs, or lost it.
app.post('/api/users/:memberId/password', checkApiKey, requireApiAdmin, (req, res) => {
  const memberId = String(req.params.memberId || '');
  let user = findUserByMember.get(memberId);
  res.set('Cache-Control', 'no-store');
  /* No account linked to this member, but one on their email: it was made
     for them under a record that is gone, so it is relinked to them and the
     password issued. One linked to somebody still on the team is theirs,
     and is left alone. */
  const email = String((req.body || {}).email || '').trim();
  if (!user && ADDRESS_RE.test(email)) {
    const byEmail = findUserByEmail.get(email);
    if (byEmail && byEmail.member_id && accountOwnerLive(byEmail)) {
      return res.status(409).json({ ok: false, message: email + ' signs in as ' + accountOwnerName(byEmail)
        + ', another team member with the same email. Give one of them a different official email first.' });
    }
    if (byEmail) {
      updateUserAccount.run(byEmail.email, byEmail.role, memberId, byEmail.crm_role || '', byEmail.active, byEmail.id);
      user = findUserById.get(byEmail.id);
    }
  }
  if (!user) return res.status(404).json({ ok: false, message: 'That team member has no sign-in account yet.' });
  const password = generatePassword();
  setIssuedPassword.run(hashPassword(password), user.id);
  res.json({ ok: true, password, account: accountJson(findUserById.get(user.id)) });
});

// Removing a team member removes the account with them.
app.delete('/api/users/:memberId', checkApiKey, requireApiAdmin, (req, res) => {
  const user = findUserByMember.get(String(req.params.memberId || ''));
  res.set('Cache-Control', 'no-store');
  if (!user) return res.json({ ok: true, removed: false });
  const signedIn = signedInUser(req);
  if (signedIn && signedIn.id === user.id) {
    return res.status(409).json({ ok: false, message: 'That is the account you are signed in with.' });
  }
  deleteUserById.run(user.id);
  res.json({ ok: true, removed: true, email: user.email });
});

// ------------------------------------------------- the client's own pages --
// A lead filling in a BIS, a client signing off an allocation, somebody asking
// a question on their support link: none of them have an account here, and it
// would be absurd to ask them to sign in to answer their own adviser.
//
// So those pages are open — but only as far as their token reaches. The token
// names one record; this works out what that record is, hands the page a copy
// of just that much of the store, and accepts back only writes that stay
// inside it. The CRM's own key is never given out, and nothing here can read
// another client's anything.
function storeList(key) {
  const raw = store[key];
  if (raw === undefined) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function storeValue(key, fallback) {
  const raw = store[key];
  if (raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}
/* Everything a client's own link writes goes through here, so this is where
   their submissions join the stream. The origin says it came from a client
   link rather than from a CRM tab, which is exactly the case no open browser
   should ignore. */
function putList(key, list) { store[key] = JSON.stringify(stampRows(storeList(key), list)); storeRevision++; publishChange([key], 'client-link'); }

/* ---------------------------------------------------------------------
   FIELD VALIDATION, on the side that cannot be bypassed.

   The page checks a mobile, an email and a PAN as they are typed, which
   is where it helps the person filling the form. This is the other half:
   what a client's own link posts back arrives from outside, over a token
   anyone holding the link has, so it is checked again here before it
   reaches a record.

   The patterns and the wording are the same settings the page reads, so
   a firm that relaxes a rule relaxes it in both places at once; the
   defaults below are only what applies before anybody has set one.
   --------------------------------------------------------------------- */
const VALIDATION_DEFAULTS = {
  mobile: { pattern: '^[0-9]{10}$', message: 'Please enter a valid 10-digit mobile number.' },
  email:  { pattern: '^[^@\\s]+@[^@\\s.]+(\\.[^@\\s.]+)+$', message: 'Please enter a valid email address.' },
  pan:    { pattern: '^[A-Z]{5}[0-9]{4}[A-Z]$', message: 'Please enter a valid PAN number in the format ABCDE1234F.', upper: true },
};
function validationSetting(kind, what) {
  const settings = storeValue('settings', {}) || {};
  const key = 'validation.' + kind + (what === 'pattern' ? 'Pattern' : 'Message');
  const row = settings[key];
  const v = row && row.value;
  return (typeof v === 'string' && v.trim()) ? v : VALIDATION_DEFAULTS[kind][what];
}
/* The same tidying the page does: a space, the country code or a leading
   0 around ten digits is still that mobile number. */
function tidyMobile(v) {
  const s = String(v).trim();
  if (!/^[+0-9 ()\-.]+$/.test(s)) return s;
  const d = s.replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  return d.length === 10 ? d : s;
}
/* { ok, value, message }. A blank passes — whether an answer is required
   is the form's question, not this one's. An unreadable pattern turns the
   check off rather than locking everybody out of their own forms. */
function checkValue(kind, raw) {
  const spec = VALIDATION_DEFAULTS[kind];
  if (!spec) return { ok: true, value: raw };
  let value = raw === null || raw === undefined ? '' : String(raw);
  if (spec.upper) value = value.toUpperCase();
  if (!value.trim()) return { ok: true, value };
  if (kind === 'mobile') value = tidyMobile(value);
  let re;
  try { re = new RegExp(validationSetting(kind, 'pattern')); } catch (e) { return { ok: true, value }; }
  return re.test(value) ? { ok: true, value }
                        : { ok: false, value, message: validationSetting(kind, 'message') };
}
/* Which rule a key is under, by what it is called — the same reading the
   page does, so neither side can decide a field is exempt. */
function validationKindOfKey(key) {
  const k = String(key || '').toLowerCase();
  if (/(^|[^a-z])pan([^a-z]|$)/.test(k) || k.endsWith('pan')) return 'pan';
  if (/mobile|phone/.test(k)) return 'mobile';
  if (/email/.test(k)) return 'email';
  return '';
}
/* Walk anything a client posted and report what breaks a rule. Values are
   corrected in place where correcting is right (a PAN in lower case is
   the same PAN); anything else is reported and nothing is stored. */
function validateSubmitted(value, path, out) {
  out = out || [];
  path = path || '';
  if (Array.isArray(value)) {
    value.forEach((v, i) => validateSubmitted(v, path + '[' + i + ']', out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach((k) => {
      const kind = validationKindOfKey(k);
      const v = value[k];
      if (kind && (typeof v === 'string' || typeof v === 'number')) {
        const got = checkValue(kind, v);
        if (got.ok) { if (got.value !== v) value[k] = got.value; }
        else out.push({ field: path ? path + '.' + k : k, message: got.message });
        return;
      }
      validateSubmitted(v, path ? path + '.' + k : k, out);
    });
  }
  return out;
}

/* The blueprint input sheets. Mirrors APPROACH_FORMS in the page — kept here
   because what a client sends back on one of these must land on the record
   whatever the browser manages to do about it. */
const PLAN_FORM_TYPES = ['GAB', 'MULTIGOAL', 'INSPIRING', 'DURATION', 'INCOME', 'SINGLEGOAL'];

/* The record a plan belongs to, wherever it is now: the lead it was built for,
   or the client that lead became. */
function planOwnerFor(leadId) {
  if (!leadId) return null;
  const leads = storeList('leads');
  const lead = leads.find((l) => l && l.id === leadId);
  if (lead) return { record: lead, key: 'leads', list: leads };
  const clients = storeList('clients');
  const client = clients.find((c) => c && (c.id === leadId || c.convertedFromLeadId === leadId));
  return client ? { record: client, key: 'clients', list: clients } : null;
}

/* An ISEQ coming back is the other half of the same problem, and it is the
   half that bit. The input sheet has had this since Mod 14: the server writes
   what came back onto the record, so the answers never depend on the page's
   own patch getting through. The ISEQ had nothing of the kind — the page set
   the score on the lead and PUT the whole list, and a tab holding that lead
   from before the client answered could PUT it back without one. The
   submission survives, the score card survives, and the stage goes on reading
   "Awaiting the ISEQ score" with the answer sitting one table away.

   So the score is applied here too, on the server, from the row that arrived.
   A score already on the record is left alone: a later ISEQ replaces an
   earlier one only because it is the later submission, which is the row the
   page sends. */
function applyIseqSubmissionToOwner(link, sub) {
  if (!link || !sub) return false;
  if (!/^ISEQ/.test(String(sub.type || ''))) return false;
  if (sub.score === undefined || sub.score === null) return false;
  const owner = link.recordModule === 'CMS' && link.recordId
    ? (() => { const list = storeList('clients');
               const rec = list.find((c) => c && c.id === link.recordId);
               return rec ? { record: rec, key: 'clients', list } : null; })()
    : planOwnerFor(link.leadId || sub.leadId);
  if (!owner) return false;
  const rec = owner.record;
  const when = sub.submittedAt || new Date().toISOString();
  // Only a newer answer moves it, so re-posting an old row cannot walk the
  // profile backwards.
  if (rec.iseqAnsweredAt && String(rec.iseqAnsweredAt) > String(when)) return false;
  rec.iseqScore = sub.score;
  rec.iseqMaxScore = sub.maxScore;
  rec.iseqCategory = sub.category;
  rec.iseqFormType = sub.type;
  rec.iseqProfileDate = String(when).slice(0, 10);
  rec.iseqAnsweredAt = when;
  putList(owner.key, owner.list);
  return true;
}
/* AN FQ RESULT IS WRITTEN ONTO THE LEAD HERE, as the ISEQ is: the page used
   to be the only writer, and a stale save from any tab could then wipe it —
   the adviser saw "Sent — not back yet" over a result that had come in.
   Only a newer answer moves it, so nothing newer is ever walked back. */
function applyFqSubmissionToLead(link, sub) {
  if (!sub || !/^FQ/.test(String(sub.type || ''))) return false;
  if (sub.score === undefined || sub.score === null) return false;
  const leadId = (link && link.leadId) || sub.leadId;
  if (!leadId) return false;
  const list = storeList('leads');
  const lead = list.find((l) => l && l.id === leadId);
  if (!lead) return false;
  const when = sub.submittedAt || new Date().toISOString();
  if (lead.fqAnsweredAt && String(lead.fqAnsweredAt) >= String(when) && lead.fqScore !== undefined && lead.fqScore !== null) return false;
  lead.fqScore = sub.score;
  if (sub.maxScore !== undefined) lead.fqMaxScore = sub.maxScore;
  if (sub.category) lead.fqCategory = sub.category;
  lead.fqPercent = Number(sub.maxScore) > 0 ? Math.round(Number(sub.score) / Number(sub.maxScore) * 100) : (lead.fqPercent || 0);
  if (sub.sections) lead.fqSections = sub.sections;
  lead.fqFormType = sub.type;
  lead.fqTestDate = String(when).slice(0, 10);
  lead.fqAnsweredAt = when;
  if (link && link.token && !lead.fqDocToken) { lead.fqDocToken = link.token; lead.fqSentAt = lead.fqSentAt || link.createdAt || when; }
  putList('leads', list);
  return true;
}
/* Once, at start: an FQ result, or the "sent" mark of an FQ link, that a
   stale save took off a lead is put back from what is on file — the
   submission and the link themselves were never touched. Blanks and older
   answers only. */
function repairFqOnLeads() {
  try {
    const links = storeList('docLinks');
    let fixed = 0;
    storeList('docSubmissions').filter((s) => s && /^FQ/.test(String(s.type || '')) && s.score !== undefined && s.score !== null)
      .sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')))
      .forEach((s) => { const link = links.find((l) => l && l.token === s.token); if (applyFqSubmissionToLead(link || { leadId: s.leadId }, s)) fixed++; });
    const list = storeList('leads');
    let sent = 0;
    links.filter((l) => l && l.leadId && /^FQ/.test(String(l.type || '')))
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      .forEach((l) => {
        const lead = list.find((x) => x && x.id === l.leadId);
        if (!lead || lead.fqDocToken) return;
        lead.fqDocToken = l.token; lead.fqSentAt = l.createdAt || ''; sent++;
      });
    if (sent) putList('leads', list);
    if (fixed || sent) { writeToDisk(); console.log('FQ repair: ' + fixed + ' result(s) and ' + sent + ' sent mark(s) put back on leads'); }
  } catch (e) { console.error('FQ repair failed', e); }
}

/* An input sheet coming back IS the answer of record, so the server writes it
   onto the lead or client itself rather than trusting the page to. The page
   still does its own half — the stage it moves, the notification it raises —
   but the answers no longer depend on that patch getting through. Only blanks
   are filled, so an adviser's later correction is never overwritten. */
function applyPlanSubmissionToOwner(link, sub) {
  if (!link || !sub || PLAN_FORM_TYPES.indexOf(link.type) < 0) return false;
  const answers = sub.answers && typeof sub.answers === 'object' ? sub.answers : null;
  if (!answers) return false;
  const owner = planOwnerFor(link.leadId);
  if (!owner) return false;
  const rec = owner.record;
  const blank = (v) => v === undefined || v === null || v === ''
    || (Array.isArray(v) && !v.length);
  rec.formData = rec.formData && typeof rec.formData === 'object' ? rec.formData : {};
  const held = Object.assign({}, rec.formData[link.type]);
  let filled = 0;
  Object.keys(answers).forEach((k) => {
    if (blank(answers[k])) return;
    if (!blank(held[k])) return;
    held[k] = answers[k];
    filled++;
  });
  rec.formData[link.type] = held;
  rec.planFormReturnedAt = sub.submittedAt || new Date().toISOString();
  // …and the round the answers were for is told it has them, which is what the
  // Prepare Plan step actually waits on. A sheet can come back before any round
  // exists — the adviser sent it straight from the Plan tab — so one is opened
  // here rather than letting the answers arrive with nowhere to belong.
  const rounds = Array.isArray(rec.planRounds) ? rec.planRounds : [];
  let round = rounds.length ? rounds[rounds.length - 1] : null;
  if (!round || round.clientDecision) {
    round = { n: rounds.length + 1, type: link.type, createdAt: new Date().toISOString() };
    rounds.push(round);
    rec.planRounds = rounds;
  }
  if (!round.type) round.type = link.type;
  if (!round.inputSubmittedAt) {
    round.inputSubmittedAt = rec.planFormReturnedAt;
    round.inputSubmittedBy = sub.submittedBy || 'Client';
  }
  putList(owner.key, owner.list);
  return filled > 0 || !!round;
}

// What a token is allowed to see and touch. Returns null when it means nothing.
function publicScope(token) {
  if (!token || typeof token !== 'string') return null;
  const links = storeList('docLinks');
  const clients = storeList('clients');
  const leads = storeList('leads');
  const reviews = storeList('reviews');
  const recs = storeList('recommendations');
  const team = storeList('team');

  const link = links.find((l) => l && l.token === token);
  if (link) {
    const lead = link.leadId ? leads.find((l) => l.id === link.leadId) : null;
    // A lead that converted while its link was out with the client is no longer
    // in LMS. The link still names it, so the client it became is found here —
    // otherwise their page would load empty and every write from it be refused.
    const converted = !lead && link.leadId
      ? clients.find((c) => c && (c.id === link.leadId || c.convertedFromLeadId === link.leadId))
      : null;
    const client = link.recordModule === 'CMS' ? clients.find((c) => c.id === link.recordId)
      : converted
      || (lead && lead.convertedToClientId ? clients.find((c) => c.id === lead.convertedToClientId) : null);
    const review = reviews.find((r) => r && (r.ctFormToken === token || (link.recordModule === 'RMS' && r.id === link.recordId))) || null;
    const rec = link.allocationId ? recs.find((r) => r.id === link.allocationId) : null;
    const reviewClient = review ? clients.find((c) => c.id === review.clientId) : null;
    const owner = (lead && lead.assignedTo) || (client && client.rmName) || (review && review.assignTo) || '';
    return {
      kind: 'doc', token, link,
      ids: new Set([link.token, lead && lead.id, client && client.id, review && review.id, rec && rec.id,
                    reviewClient && reviewClient.id].filter(Boolean)),
      records: { lead, client: client || reviewClient, review, rec },
      owner: team.find((t) => t.id === owner) || null,
    };
  }
  const client = clients.find((c) => c && c.supportToken === token);
  if (client) {
    // Their own tickets are theirs to add to — writing back on one they raised
    // last week is the ordinary case, not an escape from the link.
    const mine = storeList('queries').filter((q) => q && q.clientId === client.id).map((q) => q.id);
    return {
      kind: 'support', token, link: null,
      ids: new Set([client.id].concat(mine)),
      records: { client },
      owner: team.find((t) => t.id === client.rmName) || null,
    };
  }
  return null;
}
// The addresses a page may write to: the person it belongs to, their adviser,
// and the firm itself. Not the world.
function publicMailTargets(scope) {
  const out = [];
  const r = scope.records || {};
  [r.lead, r.client, r.review].forEach((rec) => { if (rec && rec.email) out.push(rec.email); });
  if (scope.owner && scope.owner.email) out.push(scope.owner.email);
  const conn = connections.email || {};
  const from = (conn.config || {}).fromEmail || (conn.config || {}).username || '';
  if (from) out.push(from);
  const company = (storeValue('config', {}) || {}).company || {};
  if (company.email) out.push(company.email);
  return out;
}
// The slice of the store a public page is given. Lists the page needs whole
// (its own form templates, the firm's branding) come whole; lists about people
// are cut down to the one record the token names.
// The 7 Events sheet keeps the planner's own half on the record: the goal
// planning, the asset mapping and the execution plan, with the notes they
// wrote on each. The client's page needs the input form and nothing else, so
// the rest never leaves the building.
const SEVEN_EVENTS_INTERNAL = ['gp', 'map', 'mapMeta', 'exec', 'eaa'];
function scrubForClient(record) {
  const se = record && record.formData && record.formData.SEVENEVENTS;
  if (!se || typeof se !== 'object') return record;
  const copy = Object.assign({}, record);
  copy.formData = Object.assign({}, record.formData);
  const kept = {};
  Object.keys(se).forEach((k) => { if (!SEVEN_EVENTS_INTERNAL.includes(k)) kept[k] = se[k]; });
  copy.formData.SEVENEVENTS = kept;
  return copy;
}

// A public page holds part of a record, so what comes back is merged, not
// substituted — and `formData` is merged a level deeper, because each form's
// answers live under their own key and a page that only saw one of them must
// not be able to wipe the others. The planner's half of a 7 Events sheet is
// never sent out, so it is put back from what is on file.
function mergeFromClient(stored, incoming) {
  const out = Object.assign({}, stored, incoming, { id: stored.id });
  if (incoming && (incoming.formData || stored.formData)) {
    out.formData = Object.assign({}, stored.formData || {}, incoming.formData || {});
    const se = out.formData.SEVENEVENTS, old = (stored.formData || {}).SEVENEVENTS;
    if (se && typeof se === 'object' && old && typeof old === 'object') {
      const kept = Object.assign({}, se);
      SEVEN_EVENTS_INTERNAL.forEach((k) => { if (old[k] !== undefined) kept[k] = old[k]; });
      out.formData.SEVENEVENTS = kept;
    }
  }
  return out;
}

function publicBundle(scope) {
  const only = (key, keep) => storeList(key).filter(keep);
  const r = scope.records || {};
  const ids = scope.ids;
  const mine = (x) => x && ids.has(x.id);
  const bundle = {
    docLinks: scope.link ? [scope.link] : [],
    docSubmissions: only('docSubmissions', (x) => x && x.token === scope.token),
    leads: [r.lead].filter(Boolean).map(scrubForClient),
    clients: [r.client].filter(Boolean).map(scrubForClient),
    reviews: [r.review].filter(Boolean),
    recommendations: [r.rec].filter(Boolean),
    // The adviser's name and address appear on what the client is sent; nothing
    // else about the team goes out.
    team: (scope.owner ? [scope.owner] : []).map((t) => ({ id: t.id, name: t.name, email: t.email, role: t.role })),
    config: storeValue('config', null),
    settings: storeValue('settings', {}),
    schemes: storeList('schemes'),
    amcs: storeList('amcs'),
    // The service tasks that belong to this record. A form coming back closes
    // the task that was chasing it, so the page has to see them — but only
    // their bones: what a colleague wrote on one is not the client's business.
    tasks: only('tasks', (x) => x && !x.deletedAt && (ids.has(x.leadId) || ids.has(x.clientId)))
      .map((t) => ({ id: t.id, taskType: t.taskType, leadId: t.leadId, clientId: t.clientId,
                     overallStatus: t.overallStatus, dueDate: t.dueDate })),
    transactions: [],
    // The business entry this lead's plan has already raised, so approving a
    // plan updates that row instead of writing a second one.
    businessEntries: only('businessEntries', (x) => x && !x.deletedAt && ids.has(x.leadId)),
    communications: [], auditLog: [], notifications: [],
    queries: [], queryReplies: [],
  };
  if (scope.kind === 'support' && r.client) {
    bundle.queries = only('queries', (x) => x && x.clientId === r.client.id && !x.deletedAt);
    const qids = new Set(bundle.queries.map((q) => q.id));
    // Internal notes are the team's, and stay the team's.
    bundle.queryReplies = only('queryReplies', (x) => x && qids.has(x.queryId) && !x.internal && !x.deletedAt);
  }
  void mine;
  return bundle;
}
// Rows a public page may add to, and records it may change. Anything else is
// refused by name rather than ignored, so a mistake here is loud.
const PUBLIC_APPEND_KEYS = ['docSubmissions', 'tasks', 'communications', 'auditLog', 'notifications',
  'queries', 'queryReplies', 'leads', 'transactions',
  // A client approving their plan raises the business entry from it.
  'businessEntries',
  /* …and the allocation the plan decided, which the Asset Allocation module
     is supposed to hold for every plan. It was being refused here and the
     refusal was swallowed by the page, so a plan approved on the client's
     own link left no allocation row behind — only one approved inside the
     CRM did. The row names the lead it belongs to, so it comes back into
     this link's reach for the updates that follow. */
  'recommendations'];
const PUBLIC_UPDATE_KEYS = ['docLinks', 'leads', 'clients', 'reviews', 'recommendations', 'queries',
  'tasks', 'transactions', 'businessEntries'];
// A row is this token's business if it IS one of its records, or if it hangs
// off one — the task chasing this form, the transaction from this allocation.
/* The fields that decide what a record is linked to and who owns it. A
   client's link may fill in their answers, but these only change inside the
   CRM: otherwise one link could point its own lead at somebody else's client
   record and read or rewrite it from then on. An unchanged value passes, so a
   page that sends its whole copy back is not refused. */
const PUBLIC_LOCKED_FIELDS = ['id', '_mt', 'token', 'supportToken', 'ctFormToken',
  'leadId', 'clientId', 'recordId', 'recordModule', 'reviewId', 'allocationId', 'queryId', 'refId',
  'convertedToClientId', 'convertedFromLeadId', 'userId', 'memberId',
  'assignedTo', 'assignTo', 'rmName', 'parentUserId', 'createdBy', 'ownerId', 'approverId',
  'deletedAt', 'deletedBy'];
function withoutLockedChanges(stored, incoming) {
  if (!incoming || typeof incoming !== 'object') return incoming;
  const out = Object.assign({}, incoming);
  PUBLIC_LOCKED_FIELDS.forEach((f) => {
    if (f in out && JSON.stringify(out[f]) !== JSON.stringify(stored[f])) delete out[f];
  });
  return out;
}
// The fields a new row from a public page may use to hang off a record.
const PUBLIC_LINK_FIELDS = ['leadId', 'clientId', 'recordId', 'reviewId', 'allocationId', 'queryId', 'refId',
  'convertedToClientId', 'convertedFromLeadId'];
/* A new row from a client's link is theirs only if everything it hangs off is
   this link's (or another row added in the same submission). A submission
   names the link it came back on; a notification goes to the adviser who owns
   the record, and nobody else. */
function appendProblem(key, row, scope, fresh) {
  const ok = (v) => scope.ids.has(v) || fresh.has(v);
  for (const f of PUBLIC_LINK_FIELDS) {
    if (row[f] && !ok(row[f])) return f;
  }
  if (key === 'docSubmissions' && row.token && row.token !== scope.token) {
    const link = storeList('docLinks').find((l) => l && l.token === row.token);
    if (!link || !(ok(link.leadId) || ok(link.recordId) || ok(link.allocationId))) return 'token';
  }
  if (key === 'notifications' && row.userId && !(scope.owner && scope.owner.id === row.userId)) return 'userId';
  return '';
}
function rowInScope(row, scope) {
  if (!row) return false;
  if (scope.ids.has(row.id)) return true;
  return ['leadId', 'clientId', 'recordId', 'reviewId', 'allocationId', 'queryId', 'refId']
    .some((k) => row[k] && scope.ids.has(row[k]));
}

// Serving the page IS the client opening the form, so that is where it is
// recorded — a link has no id of its own for the page to patch back, and this
// is the one place that always knows the form was actually looked at.
function noteLinkOpened(scope) {
  const link = scope && scope.link;
  if (!link || link.openedAt) return;
  const links = storeList('docLinks');
  const row = links.find((l) => l && l.token === link.token);
  if (!row || row.openedAt) return;
  row.openedAt = new Date().toISOString();
  row.history = (row.history || []).concat([{ at: row.openedAt, what: 'Opened by the client' }]);
  putList('docLinks', links);
  writeToDisk();
}

app.get('/api/public/bundle', (req, res) => {
  const scope = publicScope(String(req.query.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  noteLinkOpened(scope);
  // Whether a mail this page sends can actually go. The page cannot read the
  // connector itself — it only needs to know whether to promise anything.
  const conn = connections.email || {};
  const mail = {
    // The firm's own address is on the certificate this page may issue, so the
    // page is told it. It is the address mail already arrives from.
    from: ((conn.config || {}).fromEmail || (conn.config || {}).username || ''),
    ready: !!(conn.enabled && conn.status === 'Connected' && ((conn.config || {}).fromEmail || (conn.config || {}).username)),
    message: !conn.config || !(conn.config || {}).host ? 'No email connector is set up yet.'
      : !conn.enabled ? 'The email connector is switched off.'
      : conn.status !== 'Connected' ? 'The email connector has not passed a connection test.' : '',
  };
  res.json({ ok: true, kind: scope.kind, store: publicBundle(scope), mail });
});

// What the page did: rows added, and records changed. Every id is checked
// against the token's own scope before anything is written.
/* Who owns the record a client link belongs to, and a line in their bell
   when the client sends something back. Written here, on the server, so one
   submission makes one notification however many CRM tabs happen to be
   open — and so it exists at all when none is. */
function ownerOfLinkRecord(link) {
  if (!link) return null;
  if (link.leadId) {
    const lead = storeList('leads').find((l) => l && l.id === link.leadId);
    return lead ? { userId: lead.assignedTo, name: ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim(), view: 'lms', arg: lead.id } : null;
  }
  if (link.recordModule === 'CMS' && link.recordId) {
    const c = storeList('clients').find((x) => x && x.id === link.recordId);
    return c ? { userId: c.rmName, name: c.cmsName || '', view: 'cms', arg: c.id } : null;
  }
  if (link.recordModule === 'RMS' && link.recordId) {
    const r = storeList('reviews').find((x) => x && x.id === link.recordId);
    const c = r ? storeList('clients').find((x) => x && x.id === r.clientId) : null;
    return r ? { userId: (c && c.rmName) || r.assignedTo, name: (c && c.cmsName) || '', view: 'rms', arg: r.id } : null;
  }
  return null;
}
function notifyOwnerOfSubmission(link, row) {
  const owner = ownerOfLinkRecord(link);
  if (!owner || !owner.userId) return;
  // The link carries the form's own name; a link minted before it did falls
  // back to its type, tidied rather than printed raw.
  const what = (link.formName || String(link.type || 'form').replace(/_/g, ' ')).toString()
    .replace(/Goal Based Planning/g, 'Goal Based Investment'); // renamed; older links carry the old name
  const list = storeList('notifications');
  list.push({
    id: 'NTF-' + Math.random().toString(36).slice(2, 7).toUpperCase() + Date.now().toString().slice(-4),
    at: new Date().toISOString(), userId: owner.userId,
    title: what + ' submitted' + (owner.name ? ' by ' + owner.name : ''),
    body: 'It came back at ' + new Date().toLocaleString('en-IN') + ' and is on the record now.',
    view: owner.view, arg: owner.arg, kind: 'submission', by: 'Client',
  });
  putList('notifications', list);
}
app.post('/api/public/patch', (req, res) => {
  const scope = publicScope(String(req.query.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  const body = req.body || {};
  const appends = body.appends || {}, updates = body.updates || {};
  const refused = [];

  /* What a client's own link posts arrives from outside. The page checks
     a mobile, an email and a PAN as they are typed; this is the check
     that cannot be skipped by posting straight at the endpoint. Nothing
     is stored unless it passes, so a refused submission leaves the record
     exactly as it was.

     Only what the client is actually entering is checked — the rows they
     are adding, which is where their answers arrive. An update carries a
     whole record forward, including fields filled in long before these
     rules existed; refusing those would mean a lead with one bad PAN on
     file could never be written to again, which is not a validation rule
     but a lockout. Those fields reach the record through the answers
     above, and the answers are checked. */
  const wrong = validateSubmitted(appends);
  if (wrong.length) {
    return res.status(400).json({ ok: false, invalid: wrong,
      message: wrong.length === 1 ? wrong[0].message
        : 'Some of what was sent is not valid: ' + wrong.map((w) => w.message).join(' ') });
  }

  // Rows this submission creates, which its other rows may hang off.
  const fresh = new Set();
  for (const [key, rows] of Object.entries(appends)) {
    if (!PUBLIC_APPEND_KEYS.includes(key) || !Array.isArray(rows)) continue;
    const have = new Set(storeList(key).map((x) => x && x.id));
    rows.forEach((row) => { if (row && row.id && !have.has(row.id)) fresh.add(row.id); });
  }
  for (const [key, rows] of Object.entries(appends)) {
    if (!PUBLIC_APPEND_KEYS.includes(key)) { refused.push('add to ' + key); continue; }
    if (!Array.isArray(rows) || !rows.length) continue;
    const bad = rows.map((row) => row && typeof row === 'object' ? appendProblem(key, row, scope, fresh) : '')
      .filter(Boolean);
    if (bad.length) { refused.push('add to ' + key + ' (' + bad[0] + ')'); appends[key] = []; continue; }
    const list = storeList(key);
    const have = new Set(list.map((x) => x && x.id));
    rows.forEach((row) => {
      if (!row || typeof row !== 'object' || !row.id || have.has(row.id)) return;
      list.push(row);
      have.add(row.id);
      // A row this page just created belongs to it, so it may amend it again.
      scope.ids.add(row.id);
    });
    putList(key, list);
    // A form coming back is the link's own history — recorded here because the
    // page cannot patch a link row (it has a token, not an id).
    if (key === 'docSubmissions') {
      const links = storeList('docLinks');
      let touched = false;
      rows.forEach((row) => {
        if (!row || !row.token) return;
        const link = links.find((l) => l && l.token === row.token);
        if (!link) return;
        const again = !!link.submittedAt;
        // An FQ link goes out before the client has said which age bracket
        // they are in, so what came back names the assessment they actually
        // answered. The link becomes that one — otherwise its own module
        // would file it under the bracket it happened to boot on.
        if (link.fqPick && row.type && row.type !== link.type) link.type = row.type;
        link.status = 'Submitted';
        link.submittedAt = row.submittedAt || new Date().toISOString();
        link.submittedBy = row.submittedBy || 'Client';
        link.history = (link.history || []).concat([{ at: link.submittedAt,
          what: again ? 'Re-submitted' : 'Submitted', note: row.submittedVia || '' }]);
        touched = true;
      });
      if (touched) putList('docLinks', links);
      // An input sheet is the one submission that has to change the record it
      // came from, so it is applied here rather than left to the page.
      rows.forEach((row) => {
        if (!row || !row.token) return;
        const link = links.find((l) => l && l.token === row.token);
        if (link) applyPlanSubmissionToOwner(link, row);
        // …and an ISEQ, whichever link it came back on. A submission whose
        // link has gone still names its lead, so it is applied from the row.
        if (link) applyIseqSubmissionToOwner(link, row);
        else if (row.leadId && scope.ids.has(row.leadId)) applyIseqSubmissionToOwner({ leadId: row.leadId }, row);
        applyFqSubmissionToLead(link || { leadId: row.leadId }, row);
      });
      // …and whoever owns that record is told, so a submission that lands
      // while nobody is looking at the right screen is still waiting for
      // them when they come back to it.
      rows.forEach((row) => {
        if (!row || !row.token) return;
        const link = links.find((l) => l && l.token === row.token);
        if (link) notifyOwnerOfSubmission(link, row);
      });
    }
  }
  for (const [key, byId] of Object.entries(updates)) {
    if (!PUBLIC_UPDATE_KEYS.includes(key)) { refused.push('change ' + key); continue; }
    const list = storeList(key);
    let touched = false;
    for (const [id, row] of Object.entries(byId || {})) {
      const idx = list.findIndex((x) => x && x.id === id);
      if (idx < 0) { refused.push(key + '/' + id); continue; }
      if (!scope.ids.has(id) && !rowInScope(list[idx], scope)) { refused.push(key + '/' + id); continue; }
      // Merge rather than replace: the page only ever held part of the store,
      // and must not be able to blank a field it never saw. A page sends only
      // the fields it changed (__set / __unset); an older page sent its whole
      // copy, which is still merged as it always was.
      if (row && row.__set && typeof row.__set === 'object') {
        const set = withoutLockedChanges(list[idx], row.__set); delete set.id; delete set._mt;
        const next = mergeFromClient(list[idx], set);
        (Array.isArray(row.__unset) ? row.__unset : []).forEach((f) => {
          if (f !== 'formData' && !PUBLIC_LOCKED_FIELDS.includes(f)) delete next[f]; });
        list[idx] = next;
      } else list[idx] = mergeFromClient(list[idx], withoutLockedChanges(list[idx], row));
      touched = true;
    }
    if (touched) putList(key, list);
  }
  writeToDisk();
  if (refused.length) return res.status(403).json({ ok: false, message: 'Outside this link: ' + refused.join(', ') });
  res.json({ ok: true });
});

/* =====================================================================
   THE APPROVAL TRAIL

   Every approval in the CRM — the reporting manager signing a plan off,
   and the client saying yes to it — is written here rather than only onto
   the record it decided. The browser cannot be trusted with the address it
   came from, so the address, the time and (for a signed-in approver) the
   account are stamped by the server; everything else is what the approver
   actually said.

   Two ways in, because there are two kinds of approver: one for somebody
   signed into the CRM, one for the client on their own document link. Both
   append to the same list, so the trail reads as one.
   ===================================================================== */
function callerIp(req) {
  const raw = (req.ip || (req.connection && req.connection.remoteAddress) || '').toString();
  // ::ffff:203.0.113.9 is an IPv4 address wearing an IPv6 coat. Written plainly.
  return raw.replace(/^::ffff:/, '') || 'unknown';
}
function recordApproval(req, fields) {
  const list = storeList('approvals');
  const row = Object.assign({}, fields, {
    id: fields.id || ('APR-' + Math.random().toString(36).slice(2, 10).toUpperCase()),
    at: new Date().toISOString(),
    ip: callerIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  });
  list.push(row);
  putList('approvals', list);
  writeToDisk();
  return row;
}
// An approval given by somebody signed into the CRM: a reporting manager, an
// admin. The account is taken from the session, not from the body.
app.post('/api/approvals', checkApiKey, (req, res) => {
  const b = req.body || {};
  const user = signedInUser(req);
  res.set('Cache-Control', 'no-store');
  if (!b.decision) return res.status(400).json({ ok: false, message: 'decision is required' });
  const row = recordApproval(req, {
    module: String(b.module || 'LMS'),
    recordId: String(b.recordId || ''),
    leadId: b.leadId || null,
    clientId: b.clientId || null,
    subject: String(b.subject || ''),
    kind: String(b.kind || 'Plan'),
    planRound: b.planRound === undefined ? null : b.planRound,
    planType: String(b.planType || ''),
    planVersionLabel: String(b.planVersionLabel || ''),
    ref: String(b.ref || ''),
    approverType: 'Internal',
    approverName: String(b.approverName || (user && user.email) || ''),
    approverId: String(b.approverId || ''),
    account: (user && user.email) || '',
    decision: String(b.decision),
    remarks: String(b.remarks || ''),
    via: 'CRM',
  });
  res.json({ ok: true, approval: row });
});
// An approval given by the person the document was sent to. The link is the
// authority: whatever it is scoped to is what the approval may name.
app.post('/api/public/approval', (req, res) => {
  const token = String(req.query.token || '');
  const scope = publicScope(token);
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  const b = req.body || {};
  if (!b.decision) return res.status(400).json({ ok: false, message: 'decision is required' });
  const links = storeList('docLinks');
  const link = links.find((l) => l && l.token === token) || {};
  const row = recordApproval(req, {
    module: link.recordModule || 'LMS',
    recordId: link.leadId || link.recordId || '',
    leadId: link.leadId || null,
    clientId: link.recordModule === 'CMS' ? link.recordId : null,
    subject: String(b.subject || ''),
    kind: String(b.kind || 'Plan'),
    planRound: link.planRound === undefined ? (b.planRound === undefined ? null : b.planRound) : link.planRound,
    planType: String(b.planType || link.type || ''),
    planVersionLabel: String(b.planVersionLabel || ''),
    // What exactly was approved, when a record can hold more than one thing
    // that gets approved: an asset allocation carries its own reference.
    ref: String(b.ref || link.allocationId || ''),
    approverType: 'External',
    approverName: String(b.approverName || ''),
    approverId: '',
    account: '',
    decision: String(b.decision),
    remarks: String(b.remarks || ''),
    via: 'Client link',
    token,
  });
  res.json({ ok: true, approval: row });
});

// The mails a client's own page sends: their score card, their copy of a form,
// the note that tells their adviser they have answered.
/* A client's link may send the handful of letters its own flow sends (a
   copy of what they submitted, the adviser told). It is not a mail server:
   a link that keeps sending is told to wait. */
const publicMailHits = new Map();
function publicMailThrottled(token) {
  const now = Date.now();
  const hits = (publicMailHits.get(token) || []).filter((t) => now - t < 60 * 60 * 1000);
  hits.push(now);
  publicMailHits.set(token, hits);
  if (publicMailHits.size > 5000) publicMailHits.clear();
  return hits.length > 20;
}
app.post('/api/public/mail', (req, res) => {
  const scope = publicScope(String(req.query.token || ''));
  res.set('Cache-Control', 'no-store');
  if (!scope) return res.status(404).json({ ok: false, message: 'This link is not valid any more.' });
  if (publicMailThrottled(scope.token)) return res.status(429).json({ ok: false, message: 'Too many letters from this link. Try again in an hour.' });
  sendMailRequest(req.body || {}, res, publicMailTargets(scope));
});

/* =====================================================================
   WEBSITE FQ LEADS — the public "Know Your FQ Score" test on the
   Finowise website.

   The client takes the test on the website and is asked, after seeing
   their score, whether they want to talk to the team. Only on "Yes"
   does the website post here. One lead per client: the mobile number is
   the key, so a client who takes the test twice updates the lead they
   already have instead of making a second one.

   Where it lands:
     branch  the client's city, matched (ignoring case) against the
             branches in Settings › Branches, or against an explicit
             city → branch table in config.websiteLeadCityBranches
             ({"Navi Mumbai":"Mumbai", ...}). A city that matches neither
             goes to config.websiteLeadDefaultBranch, or no branch.
     RM      an active team member in that branch whose role or
             designation reads as a Relationship Manager; of those, the
             one holding the fewest open leads. No RM in the branch → the
             lead is left unassigned and shows in the branch's
             "unowned leads" count.

   The browser posting here is a stranger, so: the origin is checked
   against WEBSITE_LEAD_ORIGINS (comma-separated; unset = any origin),
   every field is trimmed and bounded, and one address may post only a
   handful of times a minute.
   ===================================================================== */
const WEBSITE_LEAD_ORIGINS = String(process.env.WEBSITE_LEAD_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const websiteLeadHits = new Map();
function websiteLeadCors(req, res) {
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  const allowed = !WEBSITE_LEAD_ORIGINS.length || (origin && WEBSITE_LEAD_ORIGINS.includes(origin));
  if (origin && allowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
  }
  return allowed;
}
function websiteLeadThrottled(req) {
  const ip = callerIp(req), now = Date.now();
  const hits = (websiteLeadHits.get(ip) || []).filter((t) => now - t < 60 * 1000);
  hits.push(now);
  websiteLeadHits.set(ip, hits);
  if (websiteLeadHits.size > 5000) websiteLeadHits.clear();
  return hits.length > 6;
}
function wlText(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 120); }
function websiteLeadBranch(city) {
  const cfg = storeValue('config', {}) || {};
  const c = wlText(city).toLowerCase();
  const branches = Array.isArray(cfg.branches) ? cfg.branches : [];
  if (c) {
    const map = cfg.websiteLeadCityBranches && typeof cfg.websiteLeadCityBranches === 'object' ? cfg.websiteLeadCityBranches : {};
    const mapped = Object.keys(map).find((k) => k.trim().toLowerCase() === c);
    if (mapped && map[mapped]) return String(map[mapped]);
    const same = branches.find((b) => String(b).trim().toLowerCase() === c);
    if (same) return same;
  }
  return cfg.websiteLeadDefaultBranch ? String(cfg.websiteLeadDefaultBranch) : '';
}
const WEBSITE_RM_RE = /relationship|\brm\b|wealth manager|advis[eo]r/i;
function websiteLeadRm(branch, leads) {
  if (!branch) return '';
  const b = branch.toLowerCase();
  const rms = storeList('team').filter((t) => t && t.id && !t.deletedAt
    && !/inactive|left|disabled|deactivated/i.test(String(t.status || 'Active'))
    && String(t.branch || '').trim().toLowerCase() === b
    && WEBSITE_RM_RE.test(String(t.role || '') + ' ' + String(t.designation || '')));
  if (!rms.length) return '';
  const open = (id) => leads.filter((l) => l && l.assignedTo === id && !l.deletedAt && !l.convertedToClientId).length;
  rms.sort((x, y) => open(x.id) - open(y.id) || String(x.id).localeCompare(String(y.id)));
  return rms[0].id;
}
function websiteLeadId() {
  return 'LMS-' + Math.random().toString(36).slice(2, 7).toUpperCase() + Date.now().toString().slice(-4);
}

app.options('/api/public/website-lead', (req, res) => {
  if (!websiteLeadCors(req, res)) return res.status(403).end();
  res.status(204).end();
});
app.post('/api/public/website-lead', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!websiteLeadCors(req, res)) return res.status(403).json({ ok: false, message: 'This website is not allowed to send leads.' });
  if (websiteLeadThrottled(req)) return res.status(429).json({ ok: false, message: 'Too many requests. Please try again in a minute.' });
  const b = req.body || {};
  if (b.consent !== true) return res.status(400).json({ ok: false, message: 'Consent to connect is required.' });

  const name = wlText(b.name, 80);
  const digits = String(b.mobile || '').replace(/\D/g, '');
  const mobile = digits.slice(-10);
  const email = wlText(b.email, 120);
  const city = wlText(b.city, 60);
  const referralName = wlText(b.referralName, 80);
  const occupation = wlText(b.occupation, 60);
  const wrong = [];
  if (name.length < 2) wrong.push('Please enter your full name.');
  if (!/^[6-9]\d{9}$/.test(mobile)) wrong.push('Please enter a valid 10-digit mobile number.');
  if (email && !ADDRESS_RE.test(email)) wrong.push('Please enter a valid email.');
  if (!city) wrong.push('Please enter your city.');

  const fq = b.fq && typeof b.fq === 'object' ? b.fq : {};
  const score = Number(fq.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) wrong.push('The FQ score is missing.');
  const answers = (Array.isArray(fq.answers) ? fq.answers : []).slice(0, 50).map((a, i) => ({
    no: i + 1,
    pillar: wlText(a && a.pillar, 40),
    question: wlText(a && a.question, 300),
    answer: wlText(a && a.answer, 300),
    option: wlText(a && a.option, 2),
    points: Number.isFinite(Number(a && a.points)) ? Number(a.points) : null,
  }));
  if (!answers.length) wrong.push('The FQ answers are missing.');
  /* Up to three times the client would like to be called, as the LMS's own
     FQ page takes them: "YYYY-MM-DDTHH:MM" in India time. None is fine —
     they would rather the RM offered one. */
  const rawSlots = Array.isArray(b.slots) ? b.slots : [];
  const slots = [];
  rawSlots.slice(0, 10).forEach((v) => {
    const t = String(v || '').trim();
    if (t && !slots.includes(t)) slots.push(t);
  });
  if (slots.length > 3) wrong.push('Please give at most 3 times.');
  if (slots.some((t) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) || isNaN(new Date(t + ':00+05:30'))))
    wrong.push('One of the times is not a complete date and time.');
  else if (slots.some((t) => new Date(t + ':00+05:30').getTime() <= Date.now()))
    wrong.push('One of the times has already passed. Please pick times still to come.');
  if (wrong.length) return res.status(400).json({ ok: false, message: wrong.join(' ') });
  const slotText = (t) => new Date(t + ':00+05:30').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata',
    weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const timesLine = slots.length ? 'Times they offered: ' + slots.map(slotText).join(' · ')
    : 'They gave no times — they would like you to offer one.';

  // The website asks the BOSS assessment itself (one bank per age group), so
  // the result is stored in the same fields an FQ link fills: points of the
  // maximum, the percentage the client was shown, the category and the
  // index-wise breakdown.
  const FQ_STAGE_KEYS = ['FQ_YOUNG', 'FQ_YOUNGMARRIED', 'FQ_MARRIEDCHILD', 'FQ_GOLDEN'];
  const stageKey = FQ_STAGE_KEYS.includes(String(fq.stage || '')) ? String(fq.stage) : '';
  const points = Number(fq.points), maxPoints = Number(fq.max);
  const hasPoints = Number.isFinite(points) && Number.isFinite(maxPoints) && maxPoints > 0 && points >= 0 && points <= maxPoints;
  const sections = (Array.isArray(fq.sections) ? fq.sections : []).slice(0, 10)
    .map((x) => ({ name: wlText(x && x.name, 40), score: Number(x && x.score), max: Number(x && x.max) }))
    .filter((x) => x.name && Number.isFinite(x.score) && Number.isFinite(x.max) && x.max > 0);
  const pillars = {};
  Object.entries(fq.pillars && typeof fq.pillars === 'object' ? fq.pillars : {}).slice(0, 10)
    .forEach(([k, v]) => { if (Number.isFinite(Number(v))) pillars[wlText(k, 40)] = Number(v); });
  const now = new Date().toISOString();
  const completed = new Date(fq.completedAt);
  const fqTest = {
    score, band: wlText(fq.band, 40), pillars, answers,
    stage: stageKey, stageLabel: wlText(fq.stageLabel, 40),
    points: hasPoints ? points : null, maxPoints: hasPoints ? maxPoints : null, sections,
    completedAt: isNaN(completed) ? now : completed.toISOString(),
    receivedAt: now, consentToConnect: true, consentAt: now,
    referralName, occupation, city,
  };
  const when = new Date(fqTest.completedAt).toLocaleString('en-IN', { timeZone: BUSINESS_TZ });
  const summary = 'Website FQ Test — score ' + score + '/100' + (hasPoints ? ' · ' + points + ' of ' + maxPoints + ' points' : '')
    + (fqTest.band ? ' (' + fqTest.band + ')' : '') + (fqTest.stageLabel ? ' · ' + fqTest.stageLabel : '')
    + ', completed ' + when + '.\nReferral: ' + (referralName || '—') + ' · Occupation: ' + (occupation || '—')
    + ' · City: ' + city + '\nClient consented to connect with the team. ' + timesLine + '\n'
    + answers.map((a) => a.no + '. [' + a.pillar + '] ' + a.question + ' → ' + (a.option ? a.option + ') ' : '') + a.answer).join('\n');

  const fqFields = {
    fqScore: hasPoints ? points : score,
    fqMaxScore: hasPoints ? maxPoints : 100,
    fqPercent: score,
    fqCategory: fqTest.band,
    fqBand: fqTest.band,
    fqTestDate: fqTest.completedAt.slice(0, 10),
    fqAnsweredAt: fqTest.completedAt,
  };
  if (sections.length) fqFields.fqSections = sections;
  if (stageKey) fqFields.fqFormType = stageKey;
  const leads = storeList('leads');
  const existing = leads.find((l) => l && !l.deletedAt
    && String(l.mobile || '').replace(/\D/g, '').slice(-10) === mobile);
  let lead, created = false;
  if (existing) {
    lead = existing;
    if (!lead.email && email) lead.email = email;
    if (!lead.city) lead.city = city;
    if (referralName) lead.referralName = referralName;
    if (occupation) lead.occupation = occupation;
    if (!lead.branch) lead.branch = websiteLeadBranch(city);
    if (!lead.assignedTo) lead.assignedTo = websiteLeadRm(lead.branch, leads);
    Object.assign(lead, fqFields);
    lead.fqTest = fqTest;
    lead.fqHistory = (Array.isArray(lead.fqHistory) ? lead.fqHistory : []).concat([fqTest]).slice(-10);
    lead.consentToConnect = true;
    lead.description = (lead.description ? lead.description + '\n\n' : '') + summary;
    lead.updatedAt = now;
  } else {
    created = true;
    const parts = name.split(' ');
    const branch = websiteLeadBranch(city);
    lead = {
      id: websiteLeadId(),
      firstName: parts[0], lastName: parts.slice(1).join(' '),
      mobile, email, city, branch,
      source: 'Website', callType: 'Inbound',
      referralName, occupation,
      assignedTo: websiteLeadRm(branch, leads),
      fqTest, fqHistory: [fqTest],
      consentToConnect: true,
      description: summary,
      status: 'created',
      blueprintHistory: [{ state: 'created', at: now, by: 'Website' }],
      createdAt: now, createdBy: 'Website',
    };
    Object.assign(lead, fqFields);
    leads.push(lead);
  }
  lead.meetingRequest = { at: now, slots, note: '', status: 'Open', source: 'Website FQ Test', timesOffered: slots.length };
  putList('leads', leads);

  // The same task the LMS raises when a client asks to meet from their FQ page.
  if (lead.assignedTo) {
    const tasks = storeList('tasks');
    tasks.push({ id: 'DST-' + Math.random().toString(36).slice(2, 7).toUpperCase() + Date.now().toString().slice(-4),
      taskType: 'Client Meeting Request', leadId: lead.id, assignTo: lead.assignedTo,
      assignedDate: now.slice(0, 10), dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      urgencyLevel: 'High', overallStatus: 'Not Started',
      description: 'Wants to meet (website FQ test, score ' + score + '/100). ' + timesLine });
    putList('tasks', tasks);
  }

  const audit = storeList('auditLog');
  audit.push({ id: 'AUD-' + Math.random().toString(36).slice(2, 7).toUpperCase() + Date.now().toString().slice(-4),
    at: now, by: 'Website', module: 'LMS', recordId: lead.id, action: created ? 'Create' : 'Edit',
    details: [{ field: 'FQ Score (website)', oldValue: '', newValue: String(score) }] });
  putList('auditLog', audit);

  if (lead.assignedTo) {
    const list = storeList('notifications');
    list.push({
      id: 'NTF-' + Math.random().toString(36).slice(2, 7).toUpperCase() + Date.now().toString().slice(-4),
      at: now, userId: lead.assignedTo,
      title: (created ? 'New website lead: ' : 'Website lead took the FQ test again: ') + name,
      body: 'FQ score ' + score + '/100 · ' + city + (lead.branch ? ' · ' + lead.branch + ' branch' : '') + '. They asked to talk to the team. ' + timesLine,
      view: 'lms', arg: lead.id, kind: 'submission', by: 'Website',
    });
    putList('notifications', list);
  }
  writeToDisk();
  res.json({ ok: true, created, message: 'Thank you! Our team will get in touch with you shortly.' });
});

/* The live team member a sign-in account is: the one it is linked to, or,
   when that record is gone (deleted, or the person added again under a new
   one), the one member on the team with the account's email. Emails are
   compared without case, spaces or invisible characters, which a pasted
   address brings with it. */
function normEmail(v) { return String(v || '').replace(/[\s\u00A0\u200B-\u200D\u2060\uFEFF]/g, '').toLowerCase(); }
function liveMemberForAccount(user) {
  if (!user) return null;
  const team = storeList('team').filter((t) => t && t.id && !t.deletedAt);
  const byId = user.member_id && team.find((t) => t.id === user.member_id);
  if (byId) return byId;
  const e = normEmail(user.email);
  const byEmail = e ? team.filter((t) => normEmail(t.email) === e) : [];
  return byEmail.length === 1 ? byEmail[0] : null;
}

app.get('/config.js', (req, res) => {
  let user = signedInUser(req);
  // An account still linked to a record that is gone follows its person.
  const member = user ? liveMemberForAccount(user) : null;
  if (user && member && member.id !== user.member_id) {
    updateUserAccount.run(user.email, user.role, member.id, user.crm_role || '', user.active, user.id);
    user = findUserById.get(user.id);
  }
  // A client's form page loads this too. It gets nothing: no API key, no
  // identity — that page talks only to the public endpoints, with its token.
  if (!user) {
    return res.type('application/javascript').set('Cache-Control', 'no-store')
      .send('window.CRM_API_KEY = "";window.CRM_IS_ADMIN = false;'
          + 'window.CRM_USER_EMAIL = "";window.CRM_MEMBER_ID = "";'
          + 'window.BOSS_PLATFORM = ' + JSON.stringify(platformOf(req)) + ';window.BOSS_ACCESS = null;');
  }
  res.type('application/javascript').set('Cache-Control', 'no-store')
     .send('window.CRM_API_KEY = ' + JSON.stringify(API_KEY || '') + ';'
         + 'window.CRM_IS_ADMIN = ' + JSON.stringify(!!(user && user.role === 'admin')) + ';'
         // Who is signed in, so the CRM can work as them rather than as
         // whichever team member happens to be first in the list.
         + 'window.CRM_USER_EMAIL = ' + JSON.stringify((user && user.email) || '') + ';'
         + 'window.CRM_MEMBER_ID = ' + JSON.stringify((user && user.member_id) || '') + ';'
         + 'window.CRM_MUST_CHANGE_PASSWORD = ' + JSON.stringify(!!(user && user.must_change)) + ';'
         + 'window.CRM_PASSWORD_SET_AT = ' + JSON.stringify((user && user.password_set_at) || '') + ';'
         // Which platform this is (partner / company / combined) and how the
         // server treats this person on it (access.js).
         + 'window.BOSS_PLATFORM = ' + JSON.stringify(platformOf(req)) + ';'
         + 'window.BOSS_ACCESS = ' + JSON.stringify(access.summary(access.principal(user), platformOf(req))) + ';');
});

/* ---------------------------------------------------------------------
   REMINDERS THE SERVER SENDS BY ITSELF

   A reminder that only exists while somebody happens to have a tab open
   is not a reminder. These run here, on a timer, against the records as
   they stand at that minute, and each one is written down when it goes
   out so a restart, a second timer tick or a deploy never sends it twice.

   Two kinds:
     - attendance: 09:15 "you have not punched in" (email + browser push),
       18:00 "you are still punched in" (BOSS notification + push),
       19:00 the same by email, if they still have not punched out.
     - the Daily Working Tracker: a meeting, call or planned activity
       reaches its start time (and, if the person asked for one, a few
       minutes before it) — a BOSS notification, a push, and email if
       they chose it.

   Times are the firm's, not the server's: BUSINESS_TZ (Asia/Kolkata unless
   CRM_BUSINESS_TZ says otherwise). Browser push needs the person to have
   allowed it on that device; when they have not, the BOSS notification is
   still there for them.
   --------------------------------------------------------------------- */
const webpush = require('web-push');
const BUSINESS_TZ = process.env.CRM_BUSINESS_TZ || 'Asia/Kolkata';
const REMINDER_FILE = process.env.CRM_REMINDER_FILE || path.join(path.dirname(DB_FILE), 'reminders.json');
const VAPID_FILE = process.env.CRM_VAPID_FILE || path.join(path.dirname(DB_FILE), 'push-vapid.json');

/* The firm's date, clock and weekday right now. */
function bizNow(at) {
  const d = at ? new Date(at) : new Date();
  const parts = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return { date: parts.year + '-' + parts.month + '-' + parts.day, hhmm: parts.hour + ':' + parts.minute,
    mins: Number(parts.hour) * 60 + Number(parts.minute), dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) };
}
function storeObj(key) {
  try { const v = JSON.parse(store[key] || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; }
}
function hhmmOk(v) { return /^\d{1,2}:\d{2}$/.test(String(v || '')); }
function minsOf(hhmm) { const b = String(hhmm).split(':'); return Number(b[0]) * 60 + Number(b[1]); }
/* "11:00", "11:00 AM", "4:30pm" -> minutes after midnight, or null. */
function clockMins(v) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?\s*$/i.exec(String(v || ''));
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]);
  if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
function clockText(mins) { return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); }

/* ---- the attendance calendar, read the way the page reads it ---- */
function hrConfigNow() {
  const c = storeObj('hrConfig');
  const day = Object.assign({ punchInFrom: '08:45', punchOutUntil: '20:45' }, c.day || {});
  const r = Object.assign({ enabled: true, inEmailAt: '09:15', outNotifyAt: '18:00', outEmailAt: '19:00' }, c.reminders || {});
  return {
    day: { from: hhmmOk(day.punchInFrom) ? day.punchInFrom : '08:45', until: hhmmOk(day.punchOutUntil) ? day.punchOutUntil : '20:45' },
    weeklyOff: Array.isArray(c.weeklyOff) ? c.weeklyOff : [],
    holidays: Array.isArray(c.holidays) ? c.holidays : [],
    leaveTypes: Array.isArray(c.leaveTypes) ? c.leaveTypes : [],
    // With comp-off on, a Sunday, weekly off or holiday can be worked and punched.
    compOffEnabled: ((c.annualLeave || {}).compOffEnabled) !== false,
    reminders: {
      enabled: r.enabled !== false,
      inAt: hhmmOk(r.inEmailAt) ? r.inEmailAt : '09:15',
      outNotifyAt: hhmmOk(r.outNotifyAt) ? r.outNotifyAt : '18:00',
      outEmailAt: hhmmOk(r.outEmailAt) ? r.outEmailAt : '19:00',
    },
  };
}
function dowOf(date) { const d = new Date(date + 'T12:00:00Z'); return isNaN(d) ? -1 : d.getUTCDay(); }
/* Why there is no attendance on this date, or ''. */
function hrClosedWhy(date, cfg) {
  cfg = cfg || hrConfigNow();
  if (process.env.CRM_ATTENDANCE_ANY_DAY === '1') return '';
  if (dowOf(date) === 0) return 'There is no attendance on Sundays.';
  const h = cfg.holidays.find((x) => x && x.date === date);
  if (h) return 'It is a holiday' + (h.name ? ' — ' + h.name : '') + '.';
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  if (cfg.weeklyOff.indexOf(names[dowOf(date)]) >= 0) return 'It is a weekly off.';
  return '';
}
function hrApprovedLeave(userId, date) {
  return storeList('hrLeave').find((l) => l && l.userId === userId && l.status === 'Approved'
    && String(l.from || '') <= date && date <= String(l.to || l.from || '')) || null;
}
function hrLeaveIsHalf(leave, cfg) {
  if (!leave) return false;
  if (leave.unit) return leave.unit === 'half';
  const t = (cfg || hrConfigNow()).leaveTypes.find((x) => (typeof x === 'string' ? x : (x && x.name)) === leave.type);
  return !!(t && typeof t === 'object' && t.unit === 'half');
}
function hrDayRecord(userId, date) {
  return storeList('hrAttendance').find((r) => r && r.userId === userId && r.date === date) || null;
}
function hrOpen(rec) { return rec && Array.isArray(rec.sessions) ? rec.sessions.find((s) => s && s.in && !s.out) || null : null; }
function hrEverIn(rec) { return !!(rec && Array.isArray(rec.sessions) && rec.sessions.some((s) => s && s.in)); }

/* Everybody who keeps attendance: the active team. */
function activeMembers() {
  return storeList('team').filter((t) => t && t.id && !t.deletedAt
    && !/inactive|left|disabled|deactivated/i.test(String(t.status || 'Active')));
}
function memberEmail(m) {
  if (m.email && ADDRESS_RE.test(String(m.email))) return String(m.email).trim();
  try { const u = findUserByMember.get(m.id); if (u && ADDRESS_RE.test(u.email)) return u.email; } catch (e) { /* no account */ }
  return '';
}
/* The member a signed-in account is, by the link the account was made with
   or, for older accounts, by its address. */
function memberOfUser(user) {
  if (!user) return null;
  const live = liveMemberForAccount(user);
  if (live) return live;
  const team = storeList('team');
  return team.find((t) => t && t.id === user.member_id)
    || team.find((t) => t && t.email && String(t.email).toLowerCase() === String(user.email || '').toLowerCase()) || null;
}

/* ---- the ledger: what went out, so nothing goes twice ---- */
function remindersRead() {
  try {
    const v = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    return { sent: v.sent && typeof v.sent === 'object' ? v.sent : {}, log: Array.isArray(v.log) ? v.log : [],
      subs: v.subs && typeof v.subs === 'object' ? v.subs : {} };
  } catch (e) { return { sent: {}, log: [], subs: {} }; }
}
let reminders = remindersRead();
function remindersWrite() {
  // Ten days of "already sent" is all that can ever matter again.
  const cutoff = bizNow(Date.now() - 10 * 86400000).date;
  Object.keys(reminders.sent).forEach((k) => { if (String(reminders.sent[k].date || '') < cutoff) delete reminders.sent[k]; });
  reminders.log = reminders.log.slice(-3000);
  const tmp = REMINDER_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(reminders)); fs.renameSync(tmp, REMINDER_FILE); }
  catch (e) { console.error('reminders: could not write the ledger —', e.message); }
}
function reminderLog(entry) { reminders.log.push(Object.assign({ at: new Date().toISOString() }, entry)); }

/* ---- browser push ---- */
function vapidKeys() {
  if (process.env.CRM_VAPID_PUBLIC && process.env.CRM_VAPID_PRIVATE)
    return { publicKey: process.env.CRM_VAPID_PUBLIC, privateKey: process.env.CRM_VAPID_PRIVATE };
  try { const v = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); if (v.publicKey && v.privateKey) return v; } catch (e) { /* first run */ }
  const k = webpush.generateVAPIDKeys();
  try { fs.writeFileSync(VAPID_FILE, JSON.stringify(k), { mode: 0o600 }); } catch (e) { console.error('push: could not keep the VAPID keys —', e.message); }
  return k;
}
const VAPID = vapidKeys();
webpush.setVapidDetails(process.env.CRM_VAPID_SUBJECT || 'mailto:admin@localhost', VAPID.publicKey, VAPID.privateKey);

/* Push to every device a person has allowed it on. A subscription the push
   service says is gone (404/410) is forgotten. */
async function pushTo(memberId, payload) {
  const subs = (reminders.subs[memberId] || []).slice();
  if (!subs.length) return { sent: 0, why: 'no device has allowed browser notifications' };
  let sent = 0;
  for (const s of subs) {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600 }); sent++; }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410))
        reminders.subs[memberId] = (reminders.subs[memberId] || []).filter((x) => x.endpoint !== s.endpoint);
    }
  }
  return { sent, why: sent ? '' : 'the push service refused it' };
}
/* A BOSS notification: the bell, the toast, and a desktop notification in
   any tab the person has open. */
function notifyInApp(memberId, n) {
  const list = storeList('notifications');
  const row = Object.assign({ id: 'NTF-' + crypto.randomBytes(6).toString('hex'), at: new Date().toISOString(),
    userId: memberId, view: '', arg: '', by: 'server' }, n);
  list.push(row);
  store.notifications = JSON.stringify(list);
  writeToDisk();
  publishChange(['notifications'], 'server');
  return row;
}
function mailTo(address, subject, body) {
  return new Promise((resolve) => {
    if (!address) return resolve({ ok: false, message: 'no email address on the account' });
    sendMail({ to: address, subject, body }, null, (status, json) => resolve({ ok: !!(json && json.ok), message: (json && json.message) || '' }));
  });
}
/* Once per key, ever. The key is written before anything is sent, so two
   ticks racing each other cannot both send. */
function claim(key, date) {
  if (reminders.sent[key]) return false;
  reminders.sent[key] = { date, at: new Date().toISOString() };
  return true;
}

/* ---- attendance ---- */
async function attendanceReminders(now) {
  const cfg = hrConfigNow();
  if (!cfg.reminders.enabled) return;
  if (hrClosedWhy(now.date, cfg)) return;
  const until = minsOf(cfg.day.until);
  const site = process.env.CRM_PUBLIC_URL || '';
  for (const m of activeMembers()) {
    if (m.attendanceExempt) continue;
    const leave = hrApprovedLeave(m.id, now.date);
    const rec = hrDayRecord(m.id, now.date);
    // 09:15 — nobody has punched in. Checked again right before each send.
    if (now.mins >= minsOf(cfg.reminders.inAt) && now.mins < until && !leave && !hrEverIn(rec)) {
      if (claim('in-mail:' + m.id + ':' + now.date, now.date)) {
        const r = await mailTo(memberEmail(m), 'Reminder: you have not punched in today',
          'Hello ' + (m.name || '') + ',\n\nIt is past ' + cfg.reminders.inAt + ' and BOSS has no punch in for you today ('
          + now.date + ').\n\nPlease punch in from the Dashboard' + (site ? ': ' + site : '') + '.\n\nIf you are on leave or working '
          + 'elsewhere, speak to your reporting manager.\n\n— BOSS');
        reminderLog({ kind: 'punch-in', channel: 'email', userId: m.id, date: now.date, ok: r.ok, message: r.message });
      }
      if (claim('in-push:' + m.id + ':' + now.date, now.date)) {
        const r = await pushTo(m.id, { title: 'You have not punched in', body: 'It is past ' + cfg.reminders.inAt
          + ' and there is no punch in on your record for today.', url: '/?view=dashboard', tag: 'punch-in-' + now.date });
        reminderLog({ kind: 'punch-in', channel: 'push', userId: m.id, date: now.date, ok: r.sent > 0, message: r.why });
      }
    }
    // 18:00 — punched in, not out: in BOSS and as a push.
    const open = hrOpen(rec);
    if (open && now.mins >= minsOf(cfg.reminders.outNotifyAt) && now.mins < until) {
      if (claim('out-app:' + m.id + ':' + now.date, now.date)) {
        notifyInApp(m.id, { title: 'You are still punched in', kind: 'hr-reminder', view: 'dashboard', tag: 'punch-out-' + now.date,
          body: 'It is past ' + cfg.reminders.outNotifyAt + ' and you have not punched out today. Punch out before '
            + cfg.day.until + '.' });
        reminderLog({ kind: 'punch-out', channel: 'in-app', userId: m.id, date: now.date, ok: true, message: '' });
      }
      if (claim('out-push:' + m.id + ':' + now.date, now.date)) {
        const r = await pushTo(m.id, { title: 'You are still punched in', body: 'It is past ' + cfg.reminders.outNotifyAt
          + ' and you have not punched out today.', url: '/?view=dashboard', tag: 'punch-out-' + now.date });
        reminderLog({ kind: 'punch-out', channel: 'push', userId: m.id, date: now.date, ok: r.sent > 0, message: r.why });
      }
    }
    // 19:00 — the same, by email, only if the record still says so now.
    if (now.mins >= minsOf(cfg.reminders.outEmailAt) && now.mins < until && hrOpen(hrDayRecord(m.id, now.date))) {
      if (claim('out-mail:' + m.id + ':' + now.date, now.date)) {
        const r = await mailTo(memberEmail(m), 'Reminder: you have not punched out today',
          'Hello ' + (m.name || '') + ',\n\nYou punched in today (' + now.date + ') and have not punched out yet. Punch out in BOSS before '
          + cfg.day.until + (site ? ': ' + site : '') + '.\n\nIf you forgot and have already left, raise an attendance regularization.\n\n— BOSS');
        reminderLog({ kind: 'punch-out', channel: 'email', userId: m.id, date: now.date, ok: r.ok, message: r.message });
      }
    }
  }
}

/* ---- the Daily Working Tracker ---- */
/* The page's own rule for whether a planned activity lands on a date. */
function weekStartOfDate(date, startsMonday) {
  const d = new Date(date + 'T12:00:00Z');
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (startsMonday ? (dow + 6) % 7 : dow));
  return d.toISOString().slice(0, 10);
}
/* Was this activity done on this day? A recurring slot records each day it
   was completed in doneOn[date]; one saved before that, or a slot on a
   single day, carries status Completed and the day it was done. The same
   rule as dwtDoneEntry() in the browser. */
function activityDoneOn(a, date) {
  if (a.doneOn && a.doneOn[date]) return true;
  const recurring = (a.days && a.days.length > 1) || a.repeatWeekly;
  return a.status === 'Completed' && (!recurring || (a.completedOn || a.date) === date);
}
function activityOccursOn(a, day, startsMonday) {
  if ((a.skipDates || []).includes(day)) return false;
  if (day < a.date && !(a.days && a.days.length)) return false;
  if (a.days && a.days.length) {
    if (!a.days.includes(dowOf(day))) return false;
    if (a.repeatWeekly) return weekStartOfDate(day, startsMonday) >= weekStartOfDate(a.date, startsMonday);
    return weekStartOfDate(day, startsMonday) === weekStartOfDate(a.date, startsMonday);
  }
  const rec = a.recurrence && a.recurrence !== 'none' ? a.recurrence : null;
  if (!rec) return day === a.date;
  if (a.recurrenceUntil && day > a.recurrenceUntil) return false;
  const diff = Math.round((new Date(day + 'T12:00:00Z') - new Date(a.date + 'T12:00:00Z')) / 86400000);
  if (rec === 'daily') return diff >= 0;
  if (rec === 'weekdays') return diff >= 0 && dowOf(day) >= 1 && dowOf(day) <= 5;
  if (rec === 'weekly') return diff >= 0 && diff % 7 === 0;
  if (rec === 'monthly') return new Date(day + 'T12:00:00Z').getUTCDate() === new Date(a.date + 'T12:00:00Z').getUTCDate();
  return day === a.date;
}
function nameOfClient(id) { const c = storeList('clients').find((x) => x && x.id === id); return c ? (c.cmsName || '') : ''; }
function nameOfLead(id) { const l = storeList('leads').find((x) => x && x.id === id); return l ? ((l.firstName || '') + ' ' + (l.lastName || '')).trim() : ''; }
/* Everything on somebody's day that has a start time, as the planner shows it. */
function scheduledToday(memberId, date, startsMonday) {
  const out = [];
  storeList('meetings').forEach((m) => {
    if (!m || m.deletedAt || (m.assignTo || m.createdBy) !== memberId || m.scheduledDate !== date) return;
    if (/completed|cancelled|not required/i.test(m.status || '')) return;
    const start = clockMins(m.scheduledTime);
    if (start === null) return;
    out.push({ kind: 'meeting', id: m.id, title: m.subject || m.meetingType || 'Meeting', start,
      who: m.clientId ? nameOfClient(m.clientId) : (m.withName || ''), link: m.meetingLink || '', where: m.location || '' });
  });
  storeList('callEntries').forEach((c) => {
    if (!c || c.deletedAt || (c.loggedBy || c.createdBy) !== memberId || c.callDate !== date) return;
    if (/completed|cancelled/i.test(c.status || '')) return;
    const start = clockMins(c.startTime);
    if (start === null) return;
    out.push({ kind: 'call', id: c.id, title: c.subject || ((c.callCategory || 'Call') + (c.callType ? ' (' + c.callType + ')' : '')), start,
      who: c.clientId ? nameOfClient(c.clientId) : (c.leadId ? nameOfLead(c.leadId) : ''), link: '', where: '' });
  });
  storeList('workActivities').forEach((a) => {
    if (!a || a.deletedAt || a.userId !== memberId || !activityOccursOn(a, date, startsMonday)) return;
    if (a.status === 'Cancelled') return;
    if (activityDoneOn(a, date)) return;
    if ((a.startedOn || {})[date]) return;
    const start = clockMins(a.plannedStart);
    if (start === null) return;
    const isMeeting = /meeting/i.test(a.activityType || '');
    out.push({ kind: isMeeting ? 'meeting' : 'activity', source: 'manual', id: a.id, title: a.title || a.activityType || 'Activity', start,
      who: a.clientId ? nameOfClient(a.clientId) : (a.leadId ? nameOfLead(a.leadId) : ''), link: '', where: '' });
  });
  return out;
}
function dwtPrefs(m) {
  const p = Object.assign({ activities: true, meetings: true, inApp: true, desktop: true, email: false, advanceMinutes: 0 }, m.reminderPrefs || {});
  p.advanceMinutes = Math.max(0, Math.min(120, Number(p.advanceMinutes) || 0));
  return p;
}
async function dwtReminders(now) {
  const startsMonday = (((storeObj('config').general) || {}).weekStartsOn) !== 'Sunday';
  for (const m of activeMembers()) {
    const p = dwtPrefs(m);
    for (const it of scheduledToday(m.id, now.date, startsMonday)) {
      if (it.kind === 'meeting' ? !p.meetings : !p.activities) continue;
      /* Which reminder is due: the one at the start, or the one ahead of it.
         A reminder more than 15 minutes late is not sent by push or email —
         the BOSS notification is still written, so it is waiting for them. */
      const marks = [{ at: it.start, which: 'start' }];
      if (p.advanceMinutes) marks.push({ at: it.start - p.advanceMinutes, which: 'pre' });
      for (const mk of marks) {
        if (now.mins < mk.at) continue;
        if (mk.which === 'pre' && now.mins >= it.start) continue;
        const late = now.mins - mk.at > 15;
        if (late && mk.which === 'pre') continue;
        // The time is in the key: a rescheduled item is a new reminder, and the old time never fires.
        const key = 'dwt:' + mk.which + ':' + m.id + ':' + it.kind + ':' + it.id + ':' + now.date + ':' + clockText(it.start);
        if (!claim(key, now.date)) continue;
        const when = clockText(it.start);
        const title = it.kind === 'meeting' ? 'Meeting: ' + it.title : 'Scheduled: ' + it.title;
        const body = mk.which === 'pre'
          ? (it.kind === 'meeting' ? 'Your meeting “' + it.title + '” starts at ' + when + ', in ' + (it.start - now.mins) + ' minutes.'
            : 'Your scheduled activity “' + it.title + '” starts at ' + when + ', in ' + (it.start - now.mins) + ' minutes.')
          : (it.kind === 'meeting' ? 'Your meeting “' + it.title + '” is scheduled to start now (' + when + '). Please join or begin the meeting.'
            : 'Your scheduled activity “' + it.title + '” is due to start now (' + when + ').');
        const extra = [it.who ? 'With: ' + it.who : '', it.where ? 'Where: ' + it.where : '', it.link ? 'Link: ' + it.link : ''].filter(Boolean).join(' · ');
        const meta = { kind: it.kind, source: it.source || it.kind, id: it.id, date: now.date, time: when, who: it.who, link: it.link, where: it.where, which: mk.which };
        if (p.inApp) {
          notifyInApp(m.id, { title, body: body + (extra ? '\n' + extra : ''), kind: 'dwt-reminder', view: 'dwt', arg: now.date, meta, tag: key });
          reminderLog({ kind: 'dwt-' + mk.which, channel: 'in-app', userId: m.id, date: now.date, ok: true, message: it.title + ' ' + when });
        }
        if (p.desktop && !late) {
          const r = await pushTo(m.id, { title, body: body + (extra ? ' ' + extra : ''), url: '/?view=dwt', tag: key });
          reminderLog({ kind: 'dwt-' + mk.which, channel: 'push', userId: m.id, date: now.date, ok: r.sent > 0, message: r.why });
        }
        if (p.email && !late) {
          const r = await mailTo(memberEmail(m), title + ' at ' + when, body + (extra ? '\n\n' + extra.split(' · ').join('\n') : '') + '\n\n— BOSS');
          reminderLog({ kind: 'dwt-' + mk.which, channel: 'email', userId: m.id, date: now.date, ok: r.ok, message: r.message });
        }
      }
    }
  }
}
/* ---- insurance renewals (Insurance Agency SOP, Phase 5) ----
   A policy in force on the CMS insurance journey has its next premium due
   date on the client (insNextDueDate). The client is emailed 30, 15 and 7
   days before it, on the day, and through the grace period (7, 15 and 30
   days after); the RM gets a BOSS notification with the first one. Each
   is sent once per policy, due date and step, from 10:00 in the firm's day.
   The wording is the firm's "Insurance — renewal premium reminder"
   template, and the firm's email switches hold it like any other letter. */
const INS_REMINDER_DAYS = [30, 15, 7, 0, -7, -15, -30];
const INS_REMINDER_DEFAULT = {
  subject: 'Premium due on {DueDate} — policy {PolicyNo}',
  body: 'Dear {ClientName},\n\nThis is a reminder that the premium of {Premium} on your {Company} policy {PolicyNo} ({Plan}) is due on {DueDate}.\n\nPaying on time keeps your cover in force without a break. If you have already paid, please ignore this note, or send us the receipt and we will update our records.\n\n{Signature}',
};
function dayDiff(from, to) {
  const a = new Date(from + 'T12:00:00Z'), b = new Date(to + 'T12:00:00Z');
  return Math.round((b - a) / 86400000);
}
function addDays(date, n) { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fmtDay(date) {
  const d = new Date(date + 'T12:00:00Z');
  return isNaN(d) ? date : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function inr(v) { const n = Number(v); return v && isFinite(n) ? '₹' + n.toLocaleString('en-IN') : ''; }
/* Which reminder is due today for a premium `left` days away, or null. */
function insReminderStep(left) {
  if (left > INS_REMINDER_DAYS[0] || left < INS_REMINDER_DAYS[INS_REMINDER_DAYS.length - 1]) return null;
  for (let i = 0; i < INS_REMINDER_DAYS.length; i++) {
    const step = INS_REMINDER_DAYS[i], next = INS_REMINDER_DAYS[i + 1];
    if (left <= step && (next === undefined || left > next)) return step;
  }
  return null;
}
async function insuranceRenewalReminders(now) {
  if (now.mins < 10 * 60) return;
  const cfg = storeObj('config');
  const held = cfg.mailOutflow === false ? 'Email outflow is switched off'
    : (cfg.mailModuleOff || {}).CMS ? 'Email for CMS is switched off'
    : (cfg.mailTemplatesOff || {}).insRenewalReminder ? 'The renewal reminder template is switched off' : '';
  const tpl = Object.assign({}, INS_REMINDER_DEFAULT, (cfg.mailTemplates || {}).insRenewalReminder || {});
  const firm = (cfg.company || {}).name || '';
  /* The reminders come from the policies the Life, Health and General
     Insurance modules hold — one per policy in force — and never from the
     client record, so a client is not reminded twice for one premium. */
  const clients = storeList('clients');
  const policies = storeList('insPolicies');
  let touched = false;
  for (const p of policies) {
    if (!p || p.deletedAt || p.status !== 'Active' || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.insNextDueDate || ''))) continue;
    const c = clients.find((x) => x && x.id === p.clientId && !x.deletedAt);
    if (!c) continue;
    const due = p.insNextDueDate, left = dayDiff(now.date, due);
    const step = insReminderStep(left);
    if (step === null) continue;
    // Kept until a month past the due date, so a step is never sent twice.
    if (!claim('ins-renewal:' + c.id + ':' + (p.insPolicyNo || p.id) + ':' + due + ':' + step, addDays(due, 40))) continue;
    const company = p.insCompany === 'Other' ? (p.insCompanyOther || '') : (p.insCompany || '');
    const vars = { ClientName: c.cmsName || '', Name: c.cmsName || '', PolicyNo: p.insPolicyNo || '', Company: company,
      Plan: p.insPlanName || '', Premium: inr(p.insPremium), DueDate: fmtDay(due), FirmName: firm, Signature: firm };
    const fill = (t) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    const subject = fill(tpl.subject), body = fill(tpl.body);
    const address = ADDRESS_RE.test(String(c.email || '')) ? String(c.email).trim() : '';
    let r;
    if (held) r = { ok: false, held: true, message: held + ' — nothing was sent.' };
    else if (!address) r = { ok: false, message: 'no email address on this client' };
    else r = await mailTo(address, subject, body);
    const when = left > 0 ? left + ' days before' : left === 0 ? 'on the due date' : -left + ' days into the grace period';
    reminderLog({ kind: 'insurance-renewal', channel: 'email', clientId: c.id, date: now.date, due, step, ok: r.ok, message: r.message });
    // On the client's Sent Mail tab and in its insurance history, like a letter sent from the page.
    const comms = storeList('communications');
    comms.push({ id: 'COM-' + crypto.randomBytes(6).toString('hex'), clientId: c.id, leadId: null, channel: 'Email', direction: 'Outbound',
      status: r.ok ? 'Sent' : r.held ? 'Held' : 'Not Sent', statusNote: r.message || '', subject, body, address,
      at: new Date().toISOString(), by: 'server', module: 'CMS', recordId: c.id, label: 'Insurance Renewal Reminder (automatic)' });
    store.communications = JSON.stringify(comms);
    p.history = (Array.isArray(p.history) ? p.history : []).concat([{ at: new Date().toISOString(), by: 'server', step: 'insRenewalAuto',
      label: 'Renewal reminder (' + when + ')', note: (r.ok ? 'Emailed to ' + address : 'Not sent: ' + (r.message || '')) + ' — premium due ' + fmtDay(due) }]);
    touched = true;
    if (step === INS_REMINDER_DAYS[0] && c.rmName) {
      notifyInApp(c.rmName, { title: 'Renewal premium due in 30 days', kind: 'insurance-renewal', view: p.module || 'inslife', arg: p.id,
        body: (c.cmsName || 'A client') + ' — policy ' + (p.insPolicyNo || '') + ', ' + inr(p.insPremium) + ' due ' + fmtDay(due) + '.' });
    }
  }
  if (touched) {
    store.insPolicies = JSON.stringify(policies);
    writeToDisk();
    publishChange(['insPolicies', 'communications'], 'server');
  }
}

/* ---- DJT: the 9 o'clock email ----
   Every morning each person is sent their own day from the Daily Job
   Tracker: what was on their list yesterday and how much of it got done,
   what they wrote as yesterday's learning, breakdown and breakthrough, and
   what is on their list today. It is read the way the DJT page reads it —
   service tasks due, meetings, reviews of their clients, business they
   logged and their DWT blocks — and only ever their own. Sent once a day
   from 09:00 in the firm's time zone, with a BOSS notification beside it.
   Setup › General › "DJT: daily email at 9 AM" turns it off. */
const DJT_DAILY_AT = 9 * 60;
function djtDayWork(memberId, date, startsMonday) {
  const out = [];
  const clients = storeList('clients');
  const clientOf = (id) => clients.find((c) => c && c.id === id) || null;
  const who = (r) => (r.clientId ? nameOfClient(r.clientId) : (r.leadId ? nameOfLead(r.leadId) : (r.withName || '')));
  storeList('tasks').forEach((t) => {
    if (!t || t.deletedAt || t.parentTaskId || t.assignTo !== memberId || t.dueDate !== date) return;
    const tt = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t.taskTime || '')) ? t.taskTime : '';
    out.push({ src: 'DST', title: t.description || t.taskType || t.id, detail: [t.taskType, who(t)].filter(Boolean).join(' · '), time: tt,
      status: t.overallStatus || 'Not Started', done: t.overallStatus === 'Completed', cancelled: t.overallStatus === 'Cancelled' });
  });
  storeList('meetings').forEach((m) => {
    if (!m || m.deletedAt || (m.assignTo || m.createdBy) !== memberId || m.scheduledDate !== date) return;
    const at = clockMins(m.scheduledTime);
    out.push({ src: m.isArc ? 'ARC' : 'Meeting', title: m.subject || m.meetingType || 'Meeting', detail: [m.meetingType, who(m)].filter(Boolean).join(' · '),
      time: at === null ? '' : clockText(at), status: m.status || 'Scheduled', done: m.status === 'Completed', cancelled: m.status === 'Cancelled' });
  });
  storeList('reviews').forEach((r) => {
    if (!r || r.deletedAt || r.meetingDate !== date) return;
    const c = clientOf(r.clientId);
    if (!c || c.rmName !== memberId) return;
    const closed = /^closed$/i.test(String(r.rmsStatus || ''));
    out.push({ src: 'RMS', title: r.reviewType || 'Portfolio Review', detail: c.cmsName || '', status: closed ? 'Completed' : 'Open', done: closed, cancelled: false });
  });
  storeList('businessEntries').forEach((b) => {
    if (!b || b.deletedAt || b.createdBy !== memberId || String(b.createdAt || '').slice(0, 10) !== date) return;
    out.push({ src: 'DBT', title: (b.productCategory || 'Business') + (b.amount ? ' — ' + inr(b.amount) : ''), detail: [b.transactionType, who(b)].filter(Boolean).join(' · '),
      status: b.status || 'Not Started', done: b.status === 'Completed', cancelled: false });
  });
  storeList('workActivities').forEach((a) => {
    if (!a || a.deletedAt || a.userId !== memberId || !activityOccursOn(a, date, startsMonday)) return;
    const at = clockMins(a.plannedStart);
    const done = activityDoneOn(a, date);
    out.push({ src: 'DWT', title: a.title || a.activityType || 'Activity', detail: [a.activityType, who(a)].filter(Boolean).join(' · '),
      time: at === null ? '' : clockText(at), status: done ? 'Completed' : (a.status === 'Cancelled' ? 'Cancelled' : 'Planned'), done, cancelled: a.status === 'Cancelled' });
  });
  return out.sort((x, y) => String(x.time || 'zz').localeCompare(String(y.time || 'zz')));
}
function djtDailyLetter(m, today, startsMonday) {
  const yday = addDays(today, -1);
  const was = djtDayWork(m.id, yday, startsMonday), now = djtDayWork(m.id, today, startsMonday);
  const entry = storeList('djtEntries').find((e) => e && e.userId === m.id && e.date === yday) || {};
  if (!was.length && !now.length && !entry.learning && !entry.breakdown && !entry.breakthrough) return null;
  const line = (w) => '  ' + (w.done ? '✓' : w.cancelled ? '✗' : '•') + ' ' + (w.time ? w.time + ' ' : '') + '[' + w.src + '] ' + w.title
    + (w.detail ? ' — ' + w.detail : '') + (w.done || w.cancelled ? '' : ' (' + w.status + ')');
  const doneY = was.filter((w) => w.done), openY = was.filter((w) => !w.done && !w.cancelled);
  const firm = (storeObj('config').company || {}).name || 'BOSS';
  const parts = ['Good morning ' + (String(m.name || '').split(' ')[0] || '') + ',', '',
    'Here is your day from the Daily Job Tracker.', '',
    'YESTERDAY — ' + fmtDay(yday) + ' (' + doneY.length + ' of ' + was.length + ' done)'];
  if (doneY.length) parts.push('Completed:', ...doneY.map(line));
  if (openY.length) parts.push('Still open — carry these forward in DJT:', ...openY.map(line));
  if (!was.length) parts.push('  Nothing was on your list.');
  const refl = [['Learning', entry.learning], ['Breakdown', entry.breakdown], ['Breakthrough', entry.breakthrough]].filter((x) => x[1]);
  if (refl.length) parts.push('', 'What you wrote:', ...refl.map((x) => '  ' + x[0] + ': ' + String(x[1]).trim()));
  parts.push('', 'TODAY — ' + fmtDay(today) + ' (' + now.length + ' job' + (now.length === 1 ? '' : 's') + ')');
  if (now.length) parts.push(...now.map(line)); else parts.push('  Nothing is on your list yet.');
  const site = process.env.CRM_PUBLIC_URL || '';
  parts.push('', 'Open BOSS' + (site ? ' (' + site.replace(/\/$/, '') + ')' : '') + ' › Operations › DJT to tick off or carry forward.', '', '— ' + firm);
  return { subject: 'Your day: ' + now.length + ' job' + (now.length === 1 ? '' : 's') + ' today · ' + doneY.length + ' of ' + was.length + ' done yesterday',
    body: parts.join('\n'), today: now.length, doneY: doneY.length, totalY: was.length, openY: openY.length };
}
async function djtDailyEmails(now) {
  if (now.mins < DJT_DAILY_AT) return;
  const cfg = storeObj('config');
  if ((cfg.general || {}).djtDailyEmail === false) return;
  const held = cfg.mailOutflow === false ? 'Email outflow is switched off' : '';
  const startsMonday = ((cfg.general || {}).weekStartsOn) !== 'Sunday';
  for (const m of activeMembers()) {
    const letter = djtDailyLetter(m, now.date, startsMonday);
    if (!letter) continue;
    if (!claim('djt-daily:' + m.id + ':' + now.date, now.date)) continue;
    notifyInApp(m.id, { title: letter.subject, kind: 'djt-daily', view: 'djt', arg: now.date,
      body: letter.today + ' on today\'s list; yesterday ' + letter.doneY + ' of ' + letter.totalY + ' done' + (letter.openY ? ', ' + letter.openY + ' still open' : '') + '.' });
    const address = memberEmail(m);
    const r = held ? { ok: false, message: held + ' — nothing was sent.' } : await mailTo(address, letter.subject, letter.body);
    reminderLog({ kind: 'djt-daily', channel: 'email', userId: m.id, date: now.date, ok: r.ok, message: r.message || (address ? '' : 'no email address') });
  }
}

let reminderRunning = false;
async function reminderTick(at) {
  if (reminderRunning) return;           // one tick at a time: a slow mail server must not overlap the next
  reminderRunning = true;
  try {
    const now = bizNow(at);
    await attendanceReminders(now);
    await dwtReminders(now);
    await insuranceRenewalReminders(now);
    await djtDailyEmails(now);
  } catch (e) { console.error('reminders:', e && e.message || e); }
  finally { remindersWrite(); reminderRunning = false; }
}
if (process.env.CRM_REMINDERS !== 'off' && process.env.CRM_REMINDERS !== 'manual') {
  setTimeout(() => reminderTick(), 5000);
  setInterval(() => reminderTick(), 30000).unref();
}
/* The test suites run with CRM_REMINDERS=manual: no timer, and a tick is
   run on request at a time of their choosing. Never available otherwise. */
if (process.env.CRM_REMINDERS === 'manual') {
  app.post('/api/reminders/run', checkApiKey, async (req, res) => {
    await reminderTick(req.body && req.body.at);
    res.json({ ok: true, log: reminders.log.slice(-50) });
  });
}

/* The page's side of push: the public key, and this device's subscription. */
app.get('/api/push/key', (req, res) => res.json({ publicKey: VAPID.publicKey }));
app.post('/api/push/subscribe', checkApiKey, (req, res) => {
  const member = memberOfUser(signedInUser(req));
  if (!member) return res.status(403).json({ error: 'this account is not linked to a team member' });
  const s = req.body && req.body.subscription;
  if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth)
    return res.status(400).json({ error: 'that is not a push subscription' });
  const list = (reminders.subs[member.id] || []).filter((x) => x.endpoint !== s.endpoint);
  list.push({ endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) }, at: new Date().toISOString() });
  reminders.subs[member.id] = list.slice(-10);
  remindersWrite();
  res.json({ ok: true, devices: reminders.subs[member.id].length });
});
app.post('/api/push/unsubscribe', checkApiKey, (req, res) => {
  const member = memberOfUser(signedInUser(req));
  if (!member) return res.status(403).json({ error: 'this account is not linked to a team member' });
  const endpoint = req.body && req.body.endpoint;
  reminders.subs[member.id] = (reminders.subs[member.id] || []).filter((x) => endpoint && x.endpoint !== endpoint);
  remindersWrite();
  res.json({ ok: true, devices: reminders.subs[member.id].length });
});
/* What went out: your own, or everybody's for an administrator. */
app.get('/api/reminders/log', checkApiKey, (req, res) => {
  const user = signedInUser(req);
  const member = memberOfUser(user);
  const all = user && user.role === 'admin';
  const rows = reminders.log.filter((r) => all || (member && r.userId === member.id)).slice(-300).reverse();
  res.json({ rows, devices: member ? (reminders.subs[member.id] || []).length : 0, timezone: BUSINESS_TZ, now: bizNow() });
});
/* Attendance as the server sees it today, for the page to check itself against. */
app.get('/api/attendance/today', checkApiKey, (req, res) => {
  const member = memberOfUser(signedInUser(req));
  // An account with no team member behind it has no attendance to answer for.
  if (!member) return res.json({ member: false });
  const now = bizNow();
  const cfg = hrConfigNow();
  const rec = hrDayRecord(member.id, now.date);
  const leave = hrApprovedLeave(member.id, now.date);
  res.json({ userId: member.id, date: now.date, time: now.hhmm, punchedIn: hrEverIn(rec), open: !!hrOpen(rec),
    leave: leave ? { type: leave.type || '', half: hrLeaveIsHalf(leave, cfg) } : null, closed: hrClosedWhy(now.date, cfg) });
});

// Serve the CRM itself — one process, one command, no separate static host needed.
/* PAYOUT — mutual fund brokerage, L1–L7 sharing, settlements and the payment
   ledger. It was a separate app (WealthFlow) with its own logins; it now lives
   in payout/ and answers at /api/payout behind the same sign-in and API key as
   everything else. Its records are SQLite, in their own file beside data.json,
   so nothing here touches the CRM's store. payout/ is ES modules, so it is
   imported rather than required; a request that arrives in the moment before
   that finishes simply waits for it. */
process.env.CRM_PAYOUT_DB = process.env.CRM_PAYOUT_DB || path.join(path.dirname(DB_FILE), 'payout.db');
function payoutAccount(req) {
  const user = signedInUser(req);
  if (!user) return null;
  let name = '';
  try {
    const team = JSON.parse(store.team || '[]');
    const member = Array.isArray(team) ? team.find((t) => t && t.id === user.member_id) : null;
    name = (member && (member.name || member.fullName)) || '';
  } catch (e) { /* no name, then: the payout module makes one from the email */ }
  return { email: user.email, role: user.role, name };
}
const payoutRouter = import('./payout/index.js')
  .then((m) => m.createPayoutRouter({ currentAccount: payoutAccount }));
payoutRouter.catch((err) => console.error('Payout module failed to load:', err));
app.use('/api/payout', checkApiKey, (req, res, next) => {
  payoutRouter.then((router) => router(req, res, next),
    () => res.status(503).json({ error: 'The payout module did not start. See the server log.' }));
});

/* THE PARTNER JOURNEY — the session reminders, the ARN / EUIN expiry
   warnings and the prospect's own form, which all have to work with no
   CRM tab open. See partner-journey.js. */
const partnerJourney = require('./partner-journey').install({ app, storeList, storeValue, putList, writeToDisk, sendMail, checkApiKey,
  dataDir: path.dirname(DB_FILE) });
/* The partner's own login and the one empanelment form (B2B changes 3).
   A door of its own, with accounts of its own: see partner-portal.js. */
require('./partner-portal').install({ app, storeList, storeValue, putList, writeToDisk,
  pj: partnerJourney, publicDir: path.join(__dirname, 'public') });
/* SKILL DEVELOPMENT CENTER — per-course access and the lesson videos
   (skill-center-server.js). */
const sdcServer = require('./skill-center-server').install({ app, checkApiKey, signedInUser, storeList, storeValue,
  dataDir: path.dirname(DB_FILE) });
/* The separate partner login is gone: partners sign in to BOSS itself
   (Setup › Partner Levels). An old link or bookmark lands on the one
   sign-in page rather than on nothing. */
app.get(['/partner', '/partner/login', '/partner/setup'], (req, res) => res.redirect('/login'));
app.get('/partner-form', (req, res) => {
  res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'public', 'partner-form.html'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const HOST = process.env.HOST || '0.0.0.0'; // in production bind to 127.0.0.1 so only nginx can reach it
repairFqOnLeads();
app.listen(PORT, HOST, () => {
  console.log(`BOSS server running on http://localhost:${PORT}`);
  console.log(`Database file: ${DB_FILE}`);
  console.log(API_KEY ? 'API key protection: ENABLED' : 'API key protection: DISABLED (set CRM_API_KEY env var before real deployment)');
});
