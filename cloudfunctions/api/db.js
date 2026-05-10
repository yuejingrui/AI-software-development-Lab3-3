"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const initSqlJs = require("sql.js");

let _wrappedDb = null;
let _SQL = null;

// ─── CloudBase persistence ───────────────────────────────────────────────────

const DB_BACKUP_PATH = "db-backup/app.db";
const DB_BACKUP_SNAPSHOT_PREFIX = "db-backup/snapshots";
const DB_BACKUP_MANIFEST_PATH = "db-backup/latest.json";
const STORAGE_BUCKET = "6c61-lab3-3-d5gdcm7qo10ced8af-1427379735";
const ENV_ID = process.env.TCB_ENV_ID || "lab3-3-d5gdcm7qo10ced8af";
const DB_FILE_ID = `cloud://${ENV_ID}.${STORAGE_BUCKET}/${DB_BACKUP_PATH}`;
const DB_MANIFEST_FILE_ID = `cloud://${ENV_ID}.${STORAGE_BUCKET}/${DB_BACKUP_MANIFEST_PATH}`;
const META_COLLECTION = "_lab33_meta";
const META_DOC_ID = "sqlite_backup_meta";

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

function buildFileIdByPath(cloudPath) {
  return `cloud://${ENV_ID}.${STORAGE_BUCKET}/${cloudPath}`;
}

function snapshotCloudPath() {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `${DB_BACKUP_SNAPSHOT_PREFIX}/app-${Date.now()}-${nonce}.db`;
}

function parseDocData(docResult) {
  if (!docResult) return null;
  if (Array.isArray(docResult.data)) return docResult.data[0] || null;
  if (docResult.data && typeof docResult.data === "object") return docResult.data;
  return null;
}

async function getLatestBackupMeta(app) {
  try {
    const db = app.database();
    const docResult = await db.collection(META_COLLECTION).doc(META_DOC_ID).get();
    const data = parseDocData(docResult);
    if (!data) return null;
    const cloudPath = String(data.cloud_path || "").trim();
    const fileID = String(data.file_id || "").trim();
    if (!cloudPath && !fileID) return null;
    return { cloudPath, fileID };
  } catch (e) {
    console.log("[db] getLatestBackupMeta failed:", e.message);
    return null;
  }
}

async function saveLatestBackupMeta(app, cloudPath, fileID) {
  const db = app.database();
  const payload = {
    _id: META_DOC_ID,
    cloud_path: cloudPath,
    file_id: fileID,
    updated_at: new Date().toISOString(),
  };
  try {
    await db.collection(META_COLLECTION).doc(META_DOC_ID).set(payload);
  } catch (e) {
    console.error("[db] saveLatestBackupMeta failed:", e.message);
    try {
      await db.createCollection(META_COLLECTION);
      await db.collection(META_COLLECTION).doc(META_DOC_ID).set(payload);
      console.log("[db] saveLatestBackupMeta: collection created and meta saved");
    } catch (e2) {
      console.error("[db] saveLatestBackupMeta retry failed:", e2.message);
    }
  }
}

async function downloadDbFromCloud(dbPath) {
  try {
    const app = getTcbApp();
    if (!app) { console.log("[db] downloadDb: no SDK app, skip"); return false; }

    let manifestMeta = null;
    try {
      const manifestResult = await app.downloadFile({ fileID: DB_MANIFEST_FILE_ID });
      const manifestContent = manifestResult && manifestResult.fileContent ? manifestResult.fileContent : null;
      if (manifestContent) {
        const manifestText = Buffer.isBuffer(manifestContent)
          ? manifestContent.toString("utf8")
          : Buffer.from(manifestContent, "base64").toString("utf8");
        const manifest = JSON.parse(manifestText);
        const fileID = String(manifest.file_id || "").trim();
        const cloudPath = String(manifest.cloud_path || "").trim();
        if (fileID || cloudPath) {
          manifestMeta = { fileID, cloudPath };
        }
      }
    } catch (e) {
      console.log("[db] download manifest failed:", e.message);
    }

    const latestMeta = manifestMeta || await getLatestBackupMeta(app);
    const downloadTargets = [];
    if (latestMeta) {
      if (latestMeta.fileID) downloadTargets.push({ fileID: latestMeta.fileID, source: "meta:fileID" });
      if (latestMeta.cloudPath) downloadTargets.push({ fileID: buildFileIdByPath(latestMeta.cloudPath), source: "meta:cloudPath" });
    }
    downloadTargets.push({ fileID: DB_FILE_ID, source: "legacy:fileID" });

    let result;
    for (const target of downloadTargets) {
      try {
        result = await app.downloadFile({ fileID: target.fileID });
        if (result && result.fileContent) {
          console.log("[db] downloadDb: hit", target.source);
          break;
        }
      } catch (e) {
        console.log(`[db] downloadFile(${target.source}) threw:`, e.message);
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
  const cloudPath = snapshotCloudPath();
  return (async () => {
    try {
      const snapshotRes = await app.uploadFile({ cloudPath, fileContent: data });
      const snapshotFileID = snapshotRes && snapshotRes.fileID ? snapshotRes.fileID : "";
      if (snapshotFileID) {
        console.log("[db] Database backed up to snapshot:", snapshotFileID);
        await saveLatestBackupMeta(app, cloudPath, snapshotFileID);
        const manifest = Buffer.from(
          JSON.stringify(
            {
              cloud_path: cloudPath,
              file_id: snapshotFileID,
              updated_at: new Date().toISOString(),
            },
            null,
            2
          ),
          "utf8"
        );
        await app.uploadFile({ cloudPath: DB_BACKUP_MANIFEST_PATH, fileContent: manifest });
      } else {
        console.log("[db] snapshot upload returned:", JSON.stringify(snapshotRes));
      }
      // Keep legacy path updated as hard fallback when meta/manifest is unavailable.
      const legacyRes = await app.uploadFile({ cloudPath: DB_BACKUP_PATH, fileContent: data });
      if (legacyRes && legacyRes.fileID) {
        console.log("[db] Database mirrored to legacy path:", legacyRes.fileID);
      }
    } catch (e) {
      console.error("[db] Async upload failed:", e.message);
    }
  })();
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

let _pendingBackup = Promise.resolve();

function chainBackup(dbPath) {
  _pendingBackup = _pendingBackup
    .then(() => uploadDbToCloud(dbPath))
    .catch(() => {});
  return _pendingBackup;
}

function finishBackups(maxWaitMs = 0) {
  if (maxWaitMs <= 0) return Promise.resolve();
  console.log("[db] finishBackups: waiting up to", maxWaitMs, "ms for pending upload chain");
  return Promise.race([
    _pendingBackup,
    new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
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
        try {
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
        } catch (e) {
          try { db.exec("ROLLBACK"); } catch (_) { /* ignore rollback errors */ }
          throw e;
        }
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

async function ensureDb(options = {}) {
  const forceReload = Boolean(options.forceReload);
  // Keep one in-memory DB per warm instance to guarantee read-after-write
  // consistency for sequential API calls (e.g. add/remove place + refresh list).
  if (!forceReload && _wrappedDb && _SQL) {
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
