import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from './config.js';
export const db = new Database(path.join(config.dataDir, 'doddled.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,account_id TEXT UNIQUE,email TEXT,name TEXT,plan TEXT,auth_method TEXT NOT NULL,tokens TEXT);
CREATE TABLE IF NOT EXISTS user_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS builtin_seeds(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS notes_user ON notes(user_id);
CREATE TABLE IF NOT EXISTS riddlers(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS annotations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS annotations_note ON annotations(user_id,note_id);
CREATE TABLE IF NOT EXISTS reviews(note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,content_hash TEXT,last_spoke INTEGER NOT NULL DEFAULT 0);
`);
