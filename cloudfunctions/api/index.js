"use strict";

const { corsHeaders, ok, errorResponse } = require("./response");
const { ErrorCode, AppError } = require("./errors");
const { dbConn, ensureDb, finishBackups } = require("./db");
const { YourJsKey, YourSecurityJsCode, YourWebServiceKey } = require("./secrets");
const {
  nowIso,
  mapPlanRow,
  mapPlaceRow,
  ensurePlanExists,
  loadPlace,
  loadPlan,
  loadPlanPlaces,
  loadPlanRiskCheckCache,
  savePlanRiskCheckCache,
  invalidatePlanRiskCheckCache,
  validateItinerarySlots,
  loadPlanItinerary,
  loadPlanDayRoute,
  ensureMapConfigReady,
  amapGet,
  parseFloatSafe,
  windPowerToMps,
  resolveAdminByLocation,
  loadWeatherForecastByAdcode,
  evaluateWeatherRisk,
  callGlmForSummary,
} = require("./utils");

// ─── Router ─────────────────────────────────────────────────────────────────

function matchRoute(path) {
  // Strip optional /api prefix (CloudBase HTTP access may include it)
  if (path.startsWith("/api/") || path === "/api") {
    path = path.slice(4) || "/";
  }

  // /health
  if (path === "/health") return { handler: "health" };

  // /plans (collection)
  if (path === "/plans") return { handler: "plans" };

  // /plans/{plan_id}
  let m = path.match(/^\/plans\/(\d+)$/);
  if (m) return { handler: "plan_by_id", plan_id: parseInt(m[1], 10) };

  // /plans/{plan_id}/places
  m = path.match(/^\/plans\/(\d+)\/places$/);
  if (m) return { handler: "plan_places", plan_id: parseInt(m[1], 10) };

  // /plans/{plan_id}/risk-check
  m = path.match(/^\/plans\/(\d+)\/risk-check$/);
  if (m) return { handler: "risk_check", plan_id: parseInt(m[1], 10) };

  // /plans/{plan_id}/itinerary
  m = path.match(/^\/plans\/(\d+)\/itinerary$/);
  if (m) return { handler: "itinerary", plan_id: parseInt(m[1], 10) };

  // /plans/{plan_id}/itinerary/day-route
  m = path.match(/^\/plans\/(\d+)\/itinerary\/day-route$/);
  if (m) return { handler: "day_route", plan_id: parseInt(m[1], 10) };

  // /plans/{plan_id}/ai-summary
  m = path.match(/^\/plans\/(\d+)\/ai-summary$/);
  if (m) return { handler: "ai_summary", plan_id: parseInt(m[1], 10) };

  // /places, /places/{place_id}
  m = path.match(/^\/places(?:\/(\d+))?$/);
  if (m) return { handler: "places", place_id: m[1] ? parseInt(m[1], 10) : null };

  // /map/config, /map/search, /map/reverse-geocode, /map/nearby-poi
  if (path === "/map/config") return { handler: "map_config" };
  if (path === "/map/search") return { handler: "map_search" };
  if (path === "/map/reverse-geocode") return { handler: "map_reverse_geocode" };
  if (path === "/map/nearby-poi") return { handler: "map_nearby_poi" };

  // /weather/by-location
  if (path === "/weather/by-location") return { handler: "weather" };

  return null;
}

