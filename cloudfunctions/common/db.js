"use strict";

const path = require("path");
const os = require("os");
const Database = require("better-sqlite3");
const { AppError, ErrorCode } = require("./errors");

let _db = null;

function getDbPath() {
  const envPath = process.env.APP_DB_PATH;
  if (envPath) {
    const expanded = envPath.startsWith("~")
      ? path.join(os.homedir(), envPath.slice(1))
      : envPath;
    return path.resolve(expanded);
  }
  return path.resolve(__dirname, "..", "..", "backend", "data", "app.db");
}

function initDb() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  require("fs").mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS _healthcheck (
      id INTEGER PRIMARY KEY,
      touched_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      date TEXT NOT NULL,
      budget REAL NOT NULL,
      people_count INTEGER NOT NULL,
      preferences TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      longitude REAL NOT NULL,
      latitude REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES plans (id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS itinerary_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL,
      day_index INTEGER NOT NULL DEFAULT 1,
      label TEXT NOT NULL,
      start_minute INTEGER NULL,
      end_minute INTEGER NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS itinerary_slot_places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL,
      place_id INTEGER NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (slot_id) REFERENCES itinerary_slots (id) ON DELETE CASCADE,
      FOREIGN KEY (place_id) REFERENCES places (id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_check_cache (
      plan_id INTEGER PRIMARY KEY,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
    );
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_places_plan_id ON places (plan_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_itinerary_slots_plan_id ON itinerary_slots (plan_id);`);

  const slotColumns = db.pragma("table_info(itinerary_slots)");
  const slotColumnNames = new Set(slotColumns.map((r) => r.name));
  if (!slotColumnNames.has("day_index")) {
    db.exec("ALTER TABLE itinerary_slots ADD COLUMN day_index INTEGER NOT NULL DEFAULT 1;");
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_itinerary_slot_places_slot_id ON itinerary_slot_places (slot_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_itinerary_slot_places_place_id ON itinerary_slot_places (place_id);`);

  return db;
}

function getDb() {
  if (_db && _db.open) {
    return _db;
  }
  _db = initDb();
  return _db;
}

function dbConn() {
  return getDb();
}

function closeDb() {
  if (_db && _db.open) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDbPath, initDb, getDb, dbConn, closeDb };
