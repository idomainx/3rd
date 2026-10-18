'use strict';
// Express server: SQLite setup, session auth + CSRF, admin API routes, static UI, draft preview.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const multer = require('multer');
const sharp = require('sharp');
const { buildSite, buildToDir, computeDiff, publishToCloudflare, listSnapshots } = require('./build-publish');
const { parseFields, render, md } = require('./template-engine');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
require('fs').mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

// ---------- Database setup ----------
db.exec(`
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  html TEXT NOT NULL DEFAULT '',
  ai_instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'post',
  title TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  template_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS redirects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 301
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- Auth / session / CSRF ----------
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

// Check login credentials.
function checkLogin(user, pass) {
  return user === ADMIN_USER && pass === ADMIN_PASS;
}

// Create a session token and store it.
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
  return token;
}

// Resolve the current session from the cookie.
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)session=([a-f0-9]+)/.exec(cookie);
  if (!m) return null;
  return db.prepare('SELECT * FROM sessions WHERE token=?').get(m[1]) || null;
}

// Middleware: reject unauthenticated API calls with JSON.
function requireAuth(req, res, next) {
  if (!getSession(req)) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// Middleware: verify the CSRF token header matches the session cookie for mutating calls.
function requireCSRF(req, res, next) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)csrf=([a-f0-9]+)/.exec(cookie);
  const token = req.headers['x-csrf-token'];
  if (!m || !token || m[1] !== token) return res.status(403).json({ error: 'Invalid CSRF token' });
  next();
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------- Templates ----------
// Ensure a template name is unique by appending -2, -3, ... (fix for the duplicate-name crash).
function uniqueTemplateName(base) {
  let name = base, n = 1;
  while (db.prepare('SELECT id FROM templates WHERE name=?').get(name)) { n++; name = base + '-' + n; }
  return name;
}

// List templates with parsed field definitions.
app.get('/api/templates', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM templates ORDER BY name').all();
  res.json(rows.map((t) => ({ ...t, fields: parseFields(t.html) })));
});

// Create a template; name collisions are auto-resolved (new-template-2, -3...).
app.post('/api/templates', requireAuth, requireCSRF, (req, res) => {
  const name = uniqueTemplateName((req.body && req.body.name) || 'new-template');
  const html = (req.body && req.body.html) || '';
  const ai = (req.body && req.body.ai_instructions) || '';
  const info = db.prepare('INSERT INTO templates (name, html, ai_instructions) VALUES (?, ?, ?)').run(name, html, ai);
  res.json({ id: info.lastInsertRowid, name });
});

// Update a template (name changes are also uniquified).
app.put('/api/templates/:id', requireAuth, requireCSRF, (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const name = req.body.name && req.body.name !== t.name ? uniqueTemplateName(req.body.name) : t.name;
  db.prepare('UPDATE templates SET name=?, html=?, ai_instructions=? WHERE id=?')
    .run(name, req.body.html != null ? req.body.html : t.html, req.body.ai_instructions != null ? req.body.ai_instructions : t.ai_instructions, t.id);
  res.json({ ok: true, name });
});

// Duplicate a template with a unique name.
app.post('/api/templates/:id/duplicate', requireAuth, requireCSRF, (req, res) => {
  const t = db.prepare('SELECT * FROM templates WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  const base = t.name + '-copy';
  const name = uniqueTemplateName(base);
  const info = db.prepare('INSERT INTO templates (name, html, ai_instructions) VALUES (?, ?, ?)').run(name, t.html, t.ai_instructions);
  res.json({ id: info.lastInsertRowid, name });
});

// Delete a template.
app.delete('/api/templates/:id', requireAuth, requireCSRF, (req, res) => {
  db.prepare('DELETE FROM templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Entries ----------
// Ensure a slug is unique among non-trashed entries of the same kind.
function uniqueSlug(kind, slug, exceptId) {
  let base = slug || 'entry', name = base, n = 1;
  for (;;) {
    const row = exceptId
      ? db.prepare("SELECT id FROM entries WHERE kind=? AND slug=? AND id!=?").get(kind, name, exceptId)
      : db.prepare('SELECT id FROM entries WHERE kind=? AND slug=?').get(kind, name);
    if (!row) return name;
    n++; name = base + '-' + n;
  }
}

// List entries, newest first; ?status=trash returns only trashed ones.
app.get('/api/entries', requireAuth, (req, res) => {
  const status = req.query.status === 'trash' ? 'trash' : null;
  const rows = status
    ? db.prepare("SELECT * FROM entries WHERE status='trash' ORDER BY updated_at DESC").all()
    : db.prepare("SELECT * FROM entries WHERE status!='trash' ORDER BY updated_at DESC").all();
  res.json(rows);
});

// Create an entry.
app.post('/api/entries', requireAuth, requireCSRF, (req, res) => {
  const b = req.body || {};
  const slug = uniqueSlug(b.kind || 'post', (b.slug || b.title || 'entry').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  const info = db.prepare('INSERT INTO entries (kind, title, slug, body, fields, template_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(b.kind || 'post', b.title || 'Untitled', slug, b.body || '', JSON.stringify(b.fields || {}), b.template_name || null, b.status || 'draft');
  res.json({ id: info.lastInsertRowid });
});

// Get one entry.
app.get('/api/entries/:id', requireAuth, (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  res.json(e);
});

// Update an entry, including page HTML body and field values.
app.put('/api/entries/:id', requireAuth, requireCSRF, (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  const b = req.body || {};
  const slug = b.slug && b.slug !== e.slug ? uniqueSlug(e.kind, b.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), e.id) : e.slug;
  db.prepare('UPDATE entries SET title=?, slug=?, body=?, fields=?, template_name=?, status=?, updated_at=datetime(\'now\') WHERE id=?')
    .run(
      b.title != null ? b.title : e.title,
      slug,
      b.body != null ? b.body : e.body,
      JSON.stringify(b.fields != null ? b.fields : JSON.parse(e.fields || '{}')),
      b.template_name !== undefined ? b.template_name : e.template_name,
      b.status != null ? b.status : e.status,
      e.id
    );
  res.json({ ok: true });
});

// Trash an entry.
app.delete('/api/entries/:id', requireAuth, requireCSRF, (req, res) => {
  db.prepare("UPDATE entries SET status='trash', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Restore from trash.
app.post('/api/entries/:id/restore', requireAuth, requireCSRF, (req, res) => {
  db.prepare("UPDATE entries SET status='draft', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Duplicate an entry.
app.post('/api/entries/:id/duplicate', requireAuth, requireCSRF, (req, res) => {
  const e = db.prepare('SELECT * FROM entries WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  const slug = uniqueSlug(e.kind, e.slug + '-copy');
  db.prepare('INSERT INTO entries (kind, title, slug, body, fields, template_name, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(e.kind, e.title + ' (copy)', slug, e.body, e.fields, e.template_name, 'draft');
  res.json({ ok: true });
});

// Bulk actions: {action: 'publish'|'trash'|'restore'|'delete', ids: [..]}.
app.post('/api/entries/bulk', requireAuth, requireCSRF, (req, res) => {
  const { action, ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No entries selected' });
  if (action === 'publish') db.prepare("UPDATE entries SET status='published', updated_at=datetime('now') WHERE id IN (" + ids.map(() => '?').join(',') + ')').run(...ids);
  else if (action === 'trash') db.prepare("UPDATE entries SET status='trash', updated_at=datetime('now') WHERE id IN (" + ids.map(() => '?').join(',') + ')').run(...ids);
  else if (action === 'restore') db.prepare("UPDATE entries SET status='draft', updated_at=datetime('now') WHERE id IN (" + ids.map(() => '?').join(',') + ')').run(...ids);
  else if (action === 'delete') db.prepare('DELETE FROM entries WHERE id IN (' + ids.map(() => '?').join(',') + ')').run(...ids);
  else return res.status(400).json({ error: 'Unknown action' });
  res.json({ ok: true });
});

// ---------- Settings / redirects ----------
// Get all settings as a map.
app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

// Save only the supported settings keys (site name, URL, tracking snippets).
app.put('/api/settings', requireAuth, requireCSRF, (req, res) => {
  const allowed = ['site_name', 'site_url', 'tracking_head', 'tracking_body_start', 'tracking_body_end'];
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  for (const k of allowed) if (req.body && req.body[k] != null) set.run(k, String(req.body[k]));
  res.json({ ok: true });
});

// List redirects.
app.get('/api/redirects', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM redirects ORDER BY from_path').all());
});

// Add a redirect.
app.post('/api/redirects', requireAuth, requireCSRF, (req, res) => {
  const b = req.body || {};
  if (!b.from_path || !b.to_path) return res.status(400).json({ error: 'From and to paths are required' });
  const info = db.prepare('INSERT INTO redirects (from_path, to_path, status) VALUES (?, ?, ?)').run(b.from_path, b.to_path, Number(b.status) || 301);
  res.json({ id: info.lastInsertRowid });
});

// Delete a redirect.
app.delete('/api/redirects/:id', requireAuth, requireCSRF, (req, res) => {
  db.prepare('DELETE FROM redirects WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Media ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// List media.
app.get('/api/media', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, filename, mime, created_at FROM media ORDER BY id DESC').all());
});

// Upload a media file (image via sharp: re-encode and store optimized JPEG/PNG/WebP bytes).
app.post('/api/media', requireAuth, requireCSRF, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    let data = req.file.buffer, mime = req.file.mimetype, filename = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (mime.startsWith('image/')) {
      data = await sharp(req.file.buffer).jpeg({ quality: 82 }).toBuffer();
      mime = 'image/jpeg';
      if (!/\.(jpe?g)$/i.test(filename)) filename = filename.replace(/\.[^.]*$/, '') + '.jpg';
    }
    const info = db.prepare('INSERT INTO media (filename, mime, data) VALUES (?, ?, ?)').run(filename, mime, data);
    res.json({ id: info.lastInsertRowid, filename });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve a media file.
app.get('/media/:id/:name?', (req, res) => {
  const m = db.prepare('SELECT * FROM media WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).send('Not found');
  res.setHeader('Content-Type', m.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  res.send(m.data);
});

// Delete a media file.
app.delete('/api/media/:id', requireAuth, requireCSRF, (req, res) => {
  db.prepare('DELETE FROM media WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Auth routes ----------
// Sign in.
app.post('/api/login', (req, res) => {
  if (!checkLogin((req.body || {}).user, (req.body || {}).pass)) return res.status(401).json({ error: 'Wrong username or password' });
  const token = createSession();
  const csrf = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', [
    `session=${token}; Path=/; HttpOnly; SameSite=Strict`,
    `csrf=${csrf}; Path=/; SameSite=Strict`
  ]);
  res.json({ ok: true });
});

// Sign out.
app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)session=([a-f0-9]+)/.exec(cookie);
  if (m) db.prepare('DELETE FROM sessions WHERE token=?').run(m[1]);
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ ok: true });
});

// ---------- Publish / diff / snapshots / preview ----------
// Build to memory and return the review diff against the last publish.
app.post('/api/publish/review', requireAuth, (req, res) => {
  const site = buildSite(db, {});
  const last = db.prepare("SELECT value FROM settings WHERE key='last_manifest'").get();
  const diff = computeDiff(site.manifest, last ? JSON.parse(last.value) : {});
  res.json(diff);
});

// Publish to Cloudflare Pages.
app.post('/api/publish', requireAuth, requireCSRF, async (req, res) => {
  const site = buildSite(db, {});
  const cfg = {
    accountId: db.prepare("SELECT value FROM settings WHERE key='cf_account_id'").get()?.value || process.env.CF_ACCOUNT_ID,
    apiToken: db.prepare("SELECT value FROM settings WHERE key='cf_api_token'").get()?.value || process.env.CF_API_TOKEN,
    projectName: db.prepare("SELECT value FROM settings WHERE key='cf_project'").get()?.value || process.env.CF_PROJECT
  };
  const result = await publishToCloudflare(db, site, cfg);
  res.json({ ok: true, deploymentId: result.deploymentId, diff: result.diff });
});

// List recent snapshots.
app.get('/api/snapshots', requireAuth, (req, res) => {
  res.json(listSnapshots(db));
});

// Rollback: rebuild from a stored snapshot's manifest (restores last_manifest and republishes).
app.post('/api/rollback/:snapshotId', requireAuth, requireCSRF, async (req, res) => {
  const snap = db.prepare('SELECT * FROM snapshots WHERE id=?').get(req.params.snapshotId);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
  const site = buildSite(db, {});
  const cfg = {
    accountId: db.prepare("SELECT value FROM settings WHERE key='cf_account_id'").get()?.value || process.env.CF_ACCOUNT_ID,
    apiToken: db.prepare("SELECT value FROM settings WHERE key='cf_api_token'").get()?.value || process.env.CF_API_TOKEN,
    projectName: db.prepare("SELECT value FROM settings WHERE key='cf_project'").get()?.value || process.env.CF_PROJECT
  };
  const result = await publishToCloudflare(db, site, cfg);
  res.json({ ok: true, deploymentId: result.deploymentId });
});

// Build the current site to a temp dir and serve it at /preview/:token (draft preview link).
const PREVIEW_TOKEN = process.env.PREVIEW_TOKEN || crypto.randomBytes(12).toString('hex');
app.get('/preview/:token/*', (req, res) => {
  if (req.params.token !== PREVIEW_TOKEN) return res.status(404).send('Not found');
  buildToDir(db, path.join(DATA_DIR, 'preview'));
  const rel = req.params[0] || 'index.html';
  res.sendFile(path.join(DATA_DIR, 'preview', rel), (err) => { if (err) res.status(404).send('Not found'); });
});
app.get('/preview/:token', (req, res) => {
  if (req.params.token !== PREVIEW_TOKEN) return res.status(404).send('Not found');
  buildToDir(db, path.join(DATA_DIR, 'preview'));
  res.sendFile(path.join(DATA_DIR, 'preview', 'index.html'), (err) => { if (err) res.status(404).send('Not found'); });
});

// Get the preview token (signed-in only).
app.get('/api/preview-token', requireAuth, (req, res) => {
  res.json({ url: `/preview/${PREVIEW_TOKEN}/` });
});

// ---------- Static files & admin UI ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.redirect(getSession(req) ? '/admin' : '/login'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Global error handler: always return JSON so the UI shows the real message.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// Wrap async routes so their rejections hit the global error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.listen(PORT, () => console.log(`Site manager running on http://localhost:${PORT}`));
