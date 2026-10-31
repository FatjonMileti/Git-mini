'use strict';

/**
 * SSH GIT TRANSPORT
 *
 * Embedded SSH server (ssh2) that only allows Git pack commands. Repositories
 * are served by the system `git` binary through child_process, exactly like
 * Smart HTTP, and keys are stored in SQLite.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Server, utils } = require('ssh2');

const {
  SSH_ENABLED,
  SSH_PORT,
  SSH_HOST,
  SSH_HOST_KEY_PATH,
} = require('./config');
const models = require('./models');
const gitCore = require('./gitCore');

const GIT_COMMAND = /^(git-upload-pack|git-receive-pack)\s+(.+)$/;
const ALLOWED_ENV = new Set(['GIT_PROTOCOL']);

function fingerprintForKeyData(data) {
  const digest = crypto.createHash('sha256').update(data).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Validates and normalizes an authorized_keys-style public key line.
 */
function parseAuthorizedKey(input) {
  const text = String(input || '').trim();
  if (!text) throw new Error('Paste an SSH public key.');
  if (text.length > 16384) throw new Error('That public key is too long.');
  if (/PRIVATE KEY/.test(text)) {
    throw new Error('That looks like a private key. Add the matching .pub file instead.');
  }

  const parsed = utils.parseKey(text);
  if (Array.isArray(parsed)) {
    throw new Error('Add one public key at a time.');
  }
  if (!parsed || parsed instanceof Error) {
    throw new Error('Could not parse that public key. Use an OpenSSH .pub line.');
  }
  if (parsed.isPrivateKey()) {
    throw new Error('Add the .pub file, not the private key.');
  }

  const data = parsed.getPublicSSH();
  const type = parsed.type;
  return {
    publicKey: `${type} ${data.toString('base64')}`,
    type,
    fingerprint: fingerprintForKeyData(data),
    comment: parsed.comment || '',
  };
}

function ensureHostKey() {
  if (fs.existsSync(SSH_HOST_KEY_PATH)) {
    return fs.readFileSync(SSH_HOST_KEY_PATH);
  }

  fs.mkdirSync(path.dirname(SSH_HOST_KEY_PATH), { recursive: true });
  const pair = utils.generateKeyPairSync('ed25519');
  fs.writeFileSync(SSH_HOST_KEY_PATH, pair.private, { mode: 0o600 });
  fs.writeFileSync(`${SSH_HOST_KEY_PATH}.pub`, pair.public, { mode: 0o644 });
  console.log(`Generated SSH host key at ${SSH_HOST_KEY_PATH}`);
  return Buffer.from(pair.private);
}

function parseGitCommand(command) {
  const match = String(command || '').trim().match(GIT_COMMAND);
  if (!match) return null;

  let target = match[2].trim();
  if (
    (target.startsWith("'") && target.endsWith("'")) ||
    (target.startsWith('"') && target.endsWith('"'))
  ) {
    target = target.slice(1, -1);
  }

  target = target.replace(/^~\/?/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  target = gitCore.stripGitSuffix(target);
  const parts = target.split('/').filter(Boolean);
  if (parts.length !== 2) return null;

  return { service: match[1], owner: parts[0], repo: parts[1] };
}

function rejectChannel(stream, message, code = 1) {
  if (message) stream.stderr.write(`${message}\n`);
  stream.exit(code);
  stream.end();
}

function serveGit(stream, service, repoPath, env) {
  const verb = service === 'git-receive-pack' ? 'receive-pack' : 'upload-pack';
  const child = spawn('git', [verb, repoPath], {
    cwd: repoPath,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });

  let finished = false;
  const finish = (code, message) => {
    if (finished) return;
    finished = true;
    if (message) stream.stderr.write(`${message}\n`);
    stream.exit(code);
    stream.end();
  };

  child.on('error', (err) => {
    finish(
      err.code === 'ENOENT' ? 127 : 128,
      err.code === 'ENOENT' ? 'git binary not found on PATH' : 'failed to start git'
    );
  });
  child.on('close', (code) => finish(code || 0));

  stream.on('close', () => {
    if (!finished) child.kill();
  });
  stream.on('error', () => {
    if (!finished) child.kill();
  });

  stream.pipe(child.stdin);
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream.stderr, { end: false });
}

function authorize(authUser, service, owner, repo) {
  const record = models.getRepository(owner, repo);
  if (!record) {
    return { error: 'Repository not found.' };
  }

  const isOwner = Number(record.owner_id) === Number(authUser.id);
  if (service === 'git-receive-pack' && !isOwner) {
    return { error: 'You do not have write access to this repository.' };
  }
  if (service === 'git-upload-pack' && record.is_private && !isOwner) {
    return { error: 'Repository not found.' };
  }

  return { record };
}

