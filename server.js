'use strict';

/**
 * WEB DASHBOARD + HTTP ENTRYPOINT
 *
 * Git Smart HTTP is mounted first so pack POSTs are never consumed by
 * express.json / urlencoded. HTML routes use EJS + Tailwind CDN.
 */

const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const {
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  SSH_ENABLED,
  SSH_PORT,
  SSH_PUBLIC_HOST,
  ensureStorageDirs,
} = require('./config');
const models = require('./models');
const gitCore = require('./gitCore');
const sshCore = require('./sshCore');
const { createGitHttpRouter } = require('./gitHttp');

ensureStorageDirs();
models.init();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

function publicOrigin(req) {
  const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}`;
}

function cloneUrl(req, owner, repoName) {
  return `${publicOrigin(req)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}.git`;
}

function sshCloneUrl(req, owner, repoName) {
  if (!SSH_ENABLED) return null;
  const host = SSH_PUBLIC_HOST || req.hostname || 'localhost';
  const portPart = Number(SSH_PORT) === 22 ? '' : `:${SSH_PORT}`;
  return `ssh://git@${host}${portPart}/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}.git`;
}

const AUTH_COOKIE = 'gitmini.token';
const FLASH_COOKIE = 'gitmini.flash';
const COOKIE_OPTIONS = { httpOnly: true, sameSite: 'lax', path: '/' };
const DEFAULT_AUTH_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function parseCookies(header) {
  const cookies = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const index = part.indexOf('=');
      if (index === -1) return;
      const key = part.slice(0, index).trim();
      if (!key) return;
      const value = part.slice(index + 1).trim();
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    });
  return cookies;
}

function issueAuthToken(user) {
  return jwt.sign({ username: user.username }, JWT_SECRET, {
    subject: String(user.id),
    expiresIn: JWT_EXPIRES_IN,
  });
}

function setAuthCookie(res, user) {
  const token = issueAuthToken(user);
  const decoded = jwt.decode(token);
  const maxAge =
    decoded && decoded.exp ? Math.max(0, decoded.exp * 1000 - Date.now()) : DEFAULT_AUTH_MAX_AGE;
  res.cookie(AUTH_COOKIE, token, { ...COOKIE_OPTIONS, maxAge });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, COOKIE_OPTIONS);
}

function setFlash(req, type, message) {
  const token = jwt.sign({ type, message }, JWT_SECRET, { expiresIn: '5m' });
  req.res.cookie(FLASH_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: 5 * 60 * 1000 });
}

function authenticateJwt(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  req.user = null;

  const authToken = req.cookies[AUTH_COOKIE];
  if (authToken) {
    try {
      const payload = jwt.verify(authToken, JWT_SECRET);
      const user = models.findUserById(Number(payload.sub));
      if (user) req.user = user;
      else clearAuthCookie(res);
    } catch {
      clearAuthCookie(res);
    }
  }

  let flash = null;
  const flashToken = req.cookies[FLASH_COOKIE];
  if (flashToken) {
    try {
      const payload = jwt.verify(flashToken, JWT_SECRET);
      flash = { type: payload.type, message: payload.message };
    } catch {
      flash = null;
    }
    res.clearCookie(FLASH_COOKIE, COOKIE_OPTIONS);
  }

  res.locals.currentUser = req.user;
  res.locals.flash = flash;
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    setFlash(req, 'error', 'Sign in to continue.');
    return res.redirect('/login');
  }
  next();
}

const RESERVED_OWNERS = new Set(['dashboard', 'login', 'register', 'logout', 'repos', 'create']);

function parseRepoParams(req) {
  return {
    owner: gitCore.stripGitSuffix(req.params.owner),
    repoName: gitCore.stripGitSuffix(req.params.repo),
  };
}

function loadAccessibleRepo(req, res) {
  const { owner, repoName } = parseRepoParams(req);
  if (RESERVED_OWNERS.has(owner)) return { skip: true };

  const repo = models.getRepository(owner, repoName);
  const viewerId = req.user ? req.user.id : null;
  if (!repo || !models.canViewRepository(repo, viewerId)) {
    res.status(404).render('not-found', {
      title: 'Not found',
      message: 'This repository does not exist.',
    });
    return { skip: false, repo: null };
  }

  return {
    skip: false,
    repo,
    owner,
    repoName,
    viewerId,
    isOwner: models.isRepositoryOwner(repo, viewerId),
  };
}

