const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ROOT } = require('./config');

const db = new DatabaseSync(path.join(ROOT, 'data.db'));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
  salt TEXT NOT NULL, passhash TEXT NOT NULL, nickname TEXT DEFAULT '', bio TEXT DEFAULT '', avatar TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS tokens(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS books(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  author TEXT DEFAULT '', note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
  url TEXT DEFAULT '', content TEXT NOT NULL,
  summary TEXT DEFAULT '', one_sentence TEXT DEFAULT '',
  minutes INTEGER DEFAULT 3, tags TEXT DEFAULT '[]',
  folder_id INTEGER, book_id INTEGER,
  author_name TEXT DEFAULT '', recommend_note TEXT DEFAULT '',
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
  idx INTEGER NOT NULL, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comment_likes(
  comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(comment_id,user_id));
CREATE TABLE IF NOT EXISTS comment_favs(
  comment_id INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(comment_id,user_id));
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
  user_id INTEGER, user_name TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
`);

// ---------- 旧库迁移（单用户 -> 多用户、新增字段） ----------
for (const t of ['items', 'folders', 'books']) {
  try { db.exec('ALTER TABLE ' + t + ' ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1'); } catch (e) {}
}
try { db.exec('ALTER TABLE comments ADD COLUMN user_id INTEGER'); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''"); } catch (e) {}
db.exec(`CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_item ON chunks(item_id);`);

module.exports = db;