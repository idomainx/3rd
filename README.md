# Site Manager

A self-hosted website manager (Node + Express + SQLite) that publishes a static site to Cloudflare Pages.

## Run

```
npm install
npm start          # http://localhost:3000
```

Default login: `admin` / `changeme` (override with `ADMIN_USER` / `ADMIN_PASS`).

## Structure (4 JS files)

| File | Purpose |
|---|---|
| `server.js` | SQLite setup, session auth + CSRF, all API routes, draft preview |
| `template-engine.js` | Markdown + `{{var|type|Group/Label|default}}` rendering (lists, entries, if blocks) |
| `build-publish.js` | buildSite, buildToDir, manifest, diff, Cloudflare Pages publish, rollback, snapshots |
| `public/app.js` | Vanilla JS admin UI (templates, entries, media, settings, redirects, publish) |

`admin.html` and `public/app.css` hold the shell and styles.

## Features

- **Templates**: list, create, edit, duplicate, delete, AI instructions; template variables `{{name|text|Group/Label|default}}` render from entry fields; `{{#each list}}`, `{{#entries kind}}`, `{{#if var}}` supported.
- **Entries**: create/edit posts and pages (pages have a raw HTML body), trash/restore, duplicate, bulk actions.
- **Media**: upload with sharp optimization (JPEG re-encode), served from `/media/:id/:name`.
- **Publish**: build to memory, review diff (new/changed/deleted), publish to Cloudflare Pages, snapshots + rollback.
- **Draft preview**: `/preview/:token/` builds and serves the current site (including drafts) without publishing.
- **Settings**: site name, site URL, tracking snippets (head / body start / body end).
- **Redirects**: add/delete entries that become the `_redirects` file on publish.
- **SEO**: per-entry title, description, canonical, noindex, og:image.

## Environment variables

- `PORT` (default 3000)
- `ADMIN_USER`, `ADMIN_PASS` (default admin/changeme)
- `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `CF_PROJECT` — Cloudflare Pages credentials (or set them in Settings)
- `PREVIEW_TOKEN` — fixed token for the preview URL (random per boot otherwise)

## Docker

```
docker build -t site-manager .
docker run -p 3000:3000 site-manager
```