function repoBase(owner, repoName) {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`;
}

function breadcrumbs(dirPath) {
  const parts = dirPath ? dirPath.split('/') : [];
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join('/'),
  }));
}

// --- Git Smart HTTP (raw body streams; no JSON parser) ---
app.use('/repos', createGitHttpRouter());

// JWT auth/flash only for web routes, after the raw Git stream router.
app.use(authenticateJwt);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (_req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('login', { title: 'Sign in' });
});

app.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = models.authenticate(username, password);
  if (!user) {
    setFlash(req, 'error', 'Invalid username or password.');
    return res.redirect('/login');
  }
  setAuthCookie(res, user);
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('register', { title: 'Create account' });
});

app.post('/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[A-Za-z0-9._-]{2,40}$/.test(username)) {
    setFlash(req, 'error', 'Username must be 2–40 characters: letters, digits, . _ -');
    return res.redirect('/register');
  }
  if (password.length < 4) {
    setFlash(req, 'error', 'Password must be at least 4 characters.');
    return res.redirect('/register');
  }
  if (models.findUserByUsername(username)) {
    setFlash(req, 'error', 'That username is already taken.');
    return res.redirect('/register');
  }
  try {
    const user = models.createUser(username, password);
    setAuthCookie(res, user);
    res.redirect('/dashboard');
  } catch (err) {
    setFlash(req, 'error', err.message || 'Could not create account.');
    res.redirect('/register');
  }
});

app.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.redirect('/dashboard');
});

/**
 * GET /dashboard — public (and own private) repositories + create form
 */
app.get('/dashboard', async (req, res) => {
  const viewerId = req.user ? req.user.id : null;
  const repositories = await Promise.all(
    models.listRepositoriesForViewer(viewerId).map(async (repo) => {
      try {
        const log = await gitCore.getCommitLog(repo.owner, repo.name, null, { limit: 1 });
        return { ...repo, lastCommit: log.commits[0] || null };
      } catch {
        return { ...repo, lastCommit: null };
      }
    })
  );
  res.render('dashboard', {
    title: 'Dashboard',
    repositories,
  });
});

app.post('/create', requireLogin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();
  const isPrivate = Boolean(req.body.is_private);
  const owner = req.user.username;

  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name) || name === '.' || name === '..') {
    setFlash(req, 'error', 'Repository name must use letters, digits, . _ - only.');
    return res.redirect('/dashboard');
  }

  if (models.getRepository(owner, name)) {
    setFlash(req, 'error', 'You already have a repository with that name.');
    return res.redirect('/dashboard');
  }

  try {
    await gitCore.createBareRepo(owner, name);
    models.createRepository({
      name,
      ownerId: req.user.id,
      isPrivate,
      description,
    });
    setFlash(req, 'success', `Repository ${owner}/${name} created.`);
    res.redirect(`/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  } catch (err) {
    setFlash(req, 'error', err.message || 'Failed to create repository.');
    res.redirect('/dashboard');
  }
});

/**
 * GET /settings/ssh — manage the current user's SSH public keys
 */
app.get('/settings/ssh', requireLogin, (req, res) => {
  res.render('settings-ssh', {
    title: 'SSH keys',
    keys: models.listSshKeys(req.user.id),
    sshPort: SSH_PORT,
    sshEnabled: SSH_ENABLED,
  });
});

app.post('/settings/ssh', requireLogin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80) || 'SSH key';
  const publicKey = String(req.body.public_key || '').trim();

  let parsed;
  try {
    parsed = sshCore.parseAuthorizedKey(publicKey);
  } catch (err) {
    setFlash(req, 'error', err.message || 'Invalid SSH public key.');
    return res.redirect('/settings/ssh');
  }

  if (models.findSshKeyByFingerprint(parsed.fingerprint)) {
    setFlash(req, 'error', 'That public key is already registered.');
    return res.redirect('/settings/ssh');
  }

  try {
    models.createSshKey({
      userId: req.user.id,
      title,
      publicKey: parsed.publicKey,
      keyType: parsed.type,
      fingerprint: parsed.fingerprint,
    });
  } catch {
    setFlash(req, 'error', 'That public key is already registered.');
    return res.redirect('/settings/ssh');
  }

  setFlash(req, 'success', `Added SSH key ${parsed.fingerprint}.`);
  res.redirect('/settings/ssh');
});

app.post('/settings/ssh/:id/delete', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    setFlash(req, 'error', 'Invalid SSH key.');
    return res.redirect('/settings/ssh');
  }
  const removed = models.deleteSshKey(id, req.user.id);
  setFlash(
    req,
    removed ? 'success' : 'error',
    removed ? 'SSH key removed.' : 'SSH key not found.'
  );
  res.redirect('/settings/ssh');
});

