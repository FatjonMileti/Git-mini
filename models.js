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

function ensureColumn(database, table, column, definition) {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((entry) => entry.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function initSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      bio TEXT NOT NULL DEFAULT '',
      default_private INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      public_key TEXT NOT NULL,
      key_type TEXT NOT NULL DEFAULT '',
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Migrate databases created before account settings existed.
  ensureColumn(database, 'users', 'display_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'users', 'email', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'users', 'bio', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(database, 'users', 'default_private', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
    ON users (email COLLATE NOCASE)
    WHERE email <> '';
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

const USER_COLUMNS = `
  id, username, display_name, email, bio, default_private, token_version
`;

function findUserById(id) {
  return getDb().prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id) || null;
}

function findUserByUsername(username) {
  return (
    getDb()
      .prepare(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?`)
      .get(username) || null
  );
}

function findUserByEmail(email) {
  if (!email) return null;
  return (
    getDb()
      .prepare('SELECT id, username FROM users WHERE email = ? COLLATE NOCASE AND email <> \'\'')
      .get(email) || null
  );
}

function authenticate(username, password) {
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return findUserById(user.id);
}

function verifyUserPassword(userId, password) {
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  return Boolean(row && verifyPassword(password, row.password_hash));
}

function updateUserProfile(userId, { displayName, email, bio, defaultPrivate }) {
  const info = getDb()
    .prepare(
      `
      UPDATE users
      SET display_name = ?, email = ?, bio = ?, default_private = ?
      WHERE id = ?
    `
    )
    .run(displayName, email, bio, defaultPrivate ? 1 : 0, userId);
  return info.changes > 0 ? findUserById(userId) : null;
}

function updateUserPassword(userId, newPassword) {
  const info = getDb()
    .prepare(
      `
      UPDATE users
      SET password_hash = ?, token_version = token_version + 1
      WHERE id = ?
    `
    )
    .run(hashPassword(newPassword), userId);
  return info.changes > 0 ? findUserById(userId) : null;
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

function isRepositoryOwner(repo, viewerId) {
  return Boolean(repo && viewerId && Number(viewerId) === Number(repo.owner_id));
}

function listSshKeys(userId) {
  return getDb()
    .prepare(
      `
      SELECT id, title, public_key, key_type, fingerprint, created_at
      FROM ssh_keys
      WHERE user_id = ?
      ORDER BY created_at DESC, id DESC
    `
    )
    .all(userId);
}

function findSshKeyByFingerprint(fingerprint) {
  return (
    getDb()
      .prepare(
        `
        SELECT k.id, k.user_id, k.title, k.public_key, k.key_type, k.fingerprint,
               u.username
        FROM ssh_keys k
        JOIN users u ON u.id = k.user_id
        WHERE k.fingerprint = ?
      `
      )
      .get(fingerprint) || null
  );
}

function createSshKey({ userId, title, publicKey, keyType, fingerprint }) {
  const info = getDb()
    .prepare(
      `
      INSERT INTO ssh_keys (user_id, title, public_key, key_type, fingerprint)
      VALUES (?, ?, ?, ?, ?)
    `
    )
    .run(userId, title || '', publicKey, keyType || '', fingerprint);
  return info.lastInsertRowid;
}

function deleteSshKey(id, userId) {
  return getDb()
    .prepare('DELETE FROM ssh_keys WHERE id = ? AND user_id = ?')
    .run(id, userId).changes > 0;
}

function deleteRepository(owner, name) {
  const repo = getRepository(owner, name);
  if (!repo) return false;
  const info = getDb()
    .prepare('DELETE FROM repositories WHERE id = ?')
    .run(repo.id);
  return info.changes > 0;
}

module.exports = {
  init,
  hashPassword,
  verifyPassword,
  createUser,
  findUserById,
  findUserByUsername,
  findUserByEmail,
  authenticate,
  verifyUserPassword,
  updateUserProfile,
  updateUserPassword,
  createRepository,
  getRepositoryById,
  getRepository,
  listRepositoriesForViewer,
  canViewRepository,
  isRepositoryOwner,
  deleteRepository,
  listSshKeys,
  findSshKeyByFingerprint,
  createSshKey,
  deleteSshKey,
};
