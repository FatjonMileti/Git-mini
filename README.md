# Git Mini

A minimal self-hosted Git platform (Gitea-like) for local use. It serves a small web UI and speaks Git Smart HTTP so `git clone`, `git fetch`, and `git push` work against the system `git` binary — no native Git bindings.

## Requirements

- Node.js 18+
- `git` on `PATH`
- Build tools only if `better-sqlite3` has no prebuild for your platform

## Quick start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). The first-run account is:

| Username | Password |
|----------|----------|
| `admin`  | `admin`  |

Change that password in production, or register a new user at `/register`.

Environment:

| Variable          | Default                 | Purpose                          |
|-------------------|-------------------------|----------------------------------|
| `PORT`            | `3000`                  | HTTP listen port                 |
| `SESSION_SECRET`  | `dev-only-change-me`    | Cookie signing secret            |

Data lives under `storage/` (gitignored): SQLite at `storage/gitea-clone.db` and bare repos at `storage/repos/<owner>/<name>.git`.

## Using Git over HTTP

1. Sign in and create a repository on `/dashboard`.
2. Clone the URL shown on the repo page:

```bash
git clone http://localhost:3000/repos/<owner>/<repo>.git
cd <repo>
echo "# hello" > README.md
git add README.md
git commit -m "Initial commit"
git push -u origin main
```

After the first push, `GET /<owner>/<repo>` lists the root tree.

## Web routes

| Path | Description |
|------|-------------|
| `/dashboard` | Public repos (plus your private ones) and the create form |
| `/create` | `POST` — create metadata + `git init --bare` |
| `/<owner>/<repo>` | Repo landing page (name, clone URL, files) |
| `/login`, `/register`, `/logout` | Session auth |

## Git Smart HTTP

Mounted at `/repos` **before** JSON/urlencoded parsers so pack bodies stay streams.

| Endpoint | Role |
|----------|------|
| `GET /repos/:owner/:repo/info/refs?service=git-upload-pack` | Fetch/clone advertise-refs |
| `GET /repos/:owner/:repo/info/refs?service=git-receive-pack` | Push advertise-refs |
| `POST /repos/:owner/:repo/git-upload-pack` | Fetch / clone |
| `POST /repos/:owner/:repo/git-receive-pack` | Push |

The `:repo` segment may include or omit `.git`.

## Architecture

```
server.js      Express app, dashboard, sessions
models.js      SQLite users + repositories
gitCore.js     Bare repo paths, init, ls-tree
gitHttp.js     Smart HTTP spawn + stdin/stdout pipe
views/         EJS + Tailwind CDN
config.js      PORT, storage paths
```

Git interaction is always `child_process` + the system `git` binary (`init --bare`, `ls-tree`, `upload-pack`, `receive-pack`).

## Notes

- **Private** only hides a repo from other users on the dashboard. Clone/push over HTTP is currently unauthenticated — do not expose this on a public network as-is.
- Owner and repo names are limited to `A–Z a–z 0–9 . _ -` to avoid path traversal.
- This is a teaching/local host, not a Gitea replacement (no issues, PRs, or SSH).
