# Git Mini

A minimal self-hosted Git platform (Gitea-like) for local use. It serves a small web UI and speaks Git Smart HTTP and SSH so `git clone`, `git fetch`, and `git push` work against the system `git` binary — no native Git bindings.

## Requirements

- Node.js 18+
- `git` on `PATH`
- An SSH client (`ssh`, included with Windows 10+/macOS/Linux) only if you use SSH remotes
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

Change that password in **Settings** after signing in, or register a new user at `/register`.

Environment:

| Variable           | Default                 | Purpose                                      |
|--------------------|-------------------------|----------------------------------------------|
| `PORT`             | `3000`                  | HTTP listen port                             |
| `JWT_SECRET`       | `dev-only-change-me`    | JWT signing secret (falls back to `SESSION_SECRET`) |
| `JWT_EXPIRES_IN`   | `7d`                    | Auth token lifetime                          |
| `SSH_ENABLED`      | `true`                  | Set to `false` to disable the SSH listener   |
| `SSH_PORT`         | `2222`                  | SSH listen port                              |
| `SSH_HOST`         | `0.0.0.0`               | SSH bind address                             |
| `SSH_PUBLIC_HOST`  | request hostname        | Hostname shown in SSH clone URLs             |

Data lives under `storage/` (gitignored): SQLite at `storage/gitea-clone.db`, bare repos at `storage/repos/<owner>/<name>.git`, and the generated SSH host key at `storage/ssh_host_ed25519_key`.

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

## Using Git over SSH

The app runs its own SSH server (embedded `ssh2`, port `2222` by default).

1. Generate a key if needed: `ssh-keygen -t ed25519 -C "you@example.com"`.
2. Sign in and open `/settings/ssh`.
3. Paste the contents of `~/.ssh/id_ed25519.pub`.
4. Clone the SSH URL shown on the repo page:

```bash
git clone ssh://git@localhost:2222/<owner>/<repo>.git
```

Password authentication also works, but the SSH username must be your web
username (`ssh://alice@localhost:2222/...`). Pushing is restricted to the
repository owner; private repositories can only be fetched by their owner. The
server only accepts `git-upload-pack` and `git-receive-pack` commands (no
interactive shell).

## Web routes

| Path | Description |
|------|-------------|
| `/dashboard` | Public repos (plus your private ones) and the create form |
| `/create` | `POST` — create metadata + `git init --bare` |
| `/<owner>/<repo>` | Repo landing page (name, clone URL, files) |
| `/<owner>/<repo>/commits` | Commit history |
| `/<owner>/<repo>/branches` | Branch list |
| `/settings` | Profile, repository defaults, and password change |
| `/settings/ssh` | Manage SSH public keys |
| `/login`, `/register`, `/logout` | JWT cookie auth |

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
server.js      Express app, dashboard, JWT auth, SSH bootstrap
models.js      SQLite users, repositories, SSH keys
gitCore.js     Bare repo paths, init, trees, commits
gitHttp.js     Smart HTTP spawn + stdin/stdout pipe
sshCore.js     SSH auth, command parsing, pack spawn
views/         EJS + Tailwind CDN
config.js      HTTP/SSH ports, storage paths
```

Git interaction is always `child_process` + the system `git` binary (`init --bare`, `ls-tree`, `upload-pack`, `receive-pack`).

## Notes

- **Private** repos are hidden on the dashboard and blocked over SSH for non-owners. HTTP Git remains unauthenticated for now - do not expose this on a public network as-is.
- Owner and repo names are limited to `A-Z a-z 0-9 . _ -` to avoid path traversal.
- SSH keys are stored in SQLite and the host key is generated on first start under `storage/`.
- Web auth is a stateless JWT in an HTTP-only cookie; logout clears the cookie, but issued tokens stay valid until `JWT_EXPIRES_IN`.
- Password changes increment the user's token version, invalidating other browsers; account settings also store display name, email, bio, and the default repository visibility.
- This is a teaching/local host, not a full Gitea replacement (no issues or pull requests).
