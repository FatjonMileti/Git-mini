# Agent instructions — Gitea clone (minimal Git host)

This repo is a self-contained Node.js Git hosting app. Prefer small, commented modules over new frameworks.

## Stack (do not replace)

- **HTTP:** Express
- **DB:** SQLite via `better-sqlite3` (no Prisma unless asked)
- **Git:** system `git` through `child_process` only — never `nodegit`, `isomorphic-git` as the server store, or other native Git bindings
- **UI:** EJS views + Tailwind CDN (no React/Vite)

## Layout

| File | Role |
|------|------|
| `server.js` | App entry: middleware order, web routes, listen |
| `models.js` | SQLite schema + user/repo queries |
| `gitCore.js` | Bare repo paths, `git init --bare`, `ls-tree` for the UI |
| `gitHttp.js` | Git Smart HTTP (`info/refs`, receive-pack, upload-pack) |
| `views/` | Dashboard and repo landing pages |
| `storage/repos/` | On-disk bare repos (`<owner>/<name>.git`) — gitignore this |

## Non-negotiable Git HTTP behavior

1. Mount the Git router **before** `express.json()` / `urlencoded` so pack POST bodies stay raw streams.
2. Pipe `req` → git stdin and git stdout → `res`. Do not buffer pack data into strings.
3. Advertise-refs responses must use pkt-line service headers (`001e` upload-pack / `001f` receive-pack) plus a `0000` flush, then the process stdout.
4. Support clone URLs with or without a `.git` suffix.
5. Sanitize `owner` / `repo` (no `..`, no path separators). Missing bare dirs → 404, not a shell error leak.

## Data rules

- `users.username` unique; `repositories` unique per `(owner_id, name)`.
- Hash passwords with `node:crypto` (scrypt); never store plaintext.
- Private repos: not listed on `/dashboard` for other users; Git HTTP may still be open locally unless auth is wired on those routes.

## Workflow

- Keep production-minded error handling (missing folders, missing `git`, spawn failures).
- Do not commit `storage/`, `*.db`, or `node_modules/`.
- Do not add C++ Git bindings or rewrite the Git protocol in pure JS without an explicit request.
