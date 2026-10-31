'use strict';

/**
 * SMART HTTP GIT PROTOCOL ROUTER
 *
 * Implements the Git Smart HTTP endpoints so `git clone` / `git fetch` /
 * `git push` work against this server. Pack data is streamed with
 * child_process — never buffered as a string.
 *
 * Protocol notes:
 *   GET  .../info/refs?service=git-upload-pack|git-receive-pack
 *        → pkt-line service banner + advertise-refs
 *   POST .../git-upload-pack   → fetch/clone
 *   POST .../git-receive-pack  → push
 */

const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');
const express = require('express');
const { getRepoPath, stripGitSuffix } = require('./gitCore');

const ALLOWED_SERVICES = new Set(['git-upload-pack', 'git-receive-pack']);

function pktLine(payload) {
  const length = Buffer.byteLength(payload, 'utf8') + 4;
  return Buffer.from(length.toString(16).padStart(4, '0') + payload, 'utf8');
}

function noCache(res) {
  res.setHeader('Expires', 'Fri, 01 Jan 1980 00:00:00 GMT');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
}

function resolveBarePath(req, res) {
  const owner = req.params.owner;
  const repo = stripGitSuffix(req.params.repo);
  let repoPath;
  try {
    repoPath = getRepoPath(owner, repo);
  } catch {
    res.status(400).type('text/plain').send('invalid repository path\n');
    return null;
  }

  if (!fs.existsSync(repoPath) || !fs.existsSync(`${repoPath}/HEAD`)) {
    res.status(404).type('text/plain').send('repository not found\n');
    return null;
  }

  return repoPath;
}

function spawnGit(args, repoPath) {
  return spawn('git', args, {
    cwd: repoPath,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_HTTP_EXPORT_ALL: '1',
    },
  });
}

function pipePackPost(req, res, repoPath, service) {
  const verb = service === 'git-receive-pack' ? 'receive-pack' : 'upload-pack';

  noCache(res);
  res.setHeader('Content-Type', `application/x-${service}-result`);
  req.setTimeout(0);
  res.setTimeout(0);

  const git = spawnGit([verb, '--stateless-rpc', repoPath], repoPath);

  git.on('error', (err) => {
    if (!res.headersSent) {
      const msg =
        err.code === 'ENOENT' ? 'git binary not found\n' : 'failed to spawn git\n';
      res.status(500).type('text/plain').send(msg);
    } else {
      res.destroy(err);
    }
  });

  git.stderr.on('data', (chunk) => {
    process.stderr.write(`[git ${verb}] ${chunk}`);
  });

  git.on('close', (code) => {
    if (code !== 0 && !res.writableEnded) {
      res.end();
    }
  });

  const encoded = String(req.headers['content-encoding'] || '')
    .toLowerCase()
    .includes('gzip');
  const input = encoded ? req.pipe(zlib.createGunzip()) : req;

  input.on('error', (err) => {
    git.kill('SIGTERM');
    if (!res.headersSent) {
      res.status(400).type('text/plain').end('invalid request body\n');
    } else {
      res.destroy(err);
    }
  });

  // Direct stream pipe: client pack <-> git stdin/stdout <-> HTTP response.
  input.pipe(git.stdin);
  git.stdout.pipe(res);
}

function createGitHttpRouter() {
  const router = express.Router();

  // Git clients send Content-Type: application/x-git-*-request; refuse parsers here.
  router.use((req, _res, next) => {
    req._body = true;
    next();
  });

  /**
   * GET /repos/:owner/:repo/info/refs?service=git-upload-pack|git-receive-pack
   */
  router.get('/:owner/:repo/info/refs', (req, res) => {
    const service = req.query.service;
    if (!ALLOWED_SERVICES.has(service)) {
      res
        .status(403)
        .type('text/plain')
        .send('dumb HTTP protocol is not supported; use Smart HTTP\n');
      return;
    }

    const repoPath = resolveBarePath(req, res);
    if (!repoPath) return;

    const verb = service === 'git-receive-pack' ? 'receive-pack' : 'upload-pack';
    const git = spawnGit(
      [verb, '--stateless-rpc', '--advertise-refs', repoPath],
      repoPath
    );

    noCache(res);
    res.setHeader('Content-Type', `application/x-${service}-advertisement`);

    const banner = pktLine(`# service=${service}\n`);
    const flush = Buffer.from('0000', 'utf8');

    git.on('error', (err) => {
      if (!res.headersSent) {
        const msg =
          err.code === 'ENOENT' ? 'git binary not found\n' : 'failed to spawn git\n';
        res.status(500).type('text/plain').send(msg);
      } else {
        res.destroy(err);
      }
    });

    git.stderr.on('data', (chunk) => {
      process.stderr.write(`[git ${verb} advertise] ${chunk}`);
    });

    // Write the Smart HTTP prefix, then stream advertise-refs stdout.
    res.write(banner);
    res.write(flush);
    git.stdout.pipe(res);
  });

  /**
   * POST /repos/:owner/:repo/git-receive-pack  (git push)
   */
  router.post('/:owner/:repo/git-receive-pack', (req, res) => {
    const repoPath = resolveBarePath(req, res);
    if (!repoPath) return;
    pipePackPost(req, res, repoPath, 'git-receive-pack');
  });

  /**
   * POST /repos/:owner/:repo/git-upload-pack  (git fetch / clone)
   */
  router.post('/:owner/:repo/git-upload-pack', (req, res) => {
    const repoPath = resolveBarePath(req, res);
    if (!repoPath) return;
    pipePackPost(req, res, repoPath, 'git-upload-pack');
  });

  // Unmatched /repos/* (e.g. HTML create form) continues to the web app.
  router.use((req, res, next) => next('router'));

  return router;
}

module.exports = {
  createGitHttpRouter,
  pktLine,
};