/**
 * GET /:owner/:repo/commits — GitHub/Gitea-style commit history
 */
app.get('/:owner/:repo/commits', async (req, res, next) => {
  const loaded = loadAccessibleRepo(req, res);
  if (loaded.skip) return next();
  if (!loaded.repo) return;

  const { owner, repoName, repo, isOwner } = loaded;
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 30;
  let history = { branch: null, commits: [], total: 0, groups: [] };
  let historyError = null;

  try {
    history = await gitCore.getCommitLog(owner, repoName, req.query.branch, {
      skip: (page - 1) * perPage,
      limit: perPage,
    });
  } catch (err) {
    historyError = err.message;
  }

  const branchInfo = await gitCore
    .listBranches(owner, repoName)
    .catch(() => ({ branches: [], defaultBranch: null }));

  const totalPages = Math.max(1, Math.ceil((history.total || 0) / perPage));
  res.render('commits', {
    title: `Commits · ${owner}/${repoName}`,
    repo,
    isOwner,
    branch: history.branch,
    branches: branchInfo.branches,
    defaultBranch: branchInfo.defaultBranch,
    branchAction: `${repoBase(owner, repoName)}/commits`,
    groups: history.groups,
    total: history.total,
    page,
    totalPages,
    historyError,
  });
});

/**
 * GET /:owner/:repo/commit/:sha — commit detail (message, files, patch)
 */
app.get('/:owner/:repo/commit/:sha', async (req, res, next) => {
  const loaded = loadAccessibleRepo(req, res);
  if (loaded.skip) return next();
  if (!loaded.repo) return;

  const { owner, repoName, repo, isOwner } = loaded;
  let commit = null;
  let detailError = null;

  try {
    commit = await gitCore.getCommitDetail(owner, repoName, req.params.sha);
  } catch (err) {
    detailError = err.status === 404 ? 'This commit does not exist.' : err.message;
  }

  const branchInfo = await gitCore
    .listBranches(owner, repoName)
    .catch(() => ({ branches: [], defaultBranch: null }));

  res.render('commit', {
    title: commit ? `${commit.short} · ${owner}/${repoName}` : `Commit · ${owner}/${repoName}`,
    repo,
    isOwner,
    commit,
    detailError,
    branch: req.query.branch || branchInfo.defaultBranch,
    branches: branchInfo.branches,
    defaultBranch: branchInfo.defaultBranch,
  });
});

/**
 * GET /:owner/:repo/branches — local branches with latest commit summary
 */
app.get('/:owner/:repo/branches', async (req, res, next) => {
  const loaded = loadAccessibleRepo(req, res);
  if (loaded.skip) return next();
  if (!loaded.repo) return;

  const { owner, repoName, repo, isOwner } = loaded;
  let branches = [];
  let defaultBranch = null;
  let branchesError = null;

  try {
    const info = await gitCore.listBranches(owner, repoName);
    branches = info.branches;
    defaultBranch = info.defaultBranch;
  } catch (err) {
    branchesError = err.message;
  }

  res.render('branches', {
    title: `Branches · ${owner}/${repoName}`,
    repo,
    isOwner,
    branches,
    defaultBranch,
    branchesError,
  });
});

/**
 * GET /:owner/:repo/blob?path=&branch= — file viewer
 */
app.get('/:owner/:repo/blob', async (req, res, next) => {
  const loaded = loadAccessibleRepo(req, res);
  if (loaded.skip) return next();
  if (!loaded.repo) return;

  const { owner, repoName, repo, isOwner } = loaded;
  let blob = null;
  let blobError = null;

  try {
    blob = await gitCore.getFileBlob(owner, repoName, req.query.branch, req.query.path);
  } catch (err) {
    blobError = err.status === 404 ? 'This file does not exist on that branch.' : err.message;
  }

  const branchInfo = await gitCore
    .listBranches(owner, repoName)
    .catch(() => ({ branches: [], defaultBranch: null }));

  res.render('blob', {
    title: `${req.query.path || 'File'} · ${owner}/${repoName}`,
    repo,
    isOwner,
    blob,
    blobError,
    branch: (blob && blob.branch) || req.query.branch || branchInfo.defaultBranch,
    branches: branchInfo.branches,
    defaultBranch: branchInfo.defaultBranch,
    branchAction: `${repoBase(owner, repoName)}/blob`,
    path: req.query.path,
    crumbs: breadcrumbs(req.query.path),
  });
});

/**
 * GET /:owner/:repo/raw?path=&branch= — download raw bytes
 */
