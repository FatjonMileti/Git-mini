'use strict';

/**
 * GIT CORE ORCHESTRATOR
 *
 * Manages bare repositories on disk and shells out to the system `git`
 * binary via child_process. No native Git bindings.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REPOS_ROOT, ensureStorageDirs } = require('./config');

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

class GitError extends Error {
  constructor(message, { status = 500, cause } = {}) {
    super(message);
    this.name = 'GitError';
    this.status = status;
    this.cause = cause;
  }
}

function assertSafeSegment(value, label) {
  if (typeof value !== 'string' || !SAFE_NAME.test(value) || value === '.' || value === '..') {
    throw new GitError(`Invalid ${label}`, { status: 400 });
  }
}

function stripGitSuffix(repoName) {
  return String(repoName || '').replace(/\.git$/i, '');
}

/**
 * Absolute path to the bare repo: ./storage/repos/<owner>/<repoName>.git
 */
function getRepoPath(owner, repoName) {
  assertSafeSegment(owner, 'owner');
  const name = stripGitSuffix(repoName);
  assertSafeSegment(name, 'repository name');
  return path.join(REPOS_ROOT, owner, `${name}.git`);
}

function repoExists(owner, repoName) {
  try {
    const repoPath = getRepoPath(owner, repoName);
    return fs.existsSync(path.join(repoPath, 'HEAD'));
  } catch {
    return false;
  }
}

function spawnGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new GitError(err.message, { status: 500, cause: err }));
      return;
    }

    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new GitError('The system git binary was not found on PATH', { status: 500, cause: err })
        );
        return;
      }
      reject(new GitError(err.message, { status: 500, cause: err }));
    });
    child.on('close', (code) => {
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        reject(
          new GitError(stderrText || `git ${args[0]} exited with ${code}`, {
            status: 500,
            cause: { code, stderr: stderrText },
          })
        );
        return;
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

async function runGit(args, options) {
  const output = await spawnGit(args, options);
  return output.toString('utf8');
}

function runGitBuffer(args, options) {
  return spawnGit(args, options);
}

/**
 * Creates ./storage/repos/<owner>/<repoName>.git and runs `git init --bare`.
 */
async function createBareRepo(owner, repoName) {
  ensureStorageDirs();
  const repoPath = getRepoPath(owner, repoName);
  if (fs.existsSync(path.join(repoPath, 'HEAD'))) {
    throw new GitError('Repository already exists on disk', { status: 409 });
  }

  fs.mkdirSync(repoPath, { recursive: true });

  try {
    await runGit(['init', '--bare', '--initial-branch=main', repoPath]);
  } catch (err) {
    // Older git without --initial-branch
    if (/unknown option|unrecognized/i.test(err.message)) {
      await runGit(['init', '--bare', repoPath]);
      try {
        await runGit(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repoPath });
      } catch {
        /* leave default HEAD */
      }
    } else {
      throw err;
    }
  }

  // Allow Smart HTTP push/fetch without git-http-backend's default deny.
  await runGit(['config', 'http.receivepack', 'true'], { cwd: repoPath });
  await runGit(['config', 'http.uploadpack', 'true'], { cwd: repoPath });
  await runGit(['config', 'core.bare', 'true'], { cwd: repoPath });

  return repoPath;
}

function assertRepoOnDisk(repoPath) {
  if (!fs.existsSync(path.join(repoPath, 'HEAD'))) {
    throw new GitError('Repository not found on disk', { status: 404 });
  }
}

async function resolveBranch(repoPath, branch) {
  if (branch) {
    const ref = String(branch);
    if (ref.startsWith('-') || /[\0\r\n]/.test(ref)) {
      throw new GitError('Invalid branch or ref', { status: 400 });
    }
    try {
      await runGit(['rev-parse', '--verify', ref], { cwd: repoPath });
      return ref;
    } catch {
      throw new GitError(`Branch or ref not found: ${ref}`, { status: 404 });
    }
  }

  try {
    const head = (await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath })).trim();
    await runGit(['rev-parse', '--verify', head], { cwd: repoPath });
    return head;
  } catch {
    // Empty repo or detached HEAD with no commits yet.
  }

  for (const candidate of ['main', 'master']) {
    try {
      await runGit(['rev-parse', '--verify', candidate], { cwd: repoPath });
      return candidate;
    } catch {
      /* try next */
    }
  }

  return null;
}