function handleConnection(client, log) {
  let authUser = null;

  client.on('authentication', (ctx) => {
    if (ctx.method === 'publickey') {
      const fingerprint = fingerprintForKeyData(ctx.key.data);
      const record = models.findSshKeyByFingerprint(fingerprint);
      if (!record) return ctx.reject(['publickey', 'password']);

      let parsed;
      try {
        parsed = utils.parseKey(
          `${ctx.key.algo} ${ctx.key.data.toString('base64')}`
        );
      } catch {
        return ctx.reject(['publickey', 'password']);
      }
      if (
        !parsed ||
        parsed instanceof Error ||
        parsed.getPublicSSH().compare(ctx.key.data) !== 0
      ) {
        return ctx.reject(['publickey', 'password']);
      }

      if (ctx.signature) {
        if (parsed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) {
          return ctx.reject(['publickey', 'password']);
        }
        authUser = { id: record.user_id, username: record.username };
      }
      return ctx.accept();
    }

    if (ctx.method === 'password') {
      const user = models.authenticate(ctx.username, ctx.password);
      if (!user) return ctx.reject(['publickey', 'password']);
      authUser = user;
      return ctx.accept();
    }

    return ctx.reject(['publickey', 'password']);
  });

  client.on('ready', () => {
    if (!authUser) {
      client.end();
      return;
    }

    client.on('session', (accept) => {
      const session = accept();
      const env = {};

      session.on('env', (acceptEnv, rejectEnv, info) => {
        const allowed = ALLOWED_ENV.has(info.key);
        if (allowed) env[info.key] = info.val;
        const respond = allowed ? acceptEnv : rejectEnv;
        if (typeof respond === 'function') respond();
      });

      session.on('pty', (acceptPty, rejectPty) => {
        if (typeof rejectPty === 'function') rejectPty();
      });
      session.on('shell', (acceptShell, rejectShell) => {
        if (typeof rejectShell === 'function') rejectShell();
      });
      session.on('subsystem', (acceptSub, rejectSub) => {
        if (typeof rejectSub === 'function') rejectSub();
      });

      session.on('exec', (acceptExec, rejectExec, info) => {
        if (typeof acceptExec !== 'function') return;
        const parsed = parseGitCommand(info.command);
        if (!parsed) {
          const stream = acceptExec();
          rejectChannel(
            stream,
            'This SSH server only supports git-upload-pack and git-receive-pack.'
          );
          return;
        }

        const access = authorize(authUser, parsed.service, parsed.owner, parsed.repo);
        if (access.error) {
          const stream = acceptExec();
          rejectChannel(stream, access.error, 1);
          return;
        }

        let repoPath;
        try {
          repoPath = gitCore.getRepoPath(parsed.owner, parsed.repo);
        } catch {
          const stream = acceptExec();
          rejectChannel(stream, 'Invalid repository path.', 1);
          return;
        }

        if (!fs.existsSync(path.join(repoPath, 'HEAD'))) {
          const stream = acceptExec();
          rejectChannel(stream, 'Repository folder is missing on disk.', 1);
          return;
        }

        const stream = acceptExec();
        log(
          `${authUser.username} ${parsed.service === 'git-receive-pack' ? 'push' : 'fetch'} ${parsed.owner}/${parsed.repo}`
        );
        serveGit(stream, parsed.service, repoPath, env);
      });
    });
  });

  client.on('error', (err) => {
    log(`connection error: ${err.message}`);
  });
}

function startSshServer() {
  if (!SSH_ENABLED) return null;

  let hostKey;
  try {
    hostKey = ensureHostKey();
  } catch (err) {
    console.error(`SSH disabled: ${err.message}`);
    return null;
  }

  const log = (message) => console.log(`[ssh] ${message}`);
  const server = new Server({ hostKeys: [hostKey] }, (client) =>
    handleConnection(client, log)
  );

  server.on('error', (err) => {
    console.error(`SSH server error: ${err.message}`);
  });

  server.listen(SSH_PORT, SSH_HOST, () => {
    const host = SSH_HOST === '0.0.0.0' || SSH_HOST === '::' ? 'localhost' : SSH_HOST;
    console.log(`SSH transport listening on ssh://git@${host}:${SSH_PORT}`);
  });

  return server;
}

module.exports = {
  parseAuthorizedKey,
  fingerprintForKeyData,
  parseGitCommand,
  startSshServer,
};