function generateEntityId() {
  // Keep within JS safe integer range: ~1.7e15 in 2026, far below Number.MAX_SAFE_INTEGER.
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function allocatePlanId(db) {
  for (let i = 0; i < 8; i += 1) {
    const candidate = generateEntityId();
    const exists = db.prepare("SELECT id FROM plans WHERE id = ?").get(candidate);
    if (!exists) return candidate;
  }
  throw new AppError(ErrorCode.DB, "生成规划 ID 失败，请重试", 500);
}

function allocatePlaceId(db) {
  for (let i = 0; i < 8; i += 1) {
    const candidate = generateEntityId();
    const exists = db.prepare("SELECT id FROM places WHERE id = ?").get(candidate);
    if (!exists) return candidate;
  }
  throw new AppError(ErrorCode.DB, "生成地点 ID 失败，请重试", 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOnPlanNotFound(task) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (e) {
      const isPlanNotFound = e instanceof AppError && e.code === ErrorCode.NOT_FOUND && e.message === "规划不存在";
      if (!isPlanNotFound) throw e;
      if (attempt >= maxAttempts) throw e;
      await ensureDb({ forceReload: true });
      await sleep(120 * attempt);
    }
  }
  throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function routeRequest(event) {
  const { path, httpMethod, body: rawBody, queryStringParameters, headers: reqHeaders } = event;
  const origin = (reqHeaders && (reqHeaders.origin || reqHeaders.Origin)) || "";
  const params = queryStringParameters || {};
  const route = matchRoute(path);

  if (!route) {
    return {
      statusCode: 404,
      headers: corsHeaders(origin),
      body: JSON.stringify(errorResponse(ErrorCode.NOT_FOUND, "Not Found")),
    };
  }

  let payload;
  try {
    payload = rawBody ? (typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody) : {};
  } catch {
    payload = {};
  }

  // ── /health ─────────────────────────────────────────────────────
  if (route.handler === "health") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    const db = dbConn();
    db.prepare("SELECT 1").get();
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ status: "ok", db: "ok" })) };
  }

  // ── /plans (collection) ──────────────────────────────────────────
  if (route.handler === "plans") {
    if (httpMethod === "POST") {
      const now = nowIso();
      const db = dbConn();
      const planId = allocatePlanId(db);
      db.prepare(
        `INSERT INTO plans (id, title, date, budget, people_count, preferences, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        planId,
        (payload.title || "").trim(),
        (payload.date || "").trim(),
        Number(payload.budget),
        Number(payload.people_count),
        (payload.preferences || "").trim(),
        now, now
      );
      const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
      if (!row) throw new AppError(ErrorCode.DB, "创建规划失败", 500);

      // Support creating places together with the plan to avoid cross-instance DB sync delay
      const places = payload.places || [];
      const createdPlaces = [];
      for (const place of places) {
        const placeId = allocatePlaceId(db);
        db.prepare(
          `INSERT INTO places (id, plan_id, name, address, longitude, latitude, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(placeId, planId, (place.name || "").trim(), (place.address || "").trim(),
          Number(place.longitude), Number(place.latitude), now, now);
        createdPlaces.push(loadPlace(placeId));
      }

      const planData = mapPlanRow(row);
      planData.places = createdPlaces;
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(planData)) };
    }
    if (httpMethod === "GET") {
      const db = dbConn();
      const rows = db.prepare("SELECT * FROM plans ORDER BY updated_at DESC, id DESC").all();
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(rows.map(mapPlanRow))) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  // ── /plans/{plan_id} ─────────────────────────────────────────────
  if (route.handler === "plan_by_id") {
    const planId = route.plan_id;
    if (httpMethod === "GET") {
      const data = await retryOnPlanNotFound(async () => loadPlan(planId));
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
    }
    if (httpMethod === "PUT") {
      const now = nowIso();
      const db = dbConn();
      const result = db.prepare(
        `UPDATE plans SET title = ?, date = ?, budget = ?, people_count = ?, preferences = ?, updated_at = ? WHERE id = ?`
      ).run(
        (payload.title || "").trim(), (payload.date || "").trim(),
        Number(payload.budget), Number(payload.people_count),
        (payload.preferences || "").trim(), now, planId
      );
      if (result.changes === 0) throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
      const row = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
      if (!row) throw new AppError(ErrorCode.DB, "读取更新后规划失败", 500);
      invalidatePlanRiskCheckCache(planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(mapPlanRow(row))) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  // ── /plans/{plan_id}/places ──────────────────────────────────────
  if (route.handler === "plan_places") {
    const planId = route.plan_id;
    if (httpMethod === "POST") {
      await retryOnPlanNotFound(async () => ensurePlanExists(planId));
      const now = nowIso();
      const db = dbConn();
      const placeId = allocatePlaceId(db);
      const result = db.prepare(
        `INSERT INTO places (id, plan_id, name, address, longitude, latitude, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(placeId, planId, (payload.name || "").trim(), (payload.address || "").trim(),
        Number(payload.longitude), Number(payload.latitude), now, now);
      invalidatePlanRiskCheckCache(planId);
      const createdId = Number(result.lastInsertRowid) || placeId;
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(loadPlace(createdId))) };
    }
    if (httpMethod === "GET") {
      const data = await retryOnPlanNotFound(async () => {
        ensurePlanExists(planId);
        return loadPlanPlaces(planId);
      });
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  // ── /places, /places/{place_id} ──────────────────────────────────
  if (route.handler === "places") {
    const placeId = route.place_id;
    if (httpMethod === "GET" && placeId === null) {
      const db = dbConn();
      const rows = db.prepare(
        `SELECT places.*, plans.title AS plan_title
         FROM places JOIN plans ON plans.id = places.plan_id
         ORDER BY places.updated_at DESC, places.id DESC`
      ).all();
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(rows.map(mapPlaceRow))) };
    }
    if (httpMethod === "GET" && placeId !== null) {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(loadPlace(placeId))) };
    }
    if (httpMethod === "PUT" && placeId !== null) {
      const now = nowIso();
      const db = dbConn();
      const result = db.prepare(
        `UPDATE places SET name = ?, address = ?, longitude = ?, latitude = ?, updated_at = ? WHERE id = ?`
      ).run((payload.name || "").trim(), (payload.address || "").trim(),
        Number(payload.longitude), Number(payload.latitude), now, placeId);
      if (result.changes === 0) throw new AppError(ErrorCode.NOT_FOUND, "地点不存在", 404);
      const place = loadPlace(placeId);
      invalidatePlanRiskCheckCache(place.plan_id);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(place)) };
    }
    if (httpMethod === "DELETE" && placeId !== null) {
      const db = dbConn();
      const row = db.prepare("SELECT plan_id FROM places WHERE id = ?").get(placeId);
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, "地点不存在", 404);
      const planId = row.plan_id;
      db.prepare("DELETE FROM places WHERE id = ?").run(placeId);
      invalidatePlanRiskCheckCache(planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ deleted: true })) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  // ── /plans/{plan_id}/risk-check ──────────────────────────────────
  if (route.handler === "risk_check") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    const planId = route.plan_id;
    ensureMapConfigReady();
    await retryOnPlanNotFound(async () => ensurePlanExists(planId));
    const cached = loadPlanRiskCheckCache(planId);
    if (cached) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(cached)) };
    const plan = await retryOnPlanNotFound(async () => loadPlan(planId));
    const places = loadPlanPlaces(planId);
    const weatherRisk = await evaluateWeatherRisk(plan, places);
    const result = { weather_risk: weatherRisk };
    savePlanRiskCheckCache(planId, result);
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(result)) };
  }

  // ── /plans/{plan_id}/itinerary ───────────────────────────────────
  if (route.handler === "itinerary") {
    const planId = route.plan_id;
    if (httpMethod === "GET") {
      const data = await retryOnPlanNotFound(async () => {
        ensurePlanExists(planId);
        return loadPlanItinerary(planId);
      });
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
    }
    if (httpMethod === "PUT") {
      await retryOnPlanNotFound(async () => ensurePlanExists(planId));
      const slots = payload.slots || [];
      validateItinerarySlots(slots);
      const placeIds = [...new Set(slots.flatMap((s) => s.place_ids || []))].sort((a, b) => a - b);
      const db = dbConn();
      if (placeIds.length) {
        const ph = placeIds.map(() => "?").join(",");
        const rows = db.prepare(`SELECT id FROM places WHERE plan_id = ? AND id IN (${ph})`).all(planId, ...placeIds);
        const existingIds = new Set(rows.map((r) => r.id));
        const missing = placeIds.filter((id) => !existingIds.has(id));
        if (missing.length) throw new AppError(ErrorCode.VALIDATION, `存在不属于当前规划的地点: ${missing.join(", ")}`, 422);
      }
      db.prepare(`DELETE FROM itinerary_slot_places WHERE slot_id IN (SELECT id FROM itinerary_slots WHERE plan_id = ?)`).run(planId);
      db.prepare("DELETE FROM itinerary_slots WHERE plan_id = ?").run(planId);
      const now = nowIso();
      for (const slot of slots) {
        const result = db.prepare(
          `INSERT INTO itinerary_slots (plan_id, day_index, label, start_minute, end_minute, sort_index, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(planId, slot.day_index || 1, (slot.label || "").trim(),
          slot.start_minute != null ? slot.start_minute : null,
          slot.end_minute != null ? slot.end_minute : null,
          slot.sort_index || 0, (slot.note || "").trim(), now, now);
        const pids = slot.place_ids || [];
        for (let i = 0; i < pids.length; i++) {
          db.prepare(`INSERT INTO itinerary_slot_places (slot_id, place_id, sort_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
            .run(result.lastInsertRowid, pids[i], i, now, now);
        }
      }
      invalidatePlanRiskCheckCache(planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(loadPlanItinerary(planId))) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  // ── /plans/{plan_id}/itinerary/day-route ─────────────────────────
  if (route.handler === "day_route") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    const planId = route.plan_id;
    await retryOnPlanNotFound(async () => ensurePlanExists(planId));
    const dayIndex = parseInt(params.day_index, 10);
    if (isNaN(dayIndex) || dayIndex < 1 || dayIndex > 30) {
      throw new AppError(ErrorCode.VALIDATION, "天数范围非法", 422);
    }
    const routeData = await loadPlanDayRoute(planId, dayIndex);
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(routeData)) };
  }

  // ── /plans/{plan_id}/ai-summary ──────────────────────────────────
  if (route.handler === "ai_summary") {
    if (httpMethod !== "POST") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    const planId = route.plan_id;
    await retryOnPlanNotFound(async () => ensurePlanExists(planId));
    const plan = await retryOnPlanNotFound(async () => loadPlan(planId));
    const places = loadPlanPlaces(planId);
    const itinerarySlots = loadPlanItinerary(planId);
    let result;
    try {
      result = await callGlmForSummary(plan, places, itinerarySlots, payload);
    } catch (e) {
      if (e instanceof AppError) {
        const placeCount = places.length;
        const hasNotes = !!(plan.preferences || "").trim();
        result = {
          reply: "AI 服务当前不可用，已返回降级建议：请优先检查天气与时段冲突、核对预算与人数的人均成本，并在关键时段预留机动时间。",
          strengths: ["已完成基础规划信息（日期/预算/人数）", `已加入地点数量：${placeCount}`],
          risks: ["外部 AI 服务暂时不可用，建议稍后重试", "若当天天气突变，户外时段可能需要调整"],
          improvements: [
            "优先补齐每个时段的核心地点与预计停留时长",
            "为交通与排队预留 15~30 分钟缓冲",
            hasNotes ? "若有个性化备注，建议逐项映射到时段安排" : "可补充个性化备注以获得更精准建议",
          ],
          used_weather_fallback: true,
        };
      } else { throw e; }
    }
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(result)) };
  }

  // ── /map/* ───────────────────────────────────────────────────────
  if (route.handler === "map_config") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    ensureMapConfigReady();
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ js_key: YourJsKey, security_js_code: YourSecurityJsCode })) };
  }

  if (route.handler === "map_search") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    ensureMapConfigReady();
    const keyword = (params.keywords || "").trim();
    if (!keyword) throw new AppError(ErrorCode.VALIDATION, "关键词不能为空", 422);
    const body = await amapGet("/v3/place/text", { key: YourWebServiceKey, keywords: keyword, offset: "5", page: "1", extensions: "base" });
    if (body.status !== "1") throw new AppError(ErrorCode.HTTP, body.info || "地点搜索失败", 502);
    const data = [];
    for (const row of (body.pois || [])) {
      const location = String(row.location || "");
      const parts = location.split(",");
      if (parts.length !== 2) continue;
      const lon = parseFloatSafe(parts[0], NaN), lat = parseFloatSafe(parts[1], NaN);
      if (isNaN(lon) || isNaN(lat)) continue;
      data.push({ name: String(row.name || "未命名地点").trim(), address: String(row.address || "地址未知").trim(), longitude: lon, latitude: lat });
    }
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
  }

  if (route.handler === "map_reverse_geocode") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    ensureMapConfigReady();
    const lon = parseFloat(params.longitude), lat = parseFloat(params.latitude);
    if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new AppError(ErrorCode.VALIDATION, "经纬度范围非法", 422);
    const body = await amapGet("/v3/geocode/regeo", { key: YourWebServiceKey, location: `${lon},${lat}`, extensions: "all" });
    if (body.status !== "1") throw new AppError(ErrorCode.HTTP, body.info || "逆地理解析失败", 502);
    const regeocode = body.regeocode || {};
    const formattedAddress = String(regeocode.formatted_address || "").trim();
    const addressComponent = regeocode.addressComponent || {};
    const streetNumber = addressComponent.streetNumber || {};
    const pois = regeocode.pois || [];
    let poiName = "", poiAddress = "";
    if (pois.length) {
      poiName = String((pois[0] || {}).name || "").trim();
      poiAddress = String((pois[0] || {}).address || "").trim();
    }
    const buildingName = String(((addressComponent.building || {}).name) || "").trim();
    const neighborhoodName = String(((addressComponent.neighborhood || {}).name) || "").trim();
    const street = String(streetNumber.street || "").trim();
    const number = String(streetNumber.number || "").trim();
    let doorplate = (street + number).trim();
    if (!doorplate) doorplate = number || street;
    const name = poiName || buildingName || neighborhoodName || doorplate || formattedAddress || "未命名地点";
    const address = doorplate || poiAddress || formattedAddress || "地址未知";
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ name, address })) };
  }

  if (route.handler === "map_nearby_poi") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    ensureMapConfigReady();
    const lon = parseFloat(params.longitude), lat = parseFloat(params.latitude);
    if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new AppError(ErrorCode.VALIDATION, "经纬度范围非法", 422);
    const body = await amapGet("/v3/place/around", { key: YourWebServiceKey, location: `${lon},${lat}`, radius: "120", offset: "1", page: "1", extensions: "base" });
    if (body.status !== "1") throw new AppError(ErrorCode.HTTP, body.info || "周边地点查询失败", 502);
    const pois = body.pois || [];
    if (!pois.length) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(null)) };
    const first = pois[0] || {};
    const location = String(first.location || "").trim();
    const parts = location.split(",");
    if (parts.length !== 2) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(null)) };
    const poiLon = parseFloatSafe(parts[0], NaN), poiLat = parseFloatSafe(parts[1], NaN);
    if (isNaN(poiLon) || isNaN(poiLat)) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(null)) };
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ name: String(first.name || "未命名地点").trim(), address: String(first.address || "地址未知").trim(), longitude: poiLon, latitude: poiLat })) };
  }

  // ── /weather/by-location ─────────────────────────────────────────
  if (route.handler === "weather") {
    if (httpMethod !== "GET") {
      return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    }
    ensureMapConfigReady();
    const lon = parseFloat(params.longitude), lat = parseFloat(params.latitude);
    if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new AppError(ErrorCode.VALIDATION, "经纬度范围非法", 422);
    const { province, city, district, adcode } = await resolveAdminByLocation(lon, lat);
    const liveBody = await amapGet("/v3/weather/weatherInfo", { key: YourWebServiceKey, city: adcode, extensions: "base" });
    if (liveBody.status !== "1") throw new AppError(ErrorCode.HTTP, liveBody.info || "实时天气查询失败", 502);
    const lives = liveBody.lives || [];
    if (!lives.length) throw new AppError(ErrorCode.HTTP, "未获取到实时天气信息", 502);
    const live = lives[0] || {};
    const current = {
      province, city, district, adcode,
      weather: String(live.weather || "未知").trim(),
      temperature_c: parseFloatSafe(live.temperature, 0.0),
      wind_direction: String(live.winddirection || "未知").trim(),
      wind_speed_mps: windPowerToMps(String(live.windpower || "")),
      report_time: String(live.reporttime || "").trim(),
    };
    const forecast = await loadWeatherForecastByAdcode(adcode);
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ province, city, district, adcode, current, forecast })) };
  }

  return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
}

exports.main = async (event, context) => {
  await ensureDb();

  const reqHeaders = event.headers || {};
  const origin = (reqHeaders.origin || reqHeaders.Origin) || "";

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  let resp;
  try {
    resp = await routeRequest(event);
  } catch (e) {
    if (e instanceof AppError) {
      resp = { statusCode: e.httpStatus, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(e.code, e.message)) };
    } else if (e instanceof SyntaxError) {
      resp = { statusCode: 422, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.VALIDATION, e.message)) };
    } else {
      resp = { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.UNKNOWN, e.message)) };
    }
  }

  const method = String(event.httpMethod || "").toUpperCase();
  const isWriteRequest = method === "POST" || method === "PUT" || method === "DELETE";
  const isPlanCreate = method === "POST" && String(event.path || "") === "/plans";
  await finishBackups(isPlanCreate ? 2500 : isWriteRequest ? 1200 : 0);
  return resp;
};