function parseLsTree(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // <mode> <type> <object> <size>\t<name>
      const tab = line.indexOf('\t');
      if (tab === -1) return null;
      const meta = line.slice(0, tab).trim().split(/\s+/);
      const name = line.slice(tab + 1);
      const [mode, type, oid, size] = meta;
      return {
        mode,
        type,
        oid,
        size: type === 'blob' ? Number(size) : null,
        name,
        isTree: type === 'tree',
        isSubmodule: type === 'commit',
      };
    })
    .filter(Boolean);
}

function sortTreeEntries(entries) {
  return entries.sort((a, b) => {
    if (a.isTree !== b.isTree) return a.isTree ? -1 : 1;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
}

/**
 * Lists the root tree of a branch using `git ls-tree`.
 * Returns [] when the repo has no commits yet.
 */
async function getRepoFiles(owner, repoName, branch) {
  const repoPath = getRepoPath(owner, repoName);
  assertRepoOnDisk(repoPath);

  const ref = await resolveBranch(repoPath, branch);
  if (!ref) {
    return { branch: null, files: [] };
  }

  let output;
  try {
    output = await runGit(['ls-tree', '-l', ref], { cwd: repoPath });
  } catch (err) {
    throw new GitError('Unable to list repository tree', { status: 500, cause: err });
  }

  return { branch: ref, files: sortTreeEntries(parseLsTree(output)) };
}

const SAFE_PATH_PART = /^[^/\\\0]+$/;

/**
 * Normalizes a path inside a repo (forward slashes, no `.`/`..`, no NUL).
 */
function sanitizeRepoPath(input) {
  const raw = String(input || '').replace(/\\/g, '/');
  const parts = raw.split('/').filter((part) => part !== '');
  for (const part of parts) {
    if (part === '.' || part === '..' || !SAFE_PATH_PART.test(part)) {
      throw new GitError('Invalid repository path', { status: 400 });
    }
  }
  return parts.join('/');
}

/**
 * Lists one directory of a branch. `dirPath` may be '' for the repo root.
 */
async function getTreeAtPath(owner, repoName, branch, dirPath) {
  const repoPath = getRepoPath(owner, repoName);
  assertRepoOnDisk(repoPath);

  const ref = await resolveBranch(repoPath, branch);
  if (!ref) {
    return { branch: null, path: '', entries: [] };
  }

  const clean = sanitizeRepoPath(dirPath);
  if (clean) {
    let type;
    try {
      type = (await runGit(['cat-file', '-t', `${ref}:${clean}`], { cwd: repoPath })).trim();
    } catch {
      throw new GitError(`Path not found: ${clean}`, { status: 404 });
    }
    if (type !== 'tree') {
      throw new GitError(`Not a directory: ${clean}`, { status: 404 });
    }
  }

  const spec = clean ? `${ref}:${clean}` : ref;
  let output;
  try {
    output = await runGit(['ls-tree', '-l', spec], { cwd: repoPath });
  } catch (err) {
    throw new GitError('Unable to list repository tree', { status: 500, cause: err });
  }

  return { branch: ref, path: clean, entries: sortTreeEntries(parseLsTree(output)) };
}

const MAX_RENDER_BYTES = 1024 * 1024;

function looksBinary(buffer) {
  const sample = buffer.subarray(0, 8000);
  return sample.includes(0);
}

/**
 * Reads a blob at `filePath` on `branch`. Text content is returned separately
 * from the raw buffer so callers can decide to render or stream it.
 */
async function readBlob(owner, repoName, branch, filePath) {
  const repoPath = getRepoPath(owner, repoName);
  assertRepoOnDisk(repoPath);

  const ref = await resolveBranch(repoPath, branch);
  if (!ref) {
    throw new GitError('Repository has no commits yet', { status: 404 });
  }

  const clean = sanitizeRepoPath(filePath);
  if (!clean) throw new GitError('A file path is required', { status: 400 });

  const spec = `${ref}:${clean}`;
  let type;
  try {
    type = (await runGit(['cat-file', '-t', spec], { cwd: repoPath })).trim();
  } catch {
    throw new GitError(`File not found: ${clean}`, { status: 404 });
  }
  if (type !== 'blob') {
    throw new GitError(`Not a file: ${clean}`, { status: 404 });
  }

  const size = Number(
    (await runGit(['cat-file', '-s', spec], { cwd: repoPath })).trim()
  ) || 0;
  const buffer = await runGitBuffer(['cat-file', '-p', spec], { cwd: repoPath });
  const binary = looksBinary(buffer);

  return {
    branch: ref,
    path: clean,
    name: clean.split('/').pop(),
    size: buffer.length || size,
    binary,
    buffer,
    content: binary ? '' : buffer.toString('utf8'),
  };
}

/**
 * Text blob for the file viewer; guards against huge/binary files.
 */
async function getFileBlob(owner, repoName, branch, filePath) {
  const blob = await readBlob(owner, repoName, branch, filePath);
  const tooLarge = blob.size > MAX_RENDER_BYTES;
  const content = tooLarge || blob.binary ? '' : blob.content;
  return {
    branch: blob.branch,
    path: blob.path,
    name: blob.name,
    size: blob.size,
    binary: blob.binary,
    tooLarge,
    content,
    lines: content.length ? content.replace(/\n$/, '').split('\n') : [],
  };
}

/**
 * Raw blob bytes for downloads.
 */
async function getFileBuffer(owner, repoName, branch, filePath) {
  const blob = await readBlob(owner, repoName, branch, filePath);
  return { name: blob.name, size: blob.size, buffer: blob.buffer };
}

/**
 * Local branches plus the default branch name (HEAD) when available.
 */
async function listBranches(owner, repoName) {
  const repoPath = getRepoPath(owner, repoName);
  assertRepoOnDisk(repoPath);

  const format =
    '%(refname:short)\x1f%(objectname:short)\x1f%(authorname)\x1f%(authordate:iso-strict)\x1f%(subject)\x1e';
  const output = await runGit(['for-each-ref', `--format=${format}`, 'refs/heads'], {
    cwd: repoPath,
  });
  const branches = output
    .split('\x1e')
    .map((record) => record.replace(/^\n/, '').trim())
    .filter(Boolean)
    .map((record) => {
      const [name, short, authorName, committedAt, subject] = record.split('\x1f');
      return {
        name,
        short: short || '',
        authorName: authorName || '',
        committedAt: committedAt || '',
        subject: subject || '(no message)',
        relativeTime: relativeTime(committedAt),
        initials: authorInitials(authorName),
        hue: authorHue(authorName),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  let defaultBranch = null;
  try {
    defaultBranch = await resolveBranch(repoPath, null);
  } catch {
    defaultBranch = null;
  }

  return { branches, defaultBranch };
}

function shortSha(value) {
  return String(value || '').slice(0, 7);
}

const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;

/**
 * Single commit metadata plus changed-file stats and a (possibly truncated) patch.
 */
async function getCommitDetail(owner, repoName, sha) {
  const repoPath = getRepoPath(owner, repoName);
  assertRepoOnDisk(repoPath);

  const rev = String(sha || '');
  if (!SHA_PATTERN.test(rev)) {
    throw new GitError('Invalid commit id', { status: 400 });
  }

  let metaOut;
  try {
    metaOut = await runGit(
      ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P', rev],
      { cwd: repoPath }
    );
  } catch {
    throw new GitError('Commit not found', { status: 404 });
  }

  const [full, authorName, authorEmail, committedAt, parents] = metaOut.trim().split('\x1f');
  let message = '';
  try {
    message = (await runGit(['show', '-s', '--format=%B', full], { cwd: repoPath })).trim();
  } catch {
    /* keep empty message */
  }

  const statOut = await runGit(
    ['show', '--format=', '--numstat', '--no-renames', full],
    { cwd: repoPath }
  );
  const files = statOut
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, filePath] = line.split('\t');
      return {
        path: filePath,
        additions: additions === '-' ? null : Number(additions),
        deletions: deletions === '-' ? null : Number(deletions),
        binary: additions === '-',
      };
    });

  let patch = await runGit(
    ['show', '--format=', '--no-color', '--no-renames', '--patch', full],
    { cwd: repoPath }
  );
  let patchTruncated = false;
  if (patch.length > 400000) {
    patch = patch.slice(0, 400000);
    patchTruncated = true;
  }

  return {
    full,
    short: shortSha(full),
    authorName,
    authorEmail,
    committedAt,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    message,
    subject: message.split('\n')[0] || '(no message)',
    relativeTime: relativeTime(committedAt),
    initials: authorInitials(authorName),
    hue: authorHue(authorEmail || authorName),
    dateLabel: new Date(committedAt).toLocaleString('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    files,
    additions: files.reduce((n, f) => n + (f.additions || 0), 0),
    deletions: files.reduce((n, f) => n + (f.deletions || 0), 0),
    patch,
    patchTruncated,
    diffLines: patch.split('\n').map((line) => {
      let kind = 'context';
      if (line.startsWith('+++') || line.startsWith('---')) kind = 'meta';
      else if (line.startsWith('diff ') || line.startsWith('index ')) kind = 'meta';
      else if (line.startsWith('@@')) kind = 'hunk';
      else if (line.startsWith('+')) kind = 'add';
      else if (line.startsWith('-')) kind = 'del';
      return { text: line, kind };
    }),
  };
}

function isPathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Removes the bare repo directory from disk. Path is constrained to REPOS_ROOT.
 */
function deleteBareRepo(owner, repoName) {
  const repoPath = getRepoPath(owner, repoName);
  if (!isPathInside(REPOS_ROOT, repoPath)) {
    throw new GitError('Refusing to delete a path outside the repos root', { status: 400 });
  }
  fs.rmSync(repoPath, { recursive: true, force: true });

  const ownerDir = path.dirname(repoPath);
  if (isPathInside(REPOS_ROOT, ownerDir)) {
    try {
      const leftover = fs.readdirSync(ownerDir);
      if (leftover.length === 0) fs.rmdirSync(ownerDir);
    } catch {
      /* owner dir still in use or already gone */
    }
  }
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(-Math.round(seconds / size), unit);
  }
  return rtf.format(-seconds, 'second');
}

function authorInitials(name) {
  const parts = String(name || '?')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function authorHue(seed) {
  let hash = 0;
  for (const ch of String(seed || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

function parseLogRecords(output) {
  return output
    .split('\x1e')
    .map((record) => record.replace(/^\n/, '').trim())
    .filter(Boolean)
    .map((record) => {
      const [full, short, authorName, authorEmail, committedAt, subject] = record.split('\x1f');
      const when = new Date(committedAt);
      return {
        full,
        short,
        authorName,
        authorEmail,
        committedAt,
        subject: subject || '(no message)',
        relativeTime: relativeTime(committedAt),
        initials: authorInitials(authorName),
        hue: authorHue(authorEmail || authorName),
        dateKey: Number.isNaN(when.getTime())
          ? 'unknown'
          : when.toISOString().slice(0, 10),
        dateLabel: Number.isNaN(when.getTime())
          ? 'Unknown date'
          : when.toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            }),
      };
    });
}

function groupCommitsByDate(commits) {
  const groups = [];
  const index = new Map();
  for (const commit of commits) {
    let group = index.get(commit.dateKey);
    if (!group) {
      group = { dateKey: commit.dateKey, dateLabel: commit.dateLabel, commits: [] };
      index.set(commit.dateKey, group);
      groups.push(group);
    }
    group.commits.push(commit);
  }
  return groups;
}

/**
 * Commit history for a branch, newest first (git log).
 */
async function getCommitLog(owner, repoName, branch, { skip = 0, limit = 30 } = {}) {
  const repoPath = getRepoPath(owner, repoName);
  assertRepoOnDisk(repoPath);

  const ref = await resolveBranch(repoPath, branch);
  if (!ref) {
    return { branch: null, commits: [], total: 0, groups: [] };
  }

  let total = 0;
  try {
    const countOut = await runGit(['rev-list', '--count', ref], { cwd: repoPath });
    total = Number(countOut.trim()) || 0;
  } catch {
    total = 0;
  }

  if (total === 0) {
    return { branch: ref, commits: [], total: 0, groups: [] };
  }

  const pretty = '%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e';
  const output = await runGit(
    [
      'log',
      ref,
      `--pretty=format:${pretty}`,
      `--skip=${Number(skip) || 0}`,
      `--max-count=${Number(limit) || 30}`,
    ],
    { cwd: repoPath }
  );

  const commits = parseLogRecords(output);
  return {
    branch: ref,
    commits,
    total,
    groups: groupCommitsByDate(commits),
  };
}

module.exports = {
  GitError,
  stripGitSuffix,
  getRepoPath,
  repoExists,
  createBareRepo,
  deleteBareRepo,
  getRepoFiles,
  getTreeAtPath,
  getFileBlob,
  getFileBuffer,
  listBranches,
  getCommitLog,
  getCommitDetail,
  sanitizeRepoPath,
  runGit,
};
