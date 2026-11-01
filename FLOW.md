# Git Mini — Project Flow

## Overview

Git Mini is a self-contained Node.js Git host with:
- Express web UI (EJS + Tailwind CDN)
- SQLite metadata storage (better-sqlite3)
- Bare repositories under `storage/repos/`
- Git Smart HTTP and embedded SSH transport using system `git`

## Startup

1. `server.js` imports `config.js` and `models.js`.
2. `ensureStorageDirs()` creates `storage/repos/`.
3. `models.init()` opens SQLite, applies schema, runs seed data.
4. The Git HTTP router is mounted at `/repos` before JSON/urlencoded.
5. JWT authentication/flash middleware initializes `req.user` and flashes.
6. Static or utility routes are mounted.
7. `startSshServer()` starts the embedded SSH listener (unless `SSH_ENABLED=false`).
8. HTTP app listens on `PORT` (default 3000).

## Authentication

- Users can register or log in.
- JWTs are signed with `JWT_SECRET` and stored in an HTTP-only cookie.
- Login/registration set the cookie using `setAuthCookie`.
- `authenticateJwt` verifies the cookie, loads the user from DB by `sub`, and compares `ver` with `token_version`.
- Logout clears the cookie.

## Account settings

- `GET /settings` shows profile fields.
- `POST /settings/profile` validates display name, email (unique), and bio, then `updateUserProfile`.
- `POST /settings/password` verifies current password, enforces minimum and confirmation, then `updateUserPassword`.
- Password change increments `token_version`, so other JWTs are rejected.

## Repository lifecycle

- Authenticated users create repositories.
- `POST /create` saves metadata and runs `git init --bare`.
- Repositories are stored by owner/name.
- `/` redirects to dashboard.
- Dashboard lists public repos plus current owner's private repos.
- Repository landing shows clone URLs and files.

## Repository access

- `canViewRepository` checks public/private ownership.
- Owner-only workflows include delete, SSH key management, and pushes.
- Delete requires exact-name confirmation and prunes empty owner directory.

## Git Smart HTTP

| Method | Path | Service |
|--------|------|---------|
| `GET` | `/repos/:owner/:repo/info/refs?service=git-upload-pack` | Advertise refs for fetch/clone |
| `GET` | `/repos/:owner/:repo/info/refs?service=git-receive-pack` | Advertise refs for push |
| `POST` | `/repos/:owner/:repo/git-upload-pack` | Fetch/clone pack data |
| `POST` | `/repos/:owner/:repo/git-receive-pack` | Receive push pack data |

### Advertise-refs (`GET /info/refs`)

**Request**
```
GET /repos/admin/hello-world/info/refs?service=git-upload-pack
```

**Response** (pkt-line format)
```
001e# service=git-upload-pack
0000
0048a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 HEAD\0multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed no-done symref=HEAD:refs/heads/master agent=git/2.54.0
003fa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 refs/heads/master
0000
```
- First line: service advertisement (`001e` = 30 bytes)
- `0000` flush packet
- Then each ref: `<sha1> <refname>\0<capabilities>` (first ref) or `<sha1> <refname>` (subsequent)

### git-upload-pack (fetch/clone)

**What it does**: Server sends objects the client doesn't have. Client sends `want` lines for desired commits and `have` lines for what it already has.

**Request body** (client → server, `POST /git-upload-pack`):
```
0032want a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
0000
```
- `want <sha1>` lines (one per commit/branch wanted)
- `0000` flush ends the want list
- Optional `have <sha1>` lines for client's known objects
- Optional `done` to stop negotiation

**Response** (server → client):
- Side-band multiplexed data: packfile stream with progress/error channels
- Content-Type: `application/x-git-upload-pack-result`

### git-receive-pack (push)

**What it does**: Server receives new objects from client and updates refs.

**Request body** (client → server, `POST /git-receive-pack`):
```
0054a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 f1e2d3c4b5a697889900aabbccddeeff0011223344 refs/heads/master report-status
0000
<packfile binary data...>
```
- First line: `<old-sha1> <new-sha1> <refname> [capabilities]`
- `0000` flush
- Then raw packfile (binary)

**Response**:
- Unpack status, ref update status via pkt-line
- Content-Type: `application/x-git-receive-pack-result`

### Implementation notes (Git Mini)

- Routes are mounted **before** `express.json()` so pack bodies stay raw streams.
- `gitHttp.js` spawns `git upload-pack --stateless-rpc --advertise-refs <repoPath>` or `git receive-pack --stateless-rpc --advertise-refs <repoPath>` for advertise.
- For POST, it pipes `req` → `git stdin` and `git stdout` → `res`.
- Repo path sanitized; missing bare dir → 404.
- Both HTTP and SSH share the same `gitCore.getRepoPath()` and authorization logic.

