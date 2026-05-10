"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const initSqlJs = require("sql.js");

let _wrappedDb = null;
let _SQL = null;

// ─── CloudBase persistence ───────────────────────────────────────────────────

const DB_BACKUP_PATH = "db-backup/app.db";
const STORAGE_BUCKET = "6c61-lab3-3-d5gdcm7qo10ced8af-1427379735";
const ENV_ID = process.env.TCB_ENV_ID || "lab3-3-d5gdcm7qo10ced8af";
const DB_FILE_ID = `cloud://${ENV_ID}.${STORAGE_BUCKET}/${DB_BACKUP_PATH}`;

let _tcbApp = null;
function getTcbApp() {
  if (_tcbApp) return _tcbApp;
  try {
    const cloudbase = require("@cloudbase/node-sdk");
    _tcbApp = cloudbase.init({ env: ENV_ID });
    console.log("[db] CloudBase SDK initialized for env:", ENV_ID);
  } catch (e) {
    console.error("[db] CloudBase SDK init failed:", e.message);
    _tcbApp = null;
  }
  return _tcbApp;
}

async function downloadDbFromCloud(dbPath) {
  try {
    const app = getTcbApp();
    if (!app) { console.log("[db] downloadDb: no SDK app, skip"); return false; }

    let result;
    // Try cloudPath first (same path used for upload), then fileID as fallback.
    // cloudPath avoids potential CDN caching issues that fileID-based downloads may hit.
    try {
      result = await app.downloadFile({ cloudPath: DB_BACKUP_PATH });
    } catch (e) {
      console.log("[db] downloadFile(cloudPath) threw:", e.message);
      result = null;
    }

    if (!result || !result.fileContent) {
      console.log("[db] downloadFile(cloudPath) returned no fileContent, trying fileID");
      try {
        result = await app.downloadFile({ fileID: DB_FILE_ID });
      } catch (e) {
        console.log("[db] downloadFile(fileID) threw:", e.message);
        result = null;
      }
    }

    // Handle different SDK return shapes (Buffer or base64 string)
    const content = (result && result.fileContent) ? result.fileContent : null;
    if (content) {
      // fileContent could be Buffer or base64 string depending on SDK version
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "base64");
      fs.writeFileSync(dbPath, buf);
      console.log("[db] Database restored from cloud, size:", buf.length, "bytes");
      return true;
    }
    console.log("[db] downloadDb: no content to restore");
    return false;
  } catch (e) {
    console.error("[db] Failed to download database backup:", e.message);
    return false;
  }
}

function uploadDbToCloud(dbPath) {
  const app = getTcbApp();
  if (!app) { console.log("[db] uploadDb: no SDK app, skip"); return Promise.resolve(); }
  let data;
  try {
    data = fs.readFileSync(dbPath);
    console.log("[db] uploadDb: read", data.length, "bytes from", dbPath);
  } catch (e) {
    console.error("[db] Failed to read db for backup:", e.message);
    return Promise.resolve();
  }
  return app.uploadFile({ cloudPath: DB_BACKUP_PATH, fileContent: data })
    .then((res) => {
      if (res && res.fileID) console.log("[db] Database backed up to:", res.fileID);
      else console.log("[db] uploadFile returned:", JSON.stringify(res));
    })
    .catch((e) => console.error("[db] Async upload failed:", e.message));
}

// ─── Database core ───────────────────────────────────────────────────────────

function getDbPath() {
  const envPath = process.env.APP_DB_PATH;
  if (envPath) {
    const expanded = envPath.startsWith("~")
      ? path.join(os.homedir(), envPath.slice(1))
      : envPath;
    return path.resolve(expanded);
  }
  return "/tmp/app.db";
}

function _saveDb(sqlDb, dbPath, caller) {
  const data = sqlDb.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(dbPath, buf);
  console.log("[db] _saveDb (", caller || "unknown", ") wrote", buf.length, "bytes");
  chainBackup(dbPath);
}

function _toArray(args) {
  if (!args || args.length === 0) return [];
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return Array.from(args);
}

function _escape(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : "NULL";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function _buildSql(sql, args) {
  const params = _toArray(args);
  let i = 0;
  return sql.replace(/\?/g, () => _escape(params[i++]));
}

function _resultToObjects(execResult) {
  if (!execResult || execResult.length === 0) return [];
  const { columns, values } = execResult[0];
  return values.map((row) => {
    const obj = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = row[i];
    }
    return obj;
  });
}

function _resultToObject(execResult) {
  const rows = _resultToObjects(execResult);
  return rows.length > 0 ? rows[0] : null;
}

let _pendingBackup = null;

function finishBackups() {
  if (_pendingBackup) {
    const p = _pendingBackup;
    _pendingBackup = null;
    console.log("[db] finishBackups: awaiting pending upload chain");
    return p;
  }
  return Promise.resolve();
}

function chainBackup(dbPath) {
  const next = (_pendingBackup || Promise.resolve())
    .then(() => uploadDbToCloud(dbPath))
    .catch(() => {});
  _pendingBackup = next;
  return next;
}

// ─── DDL ─────────────────────────────────────────────────────────────────────

