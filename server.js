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
    setFlash(req, 'error', 'Sign in to create a repository.');
    return res.redirect('/login');
  }
  next();
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
app.get('/dashboard', (req, res) => {
  const viewerId = req.session.user ? req.session.user.id : null;
  const repositories = models.listRepositoriesForViewer(viewerId);
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
 * GET /:owner/:repo — landing page (clone URL + root tree)
 */
app.get('/:owner/:repo', async (req, res, next) => {
  const owner = gitCore.stripGitSuffix(req.params.owner);
  const repoName = gitCore.stripGitSuffix(req.params.repo);
  const reserved = new Set(['dashboard', 'login', 'register', 'logout', 'repos']);
  if (reserved.has(owner)) return next();

  const repo = models.getRepository(owner, repoName);
  if (!repo) {
    return res.status(404).render('not-found', {
      title: 'Not found',
      message: 'This repository does not exist.',
    });
  }

  const viewerId = req.session.user ? req.session.user.id : null;
  if (!models.canViewRepository(repo, viewerId)) {
    return res.status(404).render('not-found', {
      title: 'Not found',
      message: 'This repository does not exist.',
    });
  }

  let tree = { branch: null, files: [] };
  let treeError = null;
  try {
    tree = await gitCore.getRepoFiles(owner, repoName, req.query.branch);
  } catch (err) {
    if (err.status === 404 && /Branch/.test(err.message)) {
      treeError = err.message;
    } else if (err.status === 404) {
      treeError = 'The bare repository folder is missing on disk.';
    } else {
      treeError = err.message;
    }
  }

  res.render('repo', {
    title: `${owner}/${repoName}`,
    repo,
    cloneUrl: cloneUrl(req, owner, repoName),
    branch: tree.branch,
    files: tree.files,
    treeError,
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
