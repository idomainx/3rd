'use strict';
// Site build (to memory or disk), manifest, diff review, snapshots, Cloudflare Pages publish and rollback.
const fs = require('fs');
const path = require('path');
const { render, md, esc } = require('./template-engine');

// Build all published entries into files; returns { pages: [{path, html}], redirects, manifest }.
// Uses db: templates(name, html, ai_instructions), entries(id, kind, title, slug, body, fields, template_name, status, seo_*), settings, redirects.
function buildSite(db, opts) {
  opts = opts || {};
  const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
  const siteName = getSetting('site_name', 'My Site');
  const siteUrl = getSetting('site_url', '');
  const tracking = { head: getSetting('tracking_head', ''), bodyStart: getSetting('tracking_body_start', ''), bodyEnd: getSetting('tracking_body_end', '') };
  const redirects = db.prepare('SELECT * FROM redirects').all();
  const published = db.prepare("SELECT * FROM entries WHERE status='published'").all();
  const templates = {};
  for (const t of db.prepare('SELECT * FROM templates').all()) templates[t.name] = t;
  const byKind = {};
  for (const e of published) { const k = e.kind; (byKind[k] = byKind[k] || []).push(e); }

  const pages = [];
  for (const e of published) {
    const tpl = templates[e.template_name];
    let content = '';
    if (e.kind === 'page') {
      content = tpl ? render(tpl.html, buildVars(e, byKind, tracking)) : (e.body || '');
    } else {
      content = e.body || '';
      if (tpl) content = render(tpl.html, buildVars(e, byKind, tracking));
    }
    const html = fullPage({ title: e.title, content, e, siteName, siteUrl, tracking });
    const p = e.kind === 'page' ? (e.slug === 'index' ? 'index.html' : e.slug + '/index.html') : (e.kind + '/' + e.slug + '/index.html');
    pages.push({ path: p, html });
  }
  if (!pages.some((p) => p.path === 'index.html') && byKind.page) {
    const home = byKind.page.find((e) => e.slug === 'index');
    // index page was already emitted above when slug === 'index'
    void home;
  }
  const manifest = makeManifest(pages);
  return { pages, redirects, manifest, siteName };
}

// Collect template vars for an entry: its fields plus body/title plus global {{entries:kind}} lists.
function buildVars(e, byKind, tracking) {
  let fields = {};
  try { fields = JSON.parse(e.fields || '{}'); } catch (_) {}
  const vars = Object.assign({}, fields, { title: e.title, body: e.kind === 'page' ? (e.body || '') : md(e.body || ''), slug: e.slug, kind: e.kind });
  vars.entries = byKind; // allows {{#each entries.blog}}
  vars.tracking = tracking;
  return vars;
}

// Wrap content in a full HTML document with SEO meta injected.
function fullPage(o) {
  const seo = injectSEO(o.e, o.siteUrl, o.siteName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(seo.title)}</title>
${seo.description ? `<meta name="description" content="${esc(seo.description)}">` : ''}
${seo.canonical ? `<link rel="canonical" href="${esc(seo.canonical)}">` : ''}
${seo.noindex ? '<meta name="robots" content="noindex">' : ''}
${seo.ogImage ? `<meta property="og:image" content="${esc(seo.ogImage)}"><meta property="og:title" content="${esc(seo.title)}">` : ''}
${o.tracking.head || ''}
</head>
<body>
${o.tracking.bodyStart || ''}
${o.content}
${o.tracking.bodyEnd || ''}
</body>
</html>`;
}

// Keep only the SEO extras we still support: title, description, canonical, noindex, og image.
function injectSEO(e, siteUrl, siteName) {
  let fields = {};
  try { fields = JSON.parse(e.fields || '{}'); } catch (_) {}
  const title = (fields.seo_title || e.title || '') + (siteName ? ' — ' + siteName : '');
  return {
    title,
    description: fields.seo_description || '',
    canonical: siteUrl ? siteUrl.replace(/\/$/, '') + '/' + (e.slug === 'index' ? '' : e.slug) : '',
    noindex: !!fields.seo_noindex,
    ogImage: fields.seo_og_image || ''
  };
}

// Build the site into a directory on disk (used for preview and snapshots).
function buildToDir(db, dir) {
  const site = buildSite(db, {});
  fs.mkdirSync(dir, { recursive: true });
  for (const p of site.pages) {
    const f = path.join(dir, p.path);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, p.html);
  }
  if (site.redirects.length) {
    fs.writeFileSync(path.join(dir, '_redirects'), site.redirects.map((r) => `${r.from} ${r.to} ${r.status || 301}`).join('\n') + '\n');
  }
  return site;
}

// Snapshot map path->hash of built files, used for new/changed/deleted review.
function makeManifest(pages) {
  const crypto = require('crypto');
  const manifest = {};
  for (const p of pages) manifest[p.path] = crypto.createHash('sha256').update(p.html).digest('hex').slice(0, 16);
  return manifest;
}

// Compare a new manifest with the previously published one; returns {new:[], changed:[], deleted:[]}.
function computeDiff(newManifest, oldManifest) {
  oldManifest = oldManifest || {};
  const diff = { added: [], changed: [], deleted: [] };
  for (const p of Object.keys(newManifest)) {
    if (!(p in oldManifest)) diff.added.push(p);
    else if (oldManifest[p] !== newManifest[p]) diff.changed.push(p);
  }
  for (const p of Object.keys(oldManifest)) if (!(p in newManifest)) diff.deleted.push(p);
  return diff;
}

// Publish a build to Cloudflare Pages via the direct-upload API; records a snapshot row.
async function publishToCloudflare(db, site, cfg) {
  if (!cfg.accountId || !cfg.apiToken || !cfg.projectName) throw new Error('Cloudflare Pages is not configured (account ID, API token, project name)');
  // Create a deployment and upload files
  const boundary = '----bolt' + Date.now();
  const manifestPart = `${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(site.manifest)}\r\n`;
  let filesPart = '';
  for (const p of site.pages) {
    filesPart += `${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${p.path}"\r\nContent-Type: text/html\r\n\r\n${p.html}\r\n`;
  }
  const body = filesPart + manifestPart + `${boundary}--\r\n`;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/pages/projects/${encodeURIComponent(cfg.projectName)}/deployments`, {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary.slice(2), 'Authorization': 'Bearer ' + cfg.apiToken },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error('Cloudflare publish failed: ' + ((data.errors && data.errors[0] && data.errors[0].message) || res.status));
  const deploymentId = data.result && data.result.id;
  const info = db.prepare("SELECT value FROM settings WHERE key='last_manifest'").get();
  const oldManifest = info ? JSON.parse(info.value) : {};
  const diff = computeDiff(site.manifest, oldManifest);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('last_manifest', ?)").run(JSON.stringify(site.manifest));
  db.prepare('INSERT INTO snapshots (deployment_id, created_at) VALUES (?, ?)').run(deploymentId || '', new Date().toISOString());
  return { deploymentId, diff };
}

// Return stored snapshots so the UI can offer a rollback.
function listSnapshots(db) {
  return db.prepare('SELECT * FROM snapshots ORDER BY id DESC LIMIT 50').all();
}

module.exports = { buildSite, buildToDir, makeManifest, computeDiff, publishToCloudflare, listSnapshots, injectSEO };
