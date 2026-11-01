# Agent instructions — Gitea clone (minimal Git host)

This repo is a self-contained Node.js Git hosting app. Prefer small, commented modules over new frameworks.

## Stack (do not replace)

- **HTTP:** Express
- **DB:** SQLite via `better-sqlite3` (no Prisma unless asked)
- **Git:** system `git` through `child_process` only — never `nodegit`, `isomorphic-git` as the server store, or other native Git bindings
- **UI:** EJS views + Tailwind CDN (no React/Vite)
- **SSH:** `ssh2` (pure-JS) for embedded Git SSH server
- **Auth:** `jsonwebtoken` for stateless JWT cookies
- **Docs:** `swagger-ui-express` + `yamljs` for OpenAPI 3.0 UI

## Layout

| File | Role |
|------|------|
| `server.js` | App entry: middleware order, web routes, Git HTTP/SSH bootstrap, Swagger UI |
| `models.js` | SQLite schema + user/repo/SSH key queries |
| `gitCore.js` | Bare repo paths, `git init --bare`, `ls-tree` for the UI |
| `gitHttp.js` | Git Smart HTTP (`info/refs`, receive-pack, upload-pack) |
| `sshCore.js` | SSH server, public-key/password auth, pack command spawn |
| `config.js` | HTTP/SSH ports, storage paths, JWT secret, env defaults |
| `views/` | Dashboard, repo landing, commit history, code browsing, settings |
| `swagger.yaml` | OpenAPI 3.0 spec (served at `/swagger.yaml`, UI at `/docs`) |
| `FLOW.md` | Project flow documentation |
| `storage/repos/` | On-disk bare repos (`<owner>/<name>.git`) — gitignore this |
| `storage/ssh_host_ed25519_key` | SSH host key (auto-generated) — gitignore this |

## Non-negotiable Git HTTP behavior

1. Mount the Git router **before** `express.json()` / `urlencoded` so pack POST bodies stay raw streams.
2. Pipe `req` → git stdin and git stdout → `res`. Do not buffer pack data into strings.
3. Advertise-refs responses must use pkt-line service headers (`001e` upload-pack / `001f` receive-pack) plus a `0000` flush, then the process stdout.
4. Support clone URLs with or without a `.git` suffix.
5. Sanitize `owner` / `repo` (no `..`, no path separators). Missing bare dirs → 404, not a shell error leak.

## SSH behavior

- Embedded `ssh2` server on `SSH_PORT` (default 2222), started after HTTP listen.
- Only `git-upload-pack` and `git-receive-pack` are accepted; shell/pty/subsystem/arbitrary exec rejected.
- Public-key auth via registered fingerprints (`ssh_keys` table); password auth via web scrypt hash.
- Owner-only push; private repos fetchable only by owner.
- Host key auto-generated at `storage/ssh_host_ed25519_key`.

## Authentication (JWT)

- Stateless JWT in HTTP-only cookie `gitmini.token` (secret `JWT_SECRET`, lifetime `JWT_EXPIRES_IN`).
- `authenticateJwt` middleware loads user by `sub`, verifies `ver` claim against `token_version`.
- Password change increments `token_version`, invalidating all other JWTs.
- Flash messages via short-lived signed JWT cookie `gitmini.flash`.
- Logout clears auth cookie.

## Data rules

- `users.username` unique; `repositories` unique per `(owner_id, name)`; `ssh_keys.fingerprint` unique.
- User columns: `id`, `username`, `password_hash`, `display_name`, `email` (unique non-empty), `bio`, `default_private`, `token_version`.
- Hash passwords with `node:crypto` (scrypt); never store plaintext.
- Private repos: not listed on `/dashboard` for other users; Git HTTP/SSH may still be open unless auth wired.

## Workflow

- Keep production-minded error handling (missing folders, missing `git`, spawn failures).
- Do not commit `storage/`, `*.db`, or `node_modules/`.
- Do not add C++ Git bindings or rewrite the Git protocol in pure JS without an explicit request.
- Swagger UI must be mounted **before** the `/:owner/:repo` wildcard routes so asset requests are not captured.
