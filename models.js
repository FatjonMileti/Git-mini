'use strict';

/**
 * DATABASE & MODELS
 *
 * Lightweight SQLite persistence for users and repository metadata.
 * Bare Git objects live on disk (see gitCore.js); this module only tracks
 * who owns which repo and whether it is listed publicly.
 */

const crypto = require('crypto');
const Database = require('better-sqlite3');
const { DB_PATH, ensureStorageDirs } = require('./config');

const SCRYPT_KEYLEN = 64;

let db;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function initSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (owner_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_repos_public ON repositories (is_private, name);
  `);
}

function seedDefaultUser(database) {
  const count = database.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  database.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    'admin',
    hashPassword('admin')
  );
}

function init() {
  ensureStorageDirs();
  db = new Database(DB_PATH);
  initSchema(db);
  seedDefaultUser(db);
  return db;
}

function getDb() {
  if (!db) init();
  return db;
}

function createUser(username, password) {
  const stmt = getDb().prepare(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)'
  );
  const info = stmt.run(username, hashPassword(password));
  return findUserById(info.lastInsertRowid);
}

function findUserById(id) {
  return getDb().prepare('SELECT id, username FROM users WHERE id = ?').get(id) || null;
}

function findUserByUsername(username) {
  return (
    getDb()
      .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
      .get(username) || null
  );
}

function authenticate(username, password) {
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, username: user.username };
}

function createRepository({ name, ownerId, isPrivate, description }) {
  const stmt = getDb().prepare(`
    INSERT INTO repositories (name, owner_id, is_private, description)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(name, ownerId, isPrivate ? 1 : 0, description || '');
  return getRepositoryById(info.lastInsertRowid);
}

function getRepositoryById(id) {
  return (
    getDb()
      .prepare(
        `
        SELECT r.id, r.name, r.owner_id, r.is_private, r.description, r.created_at,
               u.username AS owner
        FROM repositories r
        JOIN users u ON u.id = r.owner_id
        WHERE r.id = ?
      `
      )
      .get(id) || null
  );
}

function getRepository(owner, name) {
  return (
    getDb()
      .prepare(
        `
        SELECT r.id, r.name, r.owner_id, r.is_private, r.description, r.created_at,
               u.username AS owner
        FROM repositories r
        JOIN users u ON u.id = r.owner_id
        WHERE u.username = ? AND r.name = ?
      `
      )
      .get(owner, name) || null
  );
}

/**
 * Public repos for everyone, plus the current user's private repos.
 */
function listRepositoriesForViewer(viewerId) {
  return getDb()
    .prepare(
      `
      SELECT r.id, r.name, r.owner_id, r.is_private, r.description, r.created_at,
             u.username AS owner
      FROM repositories r
      JOIN users u ON u.id = r.owner_id
      WHERE r.is_private = 0 OR r.owner_id = ?
      ORDER BY r.created_at DESC
    `
    )
    .all(viewerId || -1);
}

function canViewRepository(repo, viewerId) {
  if (!repo) return false;
  if (!repo.is_private) return true;
  return Boolean(viewerId && Number(viewerId) === Number(repo.owner_id));
}

module.exports = {
  init,
  hashPassword,
  verifyPassword,
  createUser,
  findUserById,
  findUserByUsername,
  authenticate,
  createRepository,
  getRepositoryById,
  getRepository,
  listRepositoriesForViewer,
  canViewRepository,
};
