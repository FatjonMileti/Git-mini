'use strict';

const path = require('path');
const fs = require('fs');

/** Root directory for the SQLite file and bare Git repos. */
const STORAGE_ROOT = path.join(__dirname, 'storage');
const REPOS_ROOT = path.join(STORAGE_ROOT, 'repos');
const DB_PATH = path.join(STORAGE_ROOT, 'gitea-clone.db');

const PORT = Number(process.env.PORT) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-me';

function ensureStorageDirs() {
  fs.mkdirSync(REPOS_ROOT, { recursive: true });
}

module.exports = {
  STORAGE_ROOT,
  REPOS_ROOT,
  DB_PATH,
  PORT,
  SESSION_SECRET,
  ensureStorageDirs,
};
