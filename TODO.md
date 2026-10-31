# TODO — Minimal self-hosted Git platform

Track implementation of the Node.js Git host (Express + SQLite + system `git`).

## Foundation

- [x] `AGENTS.md` — project conventions for agents and contributors
- [x] `TODO.md` — this checklist
- [x] `package.json` — Express, SQLite driver, EJS, JWT; `start` script
- [x] `.gitignore` — `node_modules/`, `storage/`, `*.db`, env files

## Database & models (`models.js`)

- [x] SQLite schema: `users` (`id`, `username`, `password_hash`)
- [x] SQLite schema: `repositories` (`id`, `name`, `owner_id`, `is_private`, `description`)
- [x] Unique `(owner_id, name)` and unique `username`
- [x] Open/create DB at a known path; create `storage/` if missing
- [x] CRUD: create/find user, create/list/get repository
- [x] Seed a default local user for first-run dashboard use
- [x] User profile columns (`display_name`, `email`, `bio`, `default_private`) with in-place migration
- [x] `token_version` for revoking JWTs after a password change; unique non-empty email index

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

- [x] Express app: static/views, JWT auth, JSON/urlencoded **after** Git routes
- [x] `GET /dashboard` — public repos + create-repository form
- [x] `POST /create` — persist metadata + `createBareRepo`
- [x] `GET /:owner/:repo` — name, clone URL, root tree listing
- [x] Minimal HTML + Tailwind CDN
- [x] Auth pages (register/login/logout) so `password_hash` is used
- [x] Replace `express-session` with a stateless JWT auth cookie (`jsonwebtoken`)
- [x] Short-lived signed JWT flash messages; logout clears the auth cookie
- [x] Private repos hidden from anonymous dashboard; owner can still open them
- [x] `GET /settings` account page with display name, email, bio, and default repo visibility
- [x] `POST /settings/profile` with validation and unique email enforcement
- [x] `POST /settings/password` verifies the current password and rotates the JWT token version
- [x] Header shows display name and links to account settings

## Repository management

- [x] Owner-only **Delete repository** action that removes the DB row and bare dir
- [x] Delete confirmation requires typing the exact repository name
- [x] Refuse to delete paths outside `storage/repos/`; prune empty owner dir

## Commit history (Gitea/GitHub-style)

- [x] `git log` parser in `gitCore.js` (author, email, relative date, short SHA)
- [x] `GET /:owner/:repo/commits` with date-grouped list and pagination
- [x] Recent commits summary on the repository landing page
- [x] Commit detail page `GET /:owner/:repo/commit/:sha` with changed files + patch
- [x] Branch selector on code and commits pages; commit detail links back to history

## Code browsing

- [x] Browse subdirectories inside a branch (`?path=`) with breadcrumbs and parent link
- [x] File (blob) view with line numbers, binary/size guards
- [x] Raw file download endpoint
- [x] Branches page listing local branches with default badge
- [x] Repository tab bar (Code / Commits / Branches) shared across repo pages
- [x] Dashboard search filter and per-repo latest-activity summary

## SSH transport

- [x] Embedded SSH server (`ssh2`) started alongside Express on `SSH_PORT` (default `2222`)
- [x] Persist a generated host key under `storage/` and keep it out of git
- [x] `git-upload-pack` / `git-receive-pack` over SSH via system `git` (no shell)
- [x] Public-key authentication stored in SQLite (`ssh_keys` table)
- [x] Password authentication fallback using the existing scrypt hash
- [x] Owner-only push; private repos readable only by their owner
- [x] `/settings/ssh` page to add, list, and delete keys (fingerprints shown)
- [x] SSH clone URL shown next to the HTTP URL on the repo page
- [x] Reject arbitrary exec/shell/subsystem requests and malformed repo paths
- [x] Clean errors and exit codes when the repo is missing or access is denied

## Verification

- [x] App starts (`npm start`) with `git` on PATH
- [x] Create repo in UI, clone URL works with `git clone` / `git push` over HTTP
- [x] Empty repo landing page does not crash
- [x] Missing owner/repo returns a clean 404
- [x] Delete removes the DB row + bare dir; wrong confirmation is rejected
- [x] Commit history, commit detail, branches, blob, and raw pages render
- [x] Path traversal attempts in `?path=` are rejected
- [x] Invalid branch and commit ids return a clean error
- [x] SSH clone, push, and re-clone work with an OpenSSH client and a registered key
- [x] SSH password auth works; non-Git commands and traversal paths are rejected
- [x] Non-owner push and private-repo fetch over SSH are denied
- [x] SSH key add/list/delete UI and fingerprint display work
