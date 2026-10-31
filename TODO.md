# TODO — Minimal self-hosted Git platform

Track implementation of the Node.js Git host (Express + SQLite + system `git`).

## Foundation

- [x] `AGENTS.md` — project conventions for agents and contributors
- [x] `TODO.md` — this checklist
- [x] `package.json` — Express, SQLite driver, EJS, session; `start` script
- [x] `.gitignore` — `node_modules/`, `storage/`, `*.db`, env files

## Database & models (`models.js`)

- [x] SQLite schema: `users` (`id`, `username`, `password_hash`)
- [x] SQLite schema: `repositories` (`id`, `name`, `owner_id`, `is_private`, `description`)
- [x] Unique `(owner_id, name)` and unique `username`
- [x] Open/create DB at a known path; create `storage/` if missing
- [x] CRUD: create/find user, create/list/get repository
- [x] Seed a default local user for first-run dashboard use

## Git core (`gitCore.js`)

- [x] `createBareRepo(owner, repoName)` → `./storage/repos/<owner>/<repoName>.git` + `git init --bare`
- [x] Enable `http.receivepack` / `http.uploadpack` on new bare repos
- [x] `getRepoPath(owner, repoName)` with path sanitization (no traversal)
- [x] `getRepoFiles(owner, repoName, branch)` via `git ls-tree` (empty repo → empty list)
- [x] Resolve default branch (`HEAD` / `main` / `master`) when branch omitted
- [x] Error handling for missing directories and missing `git` binary

## Smart HTTP (`gitHttp.js`)

- [x] Strip optional `.git` suffix from `:repo`
- [x] `GET /repos/:owner/:repo/info/refs` — advertise-refs for `git-upload-pack` / `git-receive-pack`
- [x] Correct `Content-Type: application/x-git-<service>-advertisement`
- [x] pkt-line service prefix + `0000` flush, then git stdout
- [x] `POST /repos/:owner/:repo/git-receive-pack` — stdin/stdout pipe, result Content-Type
- [x] `POST /repos/:owner/:repo/git-upload-pack` — stdin/stdout pipe, result Content-Type
- [x] No body parser on Git POST routes; handle `Content-Encoding: gzip`
- [x] 404 when the bare repo folder does not exist

## Web dashboard (`server.js` & views)

- [x] Express app: static/views, sessions, JSON/urlencoded **after** Git routes
- [x] `GET /dashboard` — public repos + create-repository form
- [x] `POST /create` — persist metadata + `createBareRepo`
- [x] `GET /:owner/:repo` — name, clone URL, root tree listing
- [x] Minimal HTML + Tailwind CDN
- [x] Auth pages (register/login/logout) so `password_hash` is used
- [x] Private repos hidden from anonymous dashboard; owner can still open them

## Verification

- [x] App starts (`npm start`) with `git` on PATH
- [x] Create repo in UI, clone URL works with `git clone` / `git push` over HTTP
- [x] Empty repo landing page does not crash
- [x] Missing owner/repo returns a clean 404