const DDL = [
  "CREATE TABLE IF NOT EXISTS _healthcheck (id INTEGER PRIMARY KEY, touched_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, date TEXT NOT NULL, budget REAL NOT NULL, people_count INTEGER NOT NULL, preferences TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS places (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL, longitude REAL NOT NULL, latitude REAL NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (plan_id) REFERENCES plans (id))",
  "CREATE TABLE IF NOT EXISTS itinerary_slots (id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, day_index INTEGER NOT NULL DEFAULT 1, label TEXT NOT NULL, start_minute INTEGER NULL, end_minute INTEGER NULL, sort_index INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS itinerary_slot_places (id INTEGER PRIMARY KEY AUTOINCREMENT, slot_id INTEGER NOT NULL, place_id INTEGER NOT NULL, sort_index INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (slot_id) REFERENCES itinerary_slots (id) ON DELETE CASCADE, FOREIGN KEY (place_id) REFERENCES places (id) ON DELETE CASCADE)",
  "CREATE TABLE IF NOT EXISTS risk_check_cache (plan_id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE)",
  "CREATE INDEX IF NOT EXISTS idx_places_plan_id ON places (plan_id)",
  "CREATE INDEX IF NOT EXISTS idx_itinerary_slots_plan_id ON itinerary_slots (plan_id)",
  "CREATE INDEX IF NOT EXISTS idx_itinerary_slot_places_slot_id ON itinerary_slot_places (slot_id)",
  "CREATE INDEX IF NOT EXISTS idx_itinerary_slot_places_place_id ON itinerary_slot_places (place_id)",
];

function applyDDL(sqlDb) {
  for (const ddl of DDL) {
    sqlDb.run(ddl);
  }
  // Migration: ensure day_index column exists
  const tableInfo = sqlDb.exec("PRAGMA table_info(itinerary_slots)");
  if (tableInfo.length > 0) {
    const colNames = tableInfo[0].values.map((r) => r[1]);
    if (!colNames.includes("day_index")) {
      sqlDb.run("ALTER TABLE itinerary_slots ADD COLUMN day_index INTEGER NOT NULL DEFAULT 1");
      console.log("[db] Migration: added day_index column");
    }
  }
}

// ─── Wrapper ─────────────────────────────────────────────────────────────────

function createWrapper(sqlDb, dbPath) {
  const wrapper = { _sqlDb: sqlDb, _dbPath: dbPath };

  wrapper.prepare = function (sql) {
    const currentDb = () => _wrappedDb ? _wrappedDb._sqlDb : sqlDb;
    // short tag for log identification
    const tag = sql.substring(0, 40).replace(/\s+/g, " ").trim();

    return {
      _sql: sql,

      get(...args) {
        const fullSql = _buildSql(sql, args);
        const results = currentDb().exec(fullSql);
        return _resultToObject(results);
      },

      all(...args) {
        const fullSql = _buildSql(sql, args);
        const results = currentDb().exec(fullSql);
        return _resultToObjects(results);
      },

      run(...args) {
        const db = currentDb();
        const fullSql = _buildSql(sql, args);
        db.exec("BEGIN");
        db.exec(fullSql);
        const idRow = db.exec("SELECT last_insert_rowid()");
        const chRow = db.exec("SELECT changes()");
        db.exec("COMMIT");
        _saveDb(db, dbPath, tag);
        return {
          lastInsertRowid: idRow.length > 0 && idRow[0].values.length > 0 ? idRow[0].values[0][0] : 0,
          changes: chRow.length > 0 && chRow[0].values.length > 0 ? chRow[0].values[0][0] : 0,
        };
      },
    };
  };

  wrapper.exec = function (sql) {
    const db = _wrappedDb ? _wrappedDb._sqlDb : sqlDb;
    db.run(sql);
    _saveDb(db, dbPath, "exec:" + sql.substring(0, 30));
  };

  return wrapper;
}

// ─── Database initialization ─────────────────────────────────────────────────

async function initDb() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  await downloadDbFromCloud(dbPath);

  if (!_SQL) {
    _SQL = await initSqlJs();
  }

  let sqlDb;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    sqlDb = new _SQL.Database(buffer);
  } else {
    sqlDb = new _SQL.Database();
  }

  sqlDb.run("PRAGMA foreign_keys = ON");
  applyDDL(sqlDb);
  _saveDb(sqlDb, dbPath, "initDb");

  _wrappedDb = createWrapper(sqlDb, dbPath);
  return _wrappedDb;
}

async function ensureDb() {
  // Keep one in-memory DB per warm instance to guarantee read-after-write
  // consistency for sequential API calls (e.g. add/remove place + refresh list).
  if (_wrappedDb && _SQL) {
    return _wrappedDb;
  }

  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  console.log("[db] ensureDb: downloading from cloud...");
  const restored = await downloadDbFromCloud(dbPath);
  console.log("[db] ensureDb: download result =", restored);

  if (!_SQL) {
    _SQL = await initSqlJs();
  }

  let sqlDb;
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    console.log("[db] ensureDb: loading local file, size =", buffer.length, "bytes");
    sqlDb = new _SQL.Database(buffer);
  } else {
    console.log("[db] ensureDb: no local file, creating empty db");
    sqlDb = new _SQL.Database();
  }

  sqlDb.run("PRAGMA foreign_keys = ON");
  applyDDL(sqlDb);
  // Log place count for diagnostics
  const placeCount = sqlDb.exec("SELECT COUNT(*) AS cnt FROM places");
  if (placeCount.length > 0 && placeCount[0].values.length > 0) {
    console.log("[db] ensureDb: loaded db with", placeCount[0].values[0][0], "places");
  }

  _wrappedDb = createWrapper(sqlDb, dbPath);
  return _wrappedDb;
}

function dbConn() {
  return _wrappedDb;
}

module.exports = { getDbPath, initDb, dbConn, ensureDb, finishBackups };
