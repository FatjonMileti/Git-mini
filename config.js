'use strict';

const path = require('path');
const fs = require('fs');

/** Root directory for the SQLite file and bare Git repos. */
const STORAGE_ROOT = path.join(__dirname, 'storage');
const REPOS_ROOT = path.join(STORAGE_ROOT, 'repos');
const DB_PATH = path.join(STORAGE_ROOT, 'gitea-clone.db');
const SSH_HOST_KEY_PATH = path.join(STORAGE_ROOT, 'ssh_host_ed25519_key');

const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET =
  process.env.JWT_SECRET || process.env.SESSION_SECRET || 'dev-only-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const SSH_ENABLED = String(process.env.SSH_ENABLED || 'true').toLowerCase() !== 'false';
const SSH_PORT = Number(process.env.SSH_PORT) || 2222;
const SSH_HOST = process.env.SSH_HOST || '0.0.0.0';
const SSH_PUBLIC_HOST =
  process.env.SSH_PUBLIC_HOST || process.env.PUBLIC_HOST || '';

function ensureStorageDirs() {
  fs.mkdirSync(REPOS_ROOT, { recursive: true });
}

module.exports = {
  STORAGE_ROOT,
  REPOS_ROOT,
  DB_PATH,
  SSH_HOST_KEY_PATH,
  PORT,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  SSH_ENABLED,
  SSH_PORT,
  SSH_HOST,
  SSH_PUBLIC_HOST,
  ensureStorageDirs,
};
