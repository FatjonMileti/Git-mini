'use strict';

/**
 * WEB DASHBOARD + HTTP ENTRYPOINT
 *
 * Git Smart HTTP is mounted first so pack POSTs are never consumed by
 * express.json / urlencoded. HTML routes use EJS + Tailwind CDN.
 */

const path = require('path');
const express = require('express');
const session = require('express-session');

const { PORT, SESSION_SECRET, ensureStorageDirs } = require('./config');
const models = require('./models');
const gitCore = require('./gitCore');
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

app.use(
  session({
    name: 'gitmini.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
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
  const viewerId = req.session.user ? req.session.user.id : null;
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

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (_req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
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
  req.session.user = user;
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
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
    req.session.user = { id: user.id, username: user.username };
    res.redirect('/dashboard');
  } catch (err) {
    setFlash(req, 'error', err.message || 'Could not create account.');
    res.redirect('/register');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/dashboard'));
});

/**
 * GET /dashboard — public (and own private) repositories + create form
 */
app.get('/dashboard', async (req, res) => {
  const viewerId = req.session.user ? req.session.user.id : null;
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
  const owner = req.session.user.username;

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
      ownerId: req.session.user.id,
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
});
