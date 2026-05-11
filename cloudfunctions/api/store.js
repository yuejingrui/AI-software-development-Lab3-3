"use strict";

const cloudbase = require("@cloudbase/node-sdk");

const ENV_ID = process.env.TCB_ENV_ID || "lab3-3-d5gdcm7qo10ced8af";

const COLLECTIONS = {
  plans: "plans",
  places: "places",
  itinerarySlots: "itinerary_slots",
  itinerarySlotPlaces: "itinerary_slot_places",
  riskCheckCache: "risk_check_cache",
};

let _app = null;
let _db = null;
let _ensureCollectionsPromise = null;

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function getDb() {
  if (_db) return _db;
  _app = cloudbase.init({ env: ENV_ID });
  _db = _app.database();
  return _db;
}

async function ensureCollections() {
  if (_ensureCollectionsPromise) return _ensureCollectionsPromise;
  _ensureCollectionsPromise = (async () => {
    const db = getDb();
    const names = Object.values(COLLECTIONS);
    for (const name of names) {
      try {
        await db.createCollection(name);
      } catch (_) {
        // ignore when collection already exists
      }
    }
  })();
  return _ensureCollectionsPromise;
}

async function fetchAll(queryBuilder) {
  const pageSize = 100;
  const rows = [];
  let skip = 0;
  while (true) {
    const res = await queryBuilder(skip, pageSize);
    const data = (res && Array.isArray(res.data)) ? res.data : [];
    rows.push(...data);
    if (data.length < pageSize) break;
    skip += pageSize;
  }
  return rows;
}

function normalizeDoc(row) {
  if (!row) return null;
  const next = { ...row };
  delete next._id;
  return next;
}

async function findOneByField(collectionName, field, value) {
  const db = getDb();
  const res = await db.collection(collectionName).where({ [field]: value }).limit(1).get();
  const row = (res && res.data && res.data[0]) ? res.data[0] : null;
  return normalizeDoc(row);
}

async function listByField(collectionName, field, value) {
  const db = getDb();
  const rows = await fetchAll((skip, limit) =>
    db.collection(collectionName).where({ [field]: value }).skip(skip).limit(limit).get()
  );
  return rows.map(normalizeDoc);
}

async function listAll(collectionName) {
  const db = getDb();
  const rows = await fetchAll((skip, limit) =>
    db.collection(collectionName).skip(skip).limit(limit).get()
  );
  return rows.map(normalizeDoc);
}

async function addDoc(collectionName, doc) {
  const db = getDb();
  await db.collection(collectionName).add({ ...doc });
}

async function updateByField(collectionName, field, value, patch) {
  const db = getDb();
  const res = await db.collection(collectionName).where({ [field]: value }).update(patch);
  return Number((res && res.updated) || 0);
}

async function removeByField(collectionName, field, value) {
  const db = getDb();
  const res = await db.collection(collectionName).where({ [field]: value }).remove();
  return Number((res && res.deleted) || 0);
}

async function removeByFieldIn(collectionName, field, values) {
  if (!values.length) return 0;
  const db = getDb();
  const _ = db.command;
  if (_) {
    const res = await db.collection(collectionName).where({ [field]: _.in(values) }).remove();
    return Number((res && res.deleted) || 0);
  }
  let deleted = 0;
  for (const value of values) {
    deleted += await removeByField(collectionName, field, value);
  }
  return deleted;
}

async function listByFieldIn(collectionName, field, values) {
  if (!values.length) return [];
  const db = getDb();
  const _ = db.command;
  if (_) {
    const rows = await fetchAll((skip, limit) =>
      db.collection(collectionName).where({ [field]: _.in(values) }).skip(skip).limit(limit).get()
    );
    return rows.map(normalizeDoc);
  }
  const allRows = [];
  for (const value of values) {
    const part = await listByField(collectionName, field, value);
    allRows.push(...part);
  }
  return allRows;
}

module.exports = {
  COLLECTIONS,
  ensureCollections,
  nowIso,
  findOneByField,
  listByField,
  listAll,
  addDoc,
  updateByField,
  removeByField,
  removeByFieldIn,
  listByFieldIn,
};

