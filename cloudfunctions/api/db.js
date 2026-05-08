"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const initSqlJs = require("sql.js");

let _wrappedDb = null;
let _SQL = null;

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

function _saveDb(sqlDb, dbPath) {
  const data = sqlDb.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
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

async function initDb() {
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

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

  for (const ddl of DDL) {
    sqlDb.run(ddl);
  }

  // Migration: add day_index column if missing
  const tableInfo = sqlDb.exec("PRAGMA table_info(itinerary_slots)");
  if (tableInfo.length > 0) {
    const colNames = tableInfo[0].values.map((r) => r[1]);
    if (!colNames.includes("day_index")) {
      sqlDb.run("ALTER TABLE itinerary_slots ADD COLUMN day_index INTEGER NOT NULL DEFAULT 1");
    }
  }

  _saveDb(sqlDb, dbPath);

  const wrapper = { _sqlDb: sqlDb, _dbPath: dbPath };

  wrapper.prepare = function (sql) {
    return {
      _sql: sql,

      get(...args) {
        const fullSql = _buildSql(sql, args);
        const results = sqlDb.exec(fullSql);
        return _resultToObject(results);
      },

      all(...args) {
        const fullSql = _buildSql(sql, args);
        const results = sqlDb.exec(fullSql);
        return _resultToObjects(results);
      },

      run(...args) {
        const fullSql = _buildSql(sql, args);
        // Wrap in explicit transaction so last_insert_rowid() works
        sqlDb.exec("BEGIN");
        sqlDb.exec(fullSql);
        const idRow = sqlDb.exec("SELECT last_insert_rowid()");
        const chRow = sqlDb.exec("SELECT changes()");
        sqlDb.exec("COMMIT");
        _saveDb(sqlDb, dbPath);
        return {
          lastInsertRowid: idRow.length > 0 && idRow[0].values.length > 0 ? idRow[0].values[0][0] : 0,
          changes: chRow.length > 0 && chRow[0].values.length > 0 ? chRow[0].values[0][0] : 0,
        };
      },
    };
  };

  wrapper.exec = function (sql) {
    sqlDb.run(sql);
    _saveDb(sqlDb, dbPath);
  };

  _wrappedDb = wrapper;
  return wrapper;
}

function dbConn() {
  return _wrappedDb;
}

async function ensureDb() {
  if (_wrappedDb) return _wrappedDb;
  return await initDb();
}

module.exports = { getDbPath, initDb, dbConn, ensureDb };
