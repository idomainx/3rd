'use strict';
// Markdown conversion + template rendering for {{var|type|Group/Label|default}}, lists, entries and {{#if}} blocks.
const fs = require('fs');
const { marked } = require('marked');

// Escape text for safe HTML output.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Convert markdown to HTML.
function md(text) {
  return marked.parse(String(text || ''), { breaks: true });
}

// Render a single var spec ("name|type|Group/Label|default") against vars.
function renderSpec(spec, vars) {
  const parts = spec.split('|');
  const name = (parts[0] || '').trim();
  const type = (parts[1] || 'text').trim().toLowerCase();
  let val = vars[name];
  if (val == null) val = parts[3] != null ? parts[3] : '';
  if (['textarea', 'markdown', 'wysiwyg', 'md'].includes(type)) return md(val);
  return esc(val);
}

// Find a matching block; returns the tag name and inner content between the open tag's "}}" and the close token.
function findBlock(tpl, open, close, start) {
  const openIdx = tpl.indexOf(open, start);
  if (openIdx === -1) return null;
  const openBare = open.slice(0, -1);
  const closeBare = close.slice(0, -1);
  // Skip to the end of the open tag: {{#if name}} -> name ends at the next "}}"
  const nameEnd = tpl.indexOf('}}', openIdx);
  if (nameEnd === -1) return null;
  let depth = 1, i = nameEnd + 2;
  while (depth > 0 && i < tpl.length) {
    if (tpl.startsWith(openBare, i) && !tpl.startsWith(closeBare, i)) depth++;
    else if (tpl.startsWith(closeBare, i)) { depth--; if (depth === 0) break; }
    i++;
  }
  if (depth !== 0) return null;
  return { open: openIdx, name: tpl.slice(openIdx + openBare.length, nameEnd).trim(), close: i, end: i + close.length };
}

// Inner content of a found block: from the end of the open tag's "}}" to the close token.
function inner2(tpl, m) {
  return tpl.slice(tpl.indexOf('}}', m.open) + 2, m.close);
}

// Recursively render the template: if blocks, then lists/entries loops, then plain vars.
function render(tpl, vars) {
  vars = vars || {};
  let out = '';
  let pos = 0;
  for (;;) {
    const m = findBlock(tpl, '{{#entries ', '{{/entries}}', pos);
    if (!m) { out += renderIf(tpl.slice(pos), vars); break; }
    out += renderIf(tpl.slice(pos, m.open), vars);
    const kind = m.name.replace(/^["']|["']$/g, '');
    const list = (vars.__entries && vars.__entries[kind]) || [];
    const inner = inner2(tpl, m);
    out += list.map((e) => render(inner, Object.assign({}, vars, { e, item: e }))).join('');
    pos = m.end;
  }
  return out;
}

// Render {{#if name}} blocks (truthy or non-empty array renders the block).
function renderIf(tpl, vars) {
  let out = '';
  let pos = 0;
  for (;;) {
    const m = findBlock(tpl, '{{#if ', '{{/if}}', pos);
    if (!m) { out += renderEach(tpl.slice(pos), vars); break; }
    out += renderEach(tpl.slice(pos, m.open), vars);
    const name = m.name.split('|')[0].trim();
    const v = vars[name];
    if (v && (!Array.isArray(v) || v.length)) out += renderIf(inner2(tpl, m), vars);
    pos = m.end;
  }
  return out;
}

// Render {{#each name}} loops over arrays; inner {{@item.x}} / {{.}} refer to the item.
function renderEach(tpl, vars) {
  let out = '';
  let pos = 0;
  for (;;) {
    const m = findBlock(tpl, '{{#each ', '{{/each}}', pos);
    if (!m) { out += renderVars(tpl.slice(pos), vars); break; }
    out += renderVars(tpl.slice(pos, m.open), vars);
    const name = m.name.trim();
    const list = Array.isArray(vars[name]) ? vars[name] : [];
    const inner = inner2(tpl, m);
    out += list.map((item) => render(inner, Object.assign({}, vars, { item, '@item': item }))).join('');
    pos = m.end;
  }
  return out;
}

// Replace remaining {{var}} tokens, supporting {{@item.field}}, {{@item}}, and {{.}}.
function renderVars(tpl, vars) {
  return tpl.replace(/\{\{[^{}]*\}\}/g, (token) => {
    const name = token.slice(2, -2).split('|')[0].trim();
    if (name === '.') return renderSpec('|' + (vars.item != null ? vars.item : ''), { '': vars.item != null ? vars.item : '' });
    if (name.startsWith('@item.') || name.startsWith('@e.') || name.startsWith('e.')) {
      const key = name.replace(/^@item\.|^@e\.|^e\./, '');
      const src = vars.item || vars.e || {};
      const v = key.split('.').reduce((o, k) => (o == null ? o : o[k]), src);
      return renderSpec('x|' + (token.slice(2, -2).split('|').slice(1).join('|') || 'text') + '|', { x: v });
    }
    if (name === '@item' || name === 'e') return renderSpec('x|' + (token.slice(2, -2).split('|').slice(1).join('|') || 'text') + '|', { x: vars.item != null ? vars.item : vars.e });
    return renderSpec(token.slice(2, -2), vars);
  });
}

// Parse fields declared in a template: {{name|type|Group/Label|default}} (loops and ifs ignored).
function parseFields(tpl) {
  const fields = [];
  const seen = new Set();
  const re = /\{\{([^{}#/][^{}]*?)\}\}/g;
  let m;
  while ((m = re.exec(tpl))) {
    const parts = m[1].split('|');
    const name = (parts[0] || '').trim();
    if (!name || name === '.' || name.startsWith('@') || name.startsWith('e.') || seen.has(name)) continue;
    seen.add(name);
    fields.push({ name, type: (parts[1] || 'text').trim().toLowerCase(), group: (parts[2] || '').split('/')[0].trim() || 'Content', label: (parts[2] || '').split('/')[1] || name, default: parts[3] != null ? parts[3] : '' });
  }
  return fields;
}

module.exports = { esc, md, render, parseFields };
