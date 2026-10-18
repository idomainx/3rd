'use strict';
// Admin UI: vanilla JS single-page app (login, templates, entries editor, media, settings, redirects, publish).
const $ = (sel, el) => (el || document).querySelector(sel);
const root = $('#root');

// Read the CSRF token from the cookie.
function csrf() {
  const m = /(?:^|;\s*)csrf=([a-f0-9]+)/.exec(document.cookie);
  return m ? m[1] : '';
}

// JSON fetch wrapper that surfaces server error messages.
async function api(path, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json', 'X-CSRF-Token': csrf() }, opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Escape HTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Simple toast notification.
function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' toast-err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ---------- Routing ----------
let route = { page: 'entries' };

// Render the current route.
function navigate(page, params) {
  route = { page, params: params || {} };
  render();
}

// ---------- Login screen ----------
function renderLogin() {
  root.innerHTML = `<div class="login-card"><h1>Site Manager</h1>
    <form id="login-form">
      <input name="user" placeholder="Username" autocomplete="username" required>
      <input name="pass" type="password" placeholder="Password" autocomplete="current-password" required>
      <button class="btn btn-primary" type="submit">Sign in</button>
    </form></div>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { method: 'POST', body: { user: e.target.user.value, pass: e.target.pass.value } });
      render();
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- Shell ----------
function shell(content) {
  root.innerHTML = `<div class="layout">
    <nav class="sidebar">
      <div class="brand">Site Manager</div>
      ${[['entries', 'Entries'], ['templates', 'Templates'], ['media', 'Media'], ['settings', 'Settings'], ['publish', 'Publish']]
        .map(([id, label]) => `<a href="#/${id}" class="${route.page === id ? 'active' : ''}">${label}</a>`).join('')}
      <button id="logout" class="btn btn-ghost">Sign out</button>
    </nav>
    <main class="main">${content}</main></div>`;
  $('#logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); renderLogin(); };
  root.querySelectorAll('.sidebar a').forEach((a) => (a.onclick = (e) => { e.preventDefault(); navigate(a.getAttribute('href').slice(2)); }));
}

// ---------- Entries list ----------
async function renderEntries() {
  const trash = route.params.trash;
  const rows = await api('/api/entries' + (trash ? '?status=trash' : ''));
  shell(`<div class="toolbar">
      <h1>${trash ? 'Trash' : 'Entries'}</h1>
      <div class="toolbar-actions">
        ${trash ? '' : `<select id="new-kind"><option value="post">Post</option><option value="page">Page</option></select>
        <button id="new-entry" class="btn btn-primary">New</button>`}
        ${trash ? `<button id="back" class="btn">Back</button>` : `<button id="view-trash" class="btn btn-ghost">Trash</button>`}
      </div></div>
    <div id="bulk-bar" class="bulk-bar hidden">
      <select id="bulk-action"><option value="publish">Publish</option><option value="trash">Trash</option><option value="restore">Restore</option><option value="delete">Delete forever</option></select>
      <button id="bulk-apply" class="btn">Apply</button>
    </div>
    <table class="list"><thead><tr><th></th><th>Title</th><th>Kind</th><th>Status</th><th>Updated</th><th></th></tr></thead>
    <tbody>${rows.map((e) => `<tr>
      <td><input type="checkbox" class="row-check" data-id="${e.id}"></td>
      <td><a href="#/entry/${e.id}" class="entry-link">${esc(e.title)}</a></td>
      <td>${esc(e.kind)}</td><td><span class="badge badge-${e.status}">${esc(e.status)}</span></td>
      <td>${esc(e.updated_at)}</td>
      <td class="row-actions">
        ${trash ? `<button class="btn btn-sm act-restore" data-id="${e.id}">Restore</button>` : `<button class="btn btn-sm act-dup" data-id="${e.id}">Duplicate</button><button class="btn btn-sm act-trash" data-id="${e.id}">Trash</button>`}
      </td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nothing here yet</td></tr>'}</tbody></table>`);
  if ($('#new-entry')) $('#new-entry').onclick = async () => {
    const kind = $('#new-kind').value;
    const e = await api('/api/entries', { method: 'POST', body: { kind, title: 'Untitled ' + kind, kind } });
    navigate('entry', { id: e.id });
  };
  if ($('#view-trash')) $('#view-trash').onclick = () => navigate('entries', { trash: true });
  if ($('#back')) $('#back').onclick = () => navigate('entries');
  const checks = () => [...root.querySelectorAll('.row-check:checked')].map((c) => Number(c.dataset.id));
  root.querySelectorAll('.row-check').forEach((c) => (c.onchange = () => $('#bulk-bar').classList.toggle('hidden', !checks().length)));
  if ($('#bulk-apply')) $('#bulk-apply').onclick = async () => {
    try { await api('/api/entries/bulk', { method: 'POST', body: { action: $('#bulk-action').value, ids: checks() } }); render(); }
    catch (err) { toast(err.message, true); }
  };
  root.querySelectorAll('.act-trash').forEach((b) => (b.onclick = async () => { await api('/api/entries/' + b.dataset.id, { method: 'DELETE' }); render(); }));
  root.querySelectorAll('.act-restore').forEach((b) => (b.onclick = async () => { await api('/api/entries/' + b.dataset.id + '/restore', { method: 'POST' }); render(); }));
  root.querySelectorAll('.act-dup').forEach((b) => (b.onclick = async () => { await api('/api/entries/' + b.dataset.id + '/duplicate', { method: 'POST' }); render(); }));
}

// ---------- Entry editor ----------
// Render the editor's dynamic fields from the template definition plus SEO fields.
function editorFields(entry, tplFields) {
  let saved = {};
  try { saved = JSON.parse(entry.fields || '{}'); } catch (_) {}
  const f = (fld) => {
    const val = saved[fld.name] != null ? saved[fld.name] : fld.default;
    if (fld.type === 'textarea' || fld.type === 'markdown') return `<label>${esc(fld.label)}<textarea class="field" data-field="${esc(fld.name)}" rows="6">${esc(val)}</textarea></label>`;
    if (fld.type === 'image') return `<label>${esc(fld.label)}<input class="field" data-field="${esc(fld.name)}" value="${esc(val)}" placeholder="media URL"></label>`;
    return `<label>${esc(fld.label)}<input class="field" data-field="${esc(fld.name)}" value="${esc(val)}"></label>`;
  };
  const seo = `<details><summary>SEO</summary>
    <label>SEO title<input class="field" data-field="seo_title" value="${esc(saved.seo_title || '')}"></label>
    <label>Meta description<input class="field" data-field="seo_description" value="${esc(saved.seo_description || '')}"></label>
    <label>OG image URL<input class="field" data-field="seo_og_image" value="${esc(saved.seo_og_image || '')}"></label>
    <label class="check"><input type="checkbox" class="field" data-field="seo_noindex" type="checkbox" ${saved.seo_noindex ? 'checked' : ''}> noindex</label></details>`;
  return (tplFields || []).map(f).join('') + seo;
}

async function renderEntryEditor() {
  const entry = await api('/api/entries/' + route.params.id);
  const templates = await api('/api/templates');
  const tpl = templates.find((t) => t.name === entry.template_name);
  const tplFields = tpl ? tpl.fields : [];
  const isPage = entry.kind === 'page';
  shell(`<div class="toolbar"><h1>Edit ${esc(entry.kind)}</h1>
      <div class="toolbar-actions">
        <button id="save" class="btn btn-primary">Save</button>
        <select id="status"><option value="draft" ${entry.status === 'draft' ? 'selected' : ''}>Draft</option><option value="published" ${entry.status === 'published' ? 'selected' : ''}>Published</option></select>
        <button id="back" class="btn btn-ghost">Back</button>
      </div></div>
    <form id="entry-form" class="editor">
      <label>Title<input id="title" value="${esc(entry.title)}"></label>
      <label>Slug<input id="slug" value="${esc(entry.slug)}"></label>
      ${isPage ? `<label>HTML (page content)<textarea id="body" class="code" rows="18">${esc(entry.body || '')}</textarea></label>`
               : `<label>Content (Markdown)<textarea id="body" rows="14">${esc(entry.body || '')}</textarea></label>`}
      <label>Template<select id="template"><option value="">(none)</option>
        ${templates.map((t) => `<option value="${esc(t.name)}" ${t.name === entry.template_name ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <div id="dyn-fields">${editorFields(entry, tplFields)}</div>
    </form>
    <section class="preview"><h2>Preview</h2><div id="preview-box"></div></section>`);
  $('#back').onclick = () => navigate('entries');
  $('#save').onclick = async () => {
    const fields = {};
    root.querySelectorAll('.field').forEach((el) => { fields[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value; });
    try {
      await api('/api/entries/' + entry.id, { method: 'PUT', body: {
        title: $('#title').value, slug: $('#slug').value, body: $('#body').value, fields, status: $('#status').value, template_name: $('#template').value || null
      } });
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  };
  // Live-ish preview: render markdown or raw HTML into the preview box.
  const updatePreview = () => { $('#preview-box').innerHTML = isPage ? $('#body').value : '<div class="md-preview">' + ($('#body').value || '') + '</div>'; };
  $('#body').oninput = updatePreview;
  updatePreview();
  $('#template').onchange = () => render(); // re-render to show the new template's fields
}

// ---------- Templates ----------
async function renderTemplates() {
  const rows = await api('/api/templates');
  shell(`<div class="toolbar"><h1>Templates</h1><button id="new-tpl" class="btn btn-primary">New template</button></div>
    <table class="list"><thead><tr><th>Name</th><th>Fields</th><th></th></tr></thead><tbody>
    ${rows.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.fields.map((f) => esc(f.name)).join(', ') || '—'}</td>
      <td class="row-actions"><button class="btn btn-sm t-edit" data-id="${t.id}">Edit</button><button class="btn btn-sm t-dup" data-id="${t.id}">Duplicate</button><button class="btn btn-sm t-del" data-id="${t.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No templates</td></tr>'}
    </tbody></table>`);
  $('#new-tpl').onclick = async () => {
    try { const t = await api('/api/templates', { method: 'POST', body: { name: 'new-template', html: '<h1>{{title}}</h1>\n{{content|markdown|Content/Body|}}' } }); navigate('template', { id: t.id }); }
    catch (err) { toast(err.message, true); }
  };
  root.querySelectorAll('.t-edit').forEach((b) => (b.onclick = () => navigate('template', { id: b.dataset.id })));
  root.querySelectorAll('.t-dup').forEach((b) => (b.onclick = async () => { await api('/api/templates/' + b.dataset.id + '/duplicate', { method: 'POST' }); render(); }));
  root.querySelectorAll('.t-del').forEach((b) => (b.onclick = async () => {
    if (confirm('Delete this template?')) { await api('/api/templates/' + b.dataset.id, { method: 'DELETE' }); render(); }
  }));
}

async function renderTemplateEditor() {
  const list = await api('/api/templates');
  const t = list.find((x) => String(x.id) === String(route.params.id));
  shell(`<div class="toolbar"><h1>Edit template</h1>
      <div class="toolbar-actions"><button id="save" class="btn btn-primary">Save</button><button id="back" class="btn btn-ghost">Back</button></div></div>
    ${t ? `<form class="editor">
      <label>Name<input id="tpl-name" value="${esc(t.name)}"></label>
      <label>HTML<textarea id="tpl-html" class="code" rows="20">${esc(t.html)}</textarea></label>
      <label>AI instructions<textarea id="tpl-ai" rows="4" placeholder="How an AI should fill this template"></textarea></label>
      <div class="field-list"><strong>Fields detected:</strong> ${t.fields.map((f) => `<code>${esc(f.name)}</code>`).join(' ') || 'none'}</div>
    </form>` : '<p class="empty">Template not found</p>'}`);
  if ($('#tpl-ai')) $('#tpl-ai').value = t.ai_instructions || '';
  if ($('#save')) $('#save').onclick = async () => {
    try { await api('/api/templates/' + route.params.id, { method: 'PUT', body: { name: $('#tpl-name').value, html: $('#tpl-html').value, ai_instructions: $('#tpl-ai').value } }); toast('Saved'); render(); }
    catch (err) { toast(err.message, true); }
  };
  if ($('#back')) $('#back').onclick = () => navigate('templates');
}

// ---------- Media ----------
async function renderMedia() {
  const rows = await api('/api/media');
  shell(`<div class="toolbar"><h1>Media</h1>
      <input type="file" id="file-input" class="hidden">
      <button id="upload" class="btn btn-primary">Upload</button></div>
    <div class="media-grid">${rows.map((m) => `<figure class="media-card" data-id="${m.id}">
      ${m.mime.startsWith('image') ? `<img src="/media/${m.id}/${esc(m.filename)}" alt="${esc(m.filename)}">` : '<div class="file-icon">FILE</div>'}
      <figcaption>${esc(m.filename)}</figcaption>
      <button class="btn btn-sm m-del">Delete</button></figure>`).join('') || '<p class="empty">No media yet</p>'}</div>`);
  $('#upload').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/media', { method: 'POST', body: fd, headers: { 'X-CSRF-Token': csrf() } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      toast('Uploaded');
      render();
    } catch (err) { toast(err.message, true); }
  };
  root.querySelectorAll('.m-del').forEach((b) => (b.onclick = async () => {
    await api('/api/media/' + b.closest('.media-card').dataset.id, { method: 'DELETE' }); render();
  }));
}

// ---------- Settings + redirects ----------
async function renderSettings() {
  const s = await api('/api/settings');
  const redirects = await api('/api/redirects');
  shell(`<div class="toolbar"><h1>Settings</h1><button id="save" class="btn btn-primary">Save</button></div>
    <form class="editor">
      <label>Site name<input id="site_name" value="${esc(s.site_name || '')}"></label>
      <label>Site URL<input id="site_url" value="${esc(s.site_url || '')}" placeholder="https://example.com"></label>
      <label>Tracking: head<textarea id="tracking_head" class="code" rows="3">${esc(s.tracking_head || '')}</textarea></label>
      <label>Tracking: body start<textarea id="tracking_body_start" class="code" rows="3">${esc(s.tracking_body_start || '')}</textarea></label>
      <label>Tracking: body end<textarea id="tracking_body_end" class="code" rows="3">${esc(s.tracking_body_end || '')}</textarea></label>
    </form>
    <section><h2>Redirects</h2>
      <div class="toolbar"><input id="r-from" placeholder="/old-path"><input id="r-to" placeholder="/new-path"><button id="r-add" class="btn">Add</button></div>
      <table class="list"><tbody>${redirects.map((r) => `<tr><td>${esc(r.from_path)}</td><td>${esc(r.to_path)}</td><td>${r.status}</td>
        <td><button class="btn btn-sm r-del" data-id="${r.id}">Delete</button></td></tr>`).join('') || '<tr><td class="empty">No redirects</td></tr>'}</tbody></table>
    </section>`);
  $('#save').onclick = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: {
        site_name: $('#site_name').value, site_url: $('#site_url').value,
        tracking_head: $('#tracking_head').value, tracking_body_start: $('#tracking_body_start').value, tracking_body_end: $('#tracking_body_end').value
      } });
      toast('Saved');
    } catch (err) { toast(err.message, true); }
  };
  $('#r-add').onclick = async () => {
    try { await api('/api/redirects', { method: 'POST', body: { from_path: $('#r-from').value, to_path: $('#r-to').value } }); render(); }
    catch (err) { toast(err.message, true); }
  };
  root.querySelectorAll('.r-del').forEach((b) => (b.onclick = async () => { await api('/api/redirects/' + b.dataset.id, { method: 'DELETE' }); render(); }));
}

// ---------- Publish ----------
async function renderPublish() {
  shell(`<div class="toolbar"><h1>Publish</h1><button id="review" class="btn">Review changes</button><button id="publish" class="btn btn-primary">Publish to Cloudflare</button></div>
    <div id="review-box"></div>
    <section><h2>Snapshots</h2><table class="list"><tbody id="snaps"></tbody></table></section>
    <section><h2>Draft preview</h2><p id="preview-link">Loading…</p></section>`);
  $('#publish').onclick = async () => {
    try { const r = await api('/api/publish', { method: 'POST' }); toast('Published' + (r.deploymentId ? ' (' + r.deploymentId + ')' : '')); render(); }
    catch (err) { toast(err.message, true); }
  };
  $('#review').onclick = async () => {
    try {
      const d = await api('/api/publish/review', { method: 'POST' });
      $('#review-box').innerHTML = `<div class="diff">
        <h3>New (${d.added.length})</h3><ul>${d.added.map((p) => `<li>${esc(p)}</li>`).join('') || '<li class="empty">none</li>'}</ul>
        <h3>Changed (${d.changed.length})</h3><ul>${d.changed.map((p) => `<li>${esc(p)}</li>`).join('') || '<li class="empty">none</li>'}</ul>
        <h3>Deleted (${d.deleted.length})</h3><ul>${d.deleted.map((p) => `<li>${esc(p)}</li>`).join('') || '<li class="empty">none</li>'}</ul></div>`;
    } catch (err) { toast(err.message, true); }
  };
  const snaps = await api('/api/snapshots');
  $('#snaps').innerHTML = snaps.map((s) => `<tr><td>#${s.id}</td><td>${esc(s.deployment_id || '(local)')}</td><td>${esc(s.created_at)}</td>
    <td><button class="btn btn-sm rb" data-id="${s.id}">Rollback</button></td></tr>`).join('') || '<tr><td class="empty">No snapshots</td></tr>';
  root.querySelectorAll('.rb').forEach((b) => (b.onclick = async () => {
    try { await api('/api/rollback/' + b.dataset.id, { method: 'POST' }); toast('Rolled back'); }
    catch (err) { toast(err.message, true); }
  }));
  const pv = await api('/api/preview-token');
  $('#preview-link').innerHTML = `<a href="${esc(pv.url)}" target="_blank">${esc(pv.url)}</a>`;
}

// ---------- Render dispatch ----------
async function render() {
  try {
    let authed = true;
    try { await api('/api/entries'); } catch (_) { authed = false; }
    if (!authed) return renderLogin();
    if (route.page === 'entries') await renderEntries();
    else if (route.page === 'entry') await renderEntryEditor();
    else if (route.page === 'templates') await renderTemplates();
    else if (route.page === 'template') await renderTemplateEditor();
    else if (route.page === 'media') await renderMedia();
    else if (route.page === 'settings') await renderSettings();
    else if (route.page === 'publish') await renderPublish();
  } catch (err) { toast(err.message, true); }
}

window.addEventListener('hashchange', () => {
  const parts = location.hash.replace(/^#\//, '').split('/');
  navigate(parts[0] || 'entries', { id: parts[1] });
});

render();