## SSH

- SSH server uses `ssh2` for ephemeral transport.
- Public keys are registered by fingerprint.
- Authentication supports publickey and password fallback.
- Only `git-upload-pack` and `git-receive-pack` are accepted.
- Ownership and visibility checks occur during pack spawn.

## Server-side Git commands

All Git calls go through `child_process.spawn('git', args, { cwd, windowsHide: true })`.
Arguments are arrays, not shell strings, so user input never passes through a shell.
`gitCore.runGit` rejects on a non-zero exit and surfaces stderr as a `GitError`.

### Repository creation and configuration

Triggered by `POST /create` after metadata validation.

| Command | Purpose |
|---------|---------|
| `git init --bare --initial-branch=main <repoPath>` | Create the bare repository |
| `git init --bare <repoPath>` | Fallback for older Git without `--initial-branch` |
| `git symbolic-ref HEAD refs/heads/main` | Fallback default branch after old-Git init |
| `git config http.receivepack true` | Allow Smart HTTP pushes |
| `git config http.uploadpack true` | Allow Smart HTTP fetches |
| `git config core.bare true` | Mark the repository bare |

`cwd` is the repository directory for the `config` and `symbolic-ref` calls.

### Reading refs and commits (web UI)

Triggered by dashboard, repo landing, commits, branches, blob, and commit-detail pages.

| Command | Case |
|---------|------|
| `git rev-parse --verify <ref>` | Validate an explicit branch/ref or probe `HEAD`, `main`, `master` |
| `git symbolic-ref --short HEAD` | Discover the default branch |
| `git rev-list --count <ref>` | Count commits for history pagination |
| `git log <ref> --pretty=format:... --skip=<n> --max-count=<n>` | Commit history and dashboard last-commit summary |
| `git for-each-ref --format=... refs/heads` | Branch list with author, date, and subject |
| `git show -s --format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P <sha>` | Commit metadata and parents |
| `git show -s --format=%B <sha>` | Full commit message |
| `git show --format= --numstat --no-renames <sha>` | Per-file additions/deletions |
| `git show --format= --no-color --no-renames --patch <sha>` | Text patch (truncated at 400 KB) |

### Reading trees and blobs (web UI)

Triggered by repository code browsing and raw-file requests.

| Command | Case |
|---------|------|
| `git ls-tree -l <ref>` | Root tree listing |
| `git ls-tree -l <ref>:<path>` | Nested directory listing |
| `git cat-file -t <ref>:<path>` | Verify a path is a tree or blob |
| `git cat-file -s <ref>:<path>` | Blob size |
| `git cat-file -p <ref>:<path>` | Blob contents (buffered, binary-safe) |

### Git Smart HTTP transport

Triggered by real `git clone`, `git fetch`, and `git push` clients.

| Command | Case |
|---------|------|
| `git upload-pack --stateless-rpc --advertise-refs <repoPath>` | `GET /repos/:owner/:repo/info/refs?service=git-upload-pack` |
| `git receive-pack --stateless-rpc --advertise-refs <repoPath>` | `GET /repos/:owner/:repo/info/refs?service=git-receive-pack` |
| `git upload-pack --stateless-rpc <repoPath>` | `POST /repos/:owner/:repo/git-upload-pack` |
| `git receive-pack --stateless-rpc <repoPath>` | `POST /repos/:owner/:repo/git-receive-pack` |

HTTP pack commands run with `GIT_HTTP_EXPORT_ALL=1`; request bodies may be gzip-decoded before piping.

### SSH transport

Triggered by `git clone`, `git fetch`, and `git push` over `ssh://`.

| Command | Case |
|---------|------|
| `git upload-pack <repoPath>` | `exec` request for `git-upload-pack <owner>/<repo>.git` |
| `git receive-pack <repoPath>` | `exec` request for `git-receive-pack <owner>/<repo>.git` |

SSH runs without `--stateless-rpc` because the SSH channel is the session transport.
`GIT_PROTOCOL` is passed through when the client requests protocol v2; all other
environment variables from the client are ignored. Push requires ownership and
private-repo fetches require ownership.

### No Git command

- Repository deletion uses `fs.rmSync(repoPath, { recursive: true, force: true })`
  and prunes an empty owner directory; no Git process is spawned.
- Account settings, SSH key management, login, logout, and Swagger UI are all
  pure database/HTTP operations.

## Documentation

- `README.md`: usage and environment details.
- `TODO.md`: implementation checklist.