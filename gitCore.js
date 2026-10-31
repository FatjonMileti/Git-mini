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

function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
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
      if (code !== 0) {
        reject(
          new GitError(stderr.trim() || `git ${args[0]} exited with ${code}`, {
            status: 500,
            cause: { code, stderr },
          })
        );
        return;
      }
      resolve(stdout);
    });
  });
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

async function resolveBranch(repoPath, branch) {
  if (branch) {
    try {
      await runGit(['rev-parse', '--verify', branch], { cwd: repoPath });
      return branch;
    } catch {
      throw new GitError(`Branch or ref not found: ${branch}`, { status: 404 });
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

/**
 * Lists the root tree of a branch using `git ls-tree`.
 * Returns [] when the repo has no commits yet.
 */
async function getRepoFiles(owner, repoName, branch) {
  const repoPath = getRepoPath(owner, repoName);
  if (!fs.existsSync(path.join(repoPath, 'HEAD'))) {
    throw new GitError('Repository not found on disk', { status: 404 });
  }

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

  const files = output
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
      };
    })
    .filter(Boolean);

  return { branch: ref, files };
}

module.exports = {
  GitError,
  stripGitSuffix,
  getRepoPath,
  repoExists,
  createBareRepo,
  getRepoFiles,
  runGit,
};