app.get('/:owner/:repo/raw', async (req, res, next) => {
  const loaded = loadAccessibleRepo(req, res);
  if (loaded.skip) return next();
  if (!loaded.repo) return;

  const { owner, repoName } = loaded;
  try {
    const file = await gitCore.getFileBuffer(
      owner,
      repoName,
      req.query.branch,
      req.query.path
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
    );
    res.type(file.name);
    res.send(file.buffer);
  } catch (err) {
    res.status(err.status || 500).render('not-found', {
      title: 'Not found',
      message: err.message || 'File not found.',
    });
  }
});

/**
 * POST /:owner/:repo/delete — owner-only; requires typing the repo name
 */
app.post('/:owner/:repo/delete', requireLogin, async (req, res, next) => {
  const loaded = loadAccessibleRepo(req, res);
  if (loaded.skip) return next();
  if (!loaded.repo) return;

  const { owner, repoName, isOwner } = loaded;
  if (!isOwner) {
    setFlash(req, 'error', 'Only the owner can delete this repository.');
    return res.redirect(`/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
  }

  const confirmation = String(req.body.confirm || '').trim();
  if (confirmation !== repoName) {
    setFlash(req, 'error', 'Type the repository name exactly to confirm deletion.');
    return res.redirect(`/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
  }

  try {
    gitCore.deleteBareRepo(owner, repoName);
    models.deleteRepository(owner, repoName);
    setFlash(req, 'success', `Deleted ${owner}/${repoName}.`);
    res.redirect('/dashboard');
  } catch (err) {
    setFlash(req, 'error', err.message || 'Failed to delete repository.');
    res.redirect(`/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`);
  }
});

/**
 * GET /:owner/:repo — landing page (clone URL + root tree + recent commits)
 */
app.get('/:owner/:repo', async (req, res, next) => {
  const loaded = loadAccessibleRepo(req, res);
  if (loaded.skip) return next();
  if (!loaded.repo) return;

  const { owner, repoName, repo, isOwner } = loaded;
  const dirPath = String(req.query.path || '');
  let tree = { branch: null, path: '', entries: [] };
  let treeError = null;
  let history = { branch: null, commits: [], total: 0, groups: [] };
  let branches = [];
  let defaultBranch = null;

  try {
    tree = await gitCore.getTreeAtPath(owner, repoName, req.query.branch, dirPath);
  } catch (err) {
    if (err.status === 404 && /Branch/.test(err.message)) {
      treeError = err.message;
    } else if (err.status === 404 && /Path/.test(err.message)) {
      treeError = err.message;
    } else if (err.status === 404) {
      treeError = 'The bare repository folder is missing on disk.';
    } else {
      treeError = err.message;
    }
  }

  try {
    const info = await gitCore.listBranches(owner, repoName);
    branches = info.branches;
    defaultBranch = info.defaultBranch;
  } catch {
    branches = [];
  }

  try {
    history = await gitCore.getCommitLog(owner, repoName, req.query.branch || tree.branch, {
      skip: 0,
      limit: 15,
    });
  } catch {
    history = { branch: tree.branch, commits: [], total: 0, groups: [] };
  }

  let readme = null;
  if (tree.branch && !tree.path && !treeError) {
    const entry = tree.entries.find((item) => !item.isTree && /^readme(\.(md|markdown|txt))?$/i.test(item.name));
    if (entry) {
      try {
        const file = await gitCore.getFileBlob(owner, repoName, tree.branch, entry.name);
        if (!file.binary && !file.tooLarge) {
          readme = { name: entry.name, content: file.content.slice(0, 100000) };
        }
      } catch {
        readme = null;
      }
    }
  }

  res.render('repo', {
    title: `${owner}/${repoName}`,
    repo,
    isOwner,
    cloneUrl: cloneUrl(req, owner, repoName),
    sshCloneUrl: sshCloneUrl(req, owner, repoName),
    sshEnabled: SSH_ENABLED,
    branch: tree.branch || history.branch,
    defaultBranch,
    branches,
    branchAction: repoBase(owner, repoName),
    path: tree.path || '',
    entries: tree.entries,
    crumbs: breadcrumbs(tree.path),
    treeError,
    commitGroups: history.groups,
    commitTotal: history.total,
    latestCommit: history.commits[0] || null,
    readme,
  });
});

app.use((req, res) => {
  res.status(404).render('not-found', {
    title: 'Not found',
    message: `No page at ${req.path}`,
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).type('text/plain').send('Internal server error\n');
});

app.listen(PORT, () => {
  console.log(`Git host listening on http://localhost:${PORT}`);
  console.log('Default user: admin / admin (change after first login)');
  sshCore.startSshServer();
});
