"use strict";

const https = require("https");
const { URL } = require("url");
const { AppError, ErrorCode } = require("./errors");
const {
  COLLECTIONS,
  findOneByField,
  listByField,
  listAll,
  addDoc,
  updateByField,
  removeByField,
  removeByFieldIn,
  listByFieldIn,
  nowIso: storeNowIso,
} = require("./store");
const {
  DeepSeekApiKey,
  YourJsKey,
  YourSecurityJsCode,
  YourWebServiceKey,
} = require("./secrets");

// ─── helpers ────────────────────────────────────────────────────────────────

function nowIso() {
  return storeNowIso();
}

function isPlaceholder(value) {
  const s = (value || "").trim();
  return s === "" || s === "------";
}

function parseFloatSafe(value, fallback = 0.0) {
  try {
    const n = parseFloat(String(value).trim());
    return isNaN(n) ? fallback : n;
  } catch {
    return fallback;
  }
}

function parseIntSafe(value, fallback = 0) {
  try {
    const n = parseInt(String(value).trim(), 10);
    return isNaN(n) ? fallback : n;
  } catch {
    return fallback;
  }
}

// ─── DB row mappers ─────────────────────────────────────────────────────────

function mapPlanRow(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    budget: row.budget,
    people_count: row.people_count,
    preferences: row.preferences,
    pinned: row.pinned != null ? row.pinned : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapPlaceRow(row) {
  return {
    id: row.id,
    plan_id: row.plan_id,
    plan_title: row.plan_title !== undefined ? row.plan_title : null,
    name: row.name,
    address: row.address,
    longitude: row.longitude,
    latitude: row.latitude,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─── DB loaders ─────────────────────────────────────────────────────────────

async function ensurePlanExists(planId) {
  const row = await findOneByField(COLLECTIONS.plans, "id", planId);
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
  }
}

async function loadPlace(placeId) {
  const row = await findOneByField(COLLECTIONS.places, "id", placeId);
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, "地点不存在", 404);
  }
  const plan = await findOneByField(COLLECTIONS.plans, "id", row.plan_id);
  return mapPlaceRow({ ...row, plan_title: plan ? plan.title : null });
}

async function loadPlan(planId) {
  const row = await findOneByField(COLLECTIONS.plans, "id", planId);
  if (!row) {
    throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
  }
  return mapPlanRow(row);
}

async function loadPlanPlaces(planId) {
  const rows = await listByField(COLLECTIONS.places, "plan_id", planId);
  rows.sort((a, b) => {
    const keyA = `${a.updated_at || ""}#${a.id || 0}`;
    const keyB = `${b.updated_at || ""}#${b.id || 0}`;
    return keyA < keyB ? 1 : keyA > keyB ? -1 : 0;
  });
  const plan = await findOneByField(COLLECTIONS.plans, "id", planId);
  const planTitle = plan ? plan.title : null;
  const withTitle = rows.map((row) => ({ ...row, plan_title: planTitle }));
  return withTitle.map(mapPlaceRow);
}

async function loadAllPlacesWithPlanTitle() {
  const [places, plans] = await Promise.all([
    listAll(COLLECTIONS.places),
    listAll(COLLECTIONS.plans),
  ]);
  const planTitleById = new Map(plans.map((p) => [p.id, p.title]));
  places.sort((a, b) => {
    const keyA = `${a.updated_at || ""}#${a.id || 0}`;
    const keyB = `${b.updated_at || ""}#${b.id || 0}`;
    return keyA < keyB ? 1 : keyA > keyB ? -1 : 0;
  });
  return places.map((row) =>
    mapPlaceRow({ ...row, plan_title: planTitleById.get(row.plan_id) || null })
  );
}

async function loadPlansOrdered() {
  const rows = await listAll(COLLECTIONS.plans);
  rows.sort((a, b) => {
    const keyA = `${a.updated_at || ""}#${a.id || 0}`;
    const keyB = `${b.updated_at || ""}#${b.id || 0}`;
    return keyA < keyB ? 1 : keyA > keyB ? -1 : 0;
  });
  return rows.map(mapPlanRow);
}

async function loadPlanRiskCheckCache(planId) {
  const row = await findOneByField(COLLECTIONS.riskCheckCache, "plan_id", planId);
  if (!row) return null;
  const payloadJson = (row.payload_json || "").trim();
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson);
    return parsed;
  } catch {
    return null;
  }
}

async function savePlanRiskCheckCache(planId, data) {
  const existing = await findOneByField(COLLECTIONS.riskCheckCache, "plan_id", planId);
  if (existing) {
    await updateByField(COLLECTIONS.riskCheckCache, "plan_id", planId, {
      payload_json: JSON.stringify(data),
      updated_at: nowIso(),
    });
    return;
  }
  await addDoc(COLLECTIONS.riskCheckCache, {
    plan_id: planId,
    payload_json: JSON.stringify(data),
    updated_at: nowIso(),
  });
}

async function invalidatePlanRiskCheckCache(planId) {
  await removeByField(COLLECTIONS.riskCheckCache, "plan_id", planId);
}

// ─── Itinerary helpers ──────────────────────────────────────────────────────

function validateItinerarySlots(slots) {
  if (!slots || !slots.length) return;

  const slotsByDay = {};
  for (const slot of slots) {
    const d = slot.day_index;
    if (!slotsByDay[d]) slotsByDay[d] = [];
    slotsByDay[d].push(slot);
  }

  for (const [dayIndex, daySlots] of Object.entries(slotsByDay)) {
    const hasCustomTime = daySlots.some(
      (s) => s.start_minute != null || s.end_minute != null
    );
    if (hasCustomTime) {
      const ranges = [];
      for (let i = 0; i < daySlots.length; i++) {
        const slot = daySlots[i];
        if (slot.start_minute == null || slot.end_minute == null) {
          throw new AppError(
            ErrorCode.VALIDATION,
            `第 ${dayIndex} 天存在自定义时段时，所有时段都必须填写开始与结束时间`,
            422
          );
        }
        const sm = slot.start_minute;
        const em = slot.end_minute;
        if (sm < 0 || em > 1440 || sm >= em) {
          throw new AppError(
            ErrorCode.VALIDATION,
            `第 ${dayIndex} 天时段 ${i + 1} 时间范围非法，必须满足 00:00 <= 开始 < 结束 <= 24:00`,
            422
          );
        }
        ranges.push([sm, em]);
      }
      ranges.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] < ranges[i - 1][1]) {
          throw new AppError(
            ErrorCode.VALIDATION,
            `第 ${dayIndex} 天的时段之间不能重叠`,
            422
          );
        }
      }
    }
    for (const slot of daySlots) {
      if (!(slot.label || "").trim()) {
        throw new AppError(ErrorCode.VALIDATION, "时段名称不能为空", 422);
      }
      const placeIds = slot.place_ids || [];
      if (new Set(placeIds).size !== placeIds.length) {
        throw new AppError(
          ErrorCode.VALIDATION,
          "同一时段不能重复分配同一地点",
          422
        );
      }
    }
  }
}

function sortItinerarySlots(slots) {
  if (!slots || !slots.length) return slots;

  const allHaveTimes = slots.every(
    (s) => s.start_minute != null && s.end_minute != null
  );
  if (allHaveTimes) {
    return [...slots].sort((a, b) => {
      const c = a.day_index - b.day_index;
      if (c !== 0) return c;
      const d = (a.start_minute || 0) - (b.start_minute || 0);
      if (d !== 0) return d;
      const e = (a.end_minute || 0) - (b.end_minute || 0);
      if (e !== 0) return e;
      const f = a.sort_index - b.sort_index;
      if (f !== 0) return f;
      return a.id - b.id;
    });
  }
  return [...slots].sort((a, b) => {
    const c = a.day_index - b.day_index;
    if (c !== 0) return c;
    const d = a.sort_index - b.sort_index;
    if (d !== 0) return d;
    return a.id - b.id;
  });
}

function sortDaySlotsForRoute(slots) {
  if (!slots || !slots.length) return slots;

  const allHaveTimes = slots.every(
    (s) => s.start_minute != null && s.end_minute != null
  );
  if (allHaveTimes) {
    return [...slots].sort((a, b) => {
      const c = (a.start_minute || 0) - (b.start_minute || 0);
      if (c !== 0) return c;
      const d = (a.end_minute || 0) - (b.end_minute || 0);
      if (d !== 0) return d;
      const e = a.sort_index - b.sort_index;
      if (e !== 0) return e;
      return a.id - b.id;
    });
  }
  return [...slots].sort((a, b) => {
    const c = a.sort_index - b.sort_index;
    if (c !== 0) return c;
    return a.id - b.id;
  });
}

// ─── Geo / routes ───────────────────────────────────────────────────────────

function haversineDistanceM(originLon, originLat, destLon, destLat) {
  const radiusM = 6371000.0;
  const oLatRad = (originLat * Math.PI) / 180;
  const dLatRad = (destLat * Math.PI) / 180;
  const deltaLat = ((destLat - originLat) * Math.PI) / 180;
  const deltaLon = ((destLon - originLon) * Math.PI) / 180;
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(oLatRad) *
      Math.cos(dLatRad) *
      Math.sin(deltaLon / 2) ** 2;
  return 2 * radiusM * Math.asin(Math.min(1.0, Math.sqrt(a)));
}

function formatDurationText(durationSeconds) {
  if (durationSeconds == null || durationSeconds <= 0) return "未知";
  const totalMinutes = Math.max(1, Math.round(durationSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours && minutes) return `${hours} 小时 ${minutes} 分钟`;
  if (hours) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

// ─── Amap HTTP ──────────────────────────────────────────────────────────────

function ensureMapConfigReady() {
  if (
    isPlaceholder(YourJsKey) ||
    isPlaceholder(YourSecurityJsCode) ||
    isPlaceholder(YourWebServiceKey)
  ) {
    throw new AppError(
      ErrorCode.VALIDATION,
      "后端地图密钥未配置，请先修改 backend/app/secrets.py",
      400
    );
  }
}

function amapGet(pathStr, params) {
  const query = new URLSearchParams(params).toString();
  const url = `https://restapi.amap.com${pathStr}?${query}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(
            new AppError(
              ErrorCode.HTTP,
              `调用高德服务失败: ${e.message}`,
              502
            )
          );
        }
      });
    });
    req.on("error", (e) => {
      reject(
        new AppError(
          ErrorCode.HTTP,
          `调用高德服务失败: ${e.message}`,
          502
        )
      );
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new AppError(ErrorCode.HTTP, "调用高德服务超时", 502));
    });
  });
}

// ─── Wind power ─────────────────────────────────────────────────────────────

function windPowerToMps(windPowerText) {
  const beaufortToMps = {
    0: 0.2, 1: 1.5, 2: 3.3, 3: 5.4, 4: 7.9, 5: 10.7,
    6: 13.8, 7: 17.1, 8: 20.7, 9: 24.4, 10: 28.4,
    11: 32.6, 12: 36.9,
  };
  const levels = (String(windPowerText).match(/\d+/g) || []).map(Number);
  if (!levels.length) return 0.0;
  let level;
  if (levels.length >= 2) {
    level = Math.round((levels[0] + levels[1]) / 2);
  } else {
    level = levels[0];
  }
  level = Math.max(0, Math.min(level, 12));
  return beaufortToMps[level];
}

// ─── Resolve admin (reverse geocode → adcode) ───────────────────────────────

async function resolveAdminByLocation(longitude, latitude) {
  const body = await amapGet("/v3/geocode/regeo", {
    key: YourWebServiceKey,
    location: `${longitude},${latitude}`,
    extensions: "base",
  });
  if (body.status !== "1") {
    throw new AppError(
      ErrorCode.HTTP,
      body.info || "逆地理解析失败",
      502
    );
  }
  const addressComponent =
    ((body.regeocode || {}).addressComponent) || {};
  const adcode = String(addressComponent.adcode || "").trim();
  if (!adcode) {
    throw new AppError(ErrorCode.HTTP, "未获取到城市编码 adcode", 502);
  }
  let province = String(addressComponent.province || "").trim() || "未知省份";
  let city = addressComponent.city;
  if (Array.isArray(city)) {
    city = "";
  } else {
    city = String(city || "").trim();
  }
  if (!city) city = province;
  const district =
    String(addressComponent.district || "").trim() || "未知区县";
  return { province, city, district, adcode };
}

// ─── Weather forecast ───────────────────────────────────────────────────────

async function loadWeatherForecastByAdcode(adcode) {
  const body = await amapGet("/v3/weather/weatherInfo", {
    key: YourWebServiceKey,
    city: adcode,
    extensions: "all",
  });
  if (body.status !== "1") {
    throw new AppError(
      ErrorCode.HTTP,
      body.info || "天气预报查询失败",
      502
    );
  }
  const forecasts = body.forecasts || [];
  const casts = forecasts.length ? (forecasts[0].casts || []) : [];
  const result = [];
  for (const cast of casts) {
    const row = cast || {};
    const dayWeather = String(row.dayweather || "").trim();
    const nightWeather = String(row.nightweather || "").trim();
    const weather = dayWeather || nightWeather || "未知";
    const dayTemp = parseFloatSafe(row.daytemp, 0.0);
    const nightTemp = parseFloatSafe(row.nighttemp, 0.0);
    const highTemp = Math.max(dayTemp, nightTemp);
    const lowTemp = Math.min(dayTemp, nightTemp);
    const dateText = String(row.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) continue;
    result.push({
      date: dateText,
      weather,
      high_temp_c: highTemp,
      low_temp_c: lowTemp,
    });
  }
  return result;
}

// ─── Evaluate weather risk ──────────────────────────────────────────────────

async function evaluateWeatherRisk(plan, places) {
  const planDateText = (plan.date || "").trim();
  if (!planDateText) {
    return {
      has_forecast_for_plan_date: false,
      has_rain_or_snow: false,
      suggestion: "未设置规划日期，无法判断雨天户外风险",
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDateText)) {
    return {
      has_forecast_for_plan_date: false,
      has_rain_or_snow: false,
      suggestion: "规划日期格式非法，无法判断雨天户外风险",
    };
  }
  if (!places || !places.length) {
    return {
      has_forecast_for_plan_date: false,
      has_rain_or_snow: false,
      suggestion: "暂无规划地点，无法判断雨天户外风险",
    };
  }

  const forecastByAdcode = {};
  try {
    for (const place of places) {
      const { adcode } = await resolveAdminByLocation(
        place.longitude,
        place.latitude
      );
      if (!forecastByAdcode[adcode]) {
        forecastByAdcode[adcode] = await loadWeatherForecastByAdcode(adcode);
      }
      const forecast = forecastByAdcode[adcode];
      const matched = forecast.find((item) => item.date === planDateText);
      if (!matched) continue;
      const risky = matched.weather.includes("雨") || matched.weather.includes("雪");
      if (risky) {
        return {
          has_forecast_for_plan_date: true,
          has_rain_or_snow: true,
          suggestion: "建议谨慎选择户外活动",
          matched_weather: matched.weather,
        };
      }
    }
  } catch (exc) {
    if (
      exc.message &&
      (exc.message.includes("EXCEEDED_THE_LIMIT") ||
        exc.message.includes("LIMIT"))
    ) {
      return {
        has_forecast_for_plan_date: false,
        has_rain_or_snow: false,
        suggestion: "天气服务限流，暂无法判断雨天户外风险",
      };
    }
    throw exc;
  }

  for (const forecast of Object.values(forecastByAdcode)) {
    const matched = forecast.find((item) => item.date === planDateText);
    if (matched) {
      return {
        has_forecast_for_plan_date: true,
        has_rain_or_snow: false,
        suggestion: "当前预报未见雨雪，可正常安排户外活动",
        matched_weather: matched.weather,
      };
    }
  }
  return {
    has_forecast_for_plan_date: false,
    has_rain_or_snow: false,
    suggestion: "规划日期暂无天气预报，无法判断雨天户外风险",
  };
}

// ─── Route extraction ───────────────────────────────────────────────────────

function extractRoutePathAndDuration(body, routeKey) {
  const route = body.route || {};
  const items = route[routeKey] || [];
  if (!items.length) return { distance: null, duration: null };
  const first = items[0] || {};
  return {
    distance: parseFloatSafe(first.distance, 0.0),
    duration: parseFloatSafe(first.duration, 0.0),
  };
}

// ─── Route loading ──────────────────────────────────────────────────────────

async function loadWalkingRouteSummary(origin, dest) {
  const body = await amapGet("/v3/direction/walking", {
    key: YourWebServiceKey,
    origin: `${origin.longitude},${origin.latitude}`,
    destination: `${dest.longitude},${dest.latitude}`,
    output: "JSON",
  });
  if (body.status !== "1") {
    throw new AppError(
      ErrorCode.HTTP,
      body.info || "步行路径规划失败",
      502
    );
  }
  return extractRoutePathAndDuration(body, "paths");
}

async function loadDrivingRouteSummary(origin, dest) {
  const body = await amapGet("/v3/direction/driving", {
    key: YourWebServiceKey,
    origin: `${origin.longitude},${origin.latitude}`,
    destination: `${dest.longitude},${dest.latitude}`,
    strategy: "2",
    output: "JSON",
  });
  if (body.status !== "1") {
    throw new AppError(
      ErrorCode.HTTP,
      body.info || "驾车路径规划失败",
      502
    );
  }
  return extractRoutePathAndDuration(body, "paths");
}

async function loadTransitRouteSummary(origin, dest) {
  const originAdmin = await resolveAdminByLocation(
    origin.longitude,
    origin.latitude
  );
  const destAdmin = await resolveAdminByLocation(
    dest.longitude,
    dest.latitude
  );
  const body = await amapGet("/v3/direction/transit/integrated", {
    key: YourWebServiceKey,
    origin: `${origin.longitude},${origin.latitude}`,
    destination: `${dest.longitude},${dest.latitude}`,
    city: originAdmin.adcode,
    cityd: destAdmin.adcode || originAdmin.adcode,
    extensions: "base",
    output: "JSON",
  });
  if (body.status !== "1") {
    throw new AppError(
      ErrorCode.HTTP,
      body.info || "公共交通路径规划失败",
      502
    );
  }
  const route = body.route || {};
  const transits = route.transits || [];
  if (!transits.length) return { distance: null, duration: null };
  let fastest = transits[0];
  let fastestDuration = parseFloatSafe(
    (fastest || {}).duration,
    Infinity
  );
  for (let i = 1; i < transits.length; i++) {
    const d = parseFloatSafe((transits[i] || {}).duration, Infinity);
    if (d < fastestDuration) {
      fastest = transits[i];
      fastestDuration = d;
    }
  }
  return {
    distance: parseFloatSafe((fastest || {}).distance, 0.0),
    duration: parseFloatSafe((fastest || {}).duration, 0.0),
  };
}

async function buildRouteLeg(origin, dest) {
  const straightDistanceM = haversineDistanceM(
    origin.longitude,
    origin.latitude,
    dest.longitude,
    dest.latitude
  );

  if (straightDistanceM <= 1000) {
    const { distance: walkingDistanceM, duration: walkingDurationS } =
      await loadWalkingRouteSummary(origin, dest);
    const effectiveDistanceM =
      walkingDistanceM != null ? walkingDistanceM : straightDistanceM;
    return {
      from_place_id: origin.id,
      to_place_id: dest.id,
      preferred_mode: "walk",
      distance_m: effectiveDistanceM,
      display_text: `步行约 ${formatDurationText(walkingDurationS)}`,
      walking_duration_s: walkingDurationS,
    };
  }

  let drivingDistanceM = null,
    drivingDurationS = null;
  let transitDistanceM = null,
    transitDurationS = null;
  let drivingError = null,
    transitError = null;

  try {
    const r = await loadDrivingRouteSummary(origin, dest);
    drivingDistanceM = r.distance;
    drivingDurationS = r.duration;
  } catch (exc) {
    drivingError = exc;
  }
  try {
    const r = await loadTransitRouteSummary(origin, dest);
    transitDistanceM = r.distance;
    transitDurationS = r.duration;
  } catch (exc) {
    transitError = exc;
  }

  if (drivingDurationS == null && transitDurationS == null) {
    if (drivingError) throw drivingError;
    if (transitError) throw transitError;
    throw new AppError(ErrorCode.HTTP, "路径规划失败", 502);
  }

  let preferredMode, effectiveDistanceM;
  if (
    transitDurationS == null ||
    (drivingDurationS != null && drivingDurationS <= transitDurationS)
  ) {
    preferredMode = "drive";
    effectiveDistanceM =
      drivingDistanceM != null ? drivingDistanceM : straightDistanceM;
  } else {
    preferredMode = "transit";
    effectiveDistanceM =
      transitDistanceM != null ? transitDistanceM : straightDistanceM;
  }

  const texts = [];
  if (drivingDurationS != null)
    texts.push(`驾车约 ${formatDurationText(drivingDurationS)}`);
  if (transitDurationS != null)
    texts.push(`公交约 ${formatDurationText(transitDurationS)}`);

  return {
    from_place_id: origin.id,
    to_place_id: dest.id,
    preferred_mode: preferredMode,
    distance_m: effectiveDistanceM,
    display_text: texts.join(" / "),
    driving_duration_s: drivingDurationS,
    transit_duration_s: transitDurationS,
  };
}

// ─── Itinerary loader ───────────────────────────────────────────────────────

async function loadPlanItinerary(planId) {
  const slotRows = await listByField(COLLECTIONS.itinerarySlots, "plan_id", planId);
  slotRows.sort((a, b) => {
    if ((a.day_index || 1) !== (b.day_index || 1)) return (a.day_index || 1) - (b.day_index || 1);
    if ((a.sort_index || 0) !== (b.sort_index || 0)) return (a.sort_index || 0) - (b.sort_index || 0);
    return (a.id || 0) - (b.id || 0);
  });
  if (!slotRows.length) return [];

  const slotIds = slotRows.map((r) => r.id);
  const slotPlaceRows = await listByFieldIn(COLLECTIONS.itinerarySlotPlaces, "slot_id", slotIds);
  slotPlaceRows.sort((a, b) => {
    if ((a.sort_index || 0) !== (b.sort_index || 0)) return (a.sort_index || 0) - (b.sort_index || 0);
    return (a.id || 0) - (b.id || 0);
  });
  const uniquePlaceIds = [...new Set(slotPlaceRows.map((r) => r.place_id))];
  const placeRowsRaw = await listByFieldIn(COLLECTIONS.places, "id", uniquePlaceIds);
  const placeById = new Map(placeRowsRaw.map((p) => [p.id, p]));

  const placesBySlot = {};
  for (const link of slotPlaceRows) {
    const placeRow = placeById.get(link.place_id);
    if (!placeRow || placeRow.plan_id !== planId) continue;
    const sid = link.slot_id;
    if (!placesBySlot[sid]) placesBySlot[sid] = [];
    placesBySlot[sid].push({
      slot_place_id: link.id,
      sort_index: link.sort_index,
      place_id: placeRow.id,
      name: placeRow.name,
      address: placeRow.address,
      longitude: placeRow.longitude,
      latitude: placeRow.latitude,
    });
  }

  const slots = slotRows.map((row) => ({
    id: row.id,
    plan_id: row.plan_id,
    day_index: row.day_index != null ? row.day_index : 1,
    label: row.label,
    start_minute: row.start_minute,
    end_minute: row.end_minute,
    sort_index: row.sort_index,
    note: row.note,
    places: placesBySlot[row.id] || [],
  }));

  return sortItinerarySlots(slots);
}

async function loadPlanDayRoute(planId, dayIndex) {
  const allSlots = await loadPlanItinerary(planId);
  const daySlotsRaw = allSlots.filter((s) => s.day_index === dayIndex);
  const daySlots = sortDaySlotsForRoute(daySlotsRaw);

  const orderedPlaces = [];
  for (let slotOrder = 0; slotOrder < daySlots.length; slotOrder++) {
    const slot = daySlots[slotOrder];
    const slotPlaces = [...slot.places].sort((a, b) => {
      const c = (a.name || "").trim().localeCompare((b.name || "").trim());
      if (c !== 0) return c;
      return a.place_id - b.place_id;
    });
    for (let placeOrder = 0; placeOrder < slotPlaces.length; placeOrder++) {
      const place = slotPlaces[placeOrder];
      orderedPlaces.push({
        place_id: place.place_id,
        name: place.name,
        address: place.address,
        longitude: place.longitude,
        latitude: place.latitude,
        day_index: dayIndex,
        slot_id: slot.id,
        slot_label: slot.label,
        slot_order: slotOrder,
        place_order: placeOrder,
      });
    }
  }

  const legs = [];
  for (let i = 0; i < orderedPlaces.length - 1; i++) {
    const originPlace = await loadPlace(orderedPlaces[i].place_id);
    const destPlace = await loadPlace(orderedPlaces[i + 1].place_id);
    legs.push(await buildRouteLeg(originPlace, destPlace));
  }

  return {
    day_index: dayIndex,
    places: orderedPlaces,
    legs: legs,
  };
}

// ─── DeepSeek / AI ───────────────────────────────────────────────────────────

function resolveDeepSeekApiKey() {
  const key = String(DeepSeekApiKey).trim();
  if (!key || isPlaceholder(key)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      "后端 AI 密钥未配置，请在 CloudBase 控制台设置 DEEPSEEK_API_KEY",
      400
    );
  }
  return key;
}

function seasonHintText(planDateText) {
  let month = 4;
  try {
    month = new Date(planDateText + "T00:00:00").getMonth() + 1;
  } catch {}
  if ([12, 1, 2].includes(month))
    return "冬季，通常偏冷，建议保暖并优先考虑室内或防风路线。";
  if ([3, 4, 5].includes(month))
    return "春季，通常温和但早晚温差可能较大，建议洋葱式穿搭。";
  if ([6, 7, 8].includes(month))
    return "夏季，通常炎热，建议避开正午暴晒并注意补水。";
  return "秋季，通常较舒适但昼夜温差逐步增大，建议备薄外套。";
}

function webSearchSnippets(query, maxItems = 3, timeoutSec = 2.0) {
  const keyword = query.trim();
  if (!keyword) return Promise.resolve([]);

  const params = new URLSearchParams({
    q: keyword,
    format: "json",
    no_html: "1",
    no_redirect: "1",
  });
  const url = `https://api.duckduckgo.com/?${params.toString()}`;

  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        timeout: Math.round(timeoutSec * 1000),
        headers: { "User-Agent": "Lab3-2/ai-summary" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const payload = JSON.parse(data);
            const snippets = [];
            const abstractText = String(
              payload.AbstractText || ""
            ).trim();
            if (abstractText) snippets.push(abstractText);

            const relatedTopics = payload.RelatedTopics || [];
            for (const item of relatedTopics) {
              if (snippets.length >= maxItems) break;
              if (typeof item === "object" && item.Text) {
                snippets.push(String(item.Text));
              } else if (typeof item === "object" && item.Topics) {
                for (const nested of item.Topics) {
                  if (
                    typeof nested === "object" &&
                    nested.Text
                  ) {
                    snippets.push(String(nested.Text));
                    if (snippets.length >= maxItems) break;
                  }
                }
              }
            }

            const deduped = [];
            const seen = new Set();
            for (const text of snippets) {
              const normalized = text.trim();
              if (!normalized || seen.has(normalized)) continue;
              seen.add(normalized);
              deduped.push(normalized);
              if (deduped.length >= maxItems) break;
            }
            resolve(deduped);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}

async function weatherContextForAi(plan, places) {
  if (!places || !places.length) {
    return {
      text: `暂无规划地点；天气不可用时请按季节给建议：${seasonHintText(
        plan.date
      )}`,
      usedFallback: true,
    };
  }
  const first = places[0];
  try {
    const { province, city, district, adcode } =
      await resolveAdminByLocation(first.longitude, first.latitude);
    const liveBody = await amapGet("/v3/weather/weatherInfo", {
      key: YourWebServiceKey,
      city: adcode,
      extensions: "base",
    });
    let weatherText = "未知";
    let temperatureText = "未知";
    if (liveBody.status === "1") {
      const lives = liveBody.lives || [];
      if (lives.length) {
        const live = lives[0] || {};
        weatherText = String(live.weather || "未知").trim();
        temperatureText = String(live.temperature || "未知").trim();
      }
    }
    const forecast = await loadWeatherForecastByAdcode(adcode);
    const matched = forecast.find((item) => item.date === plan.date);
    if (!matched) {
      return {
        text:
          `地点行政区：${province}${city}${district}；实时天气：${weatherText}，气温 ${temperatureText}℃。` +
          `规划日期 ${plan.date} 无可用预报，请按季节给建议：${seasonHintText(
            plan.date
          )}`,
        usedFallback: true,
      };
    }
    return {
      text:
        `地点行政区：${province}${city}${district}；实时天气：${weatherText}，气温 ${temperatureText}℃；` +
        `规划日期 ${plan.date} 预报：${matched.weather}，${matched.low_temp_c}~${matched.high_temp_c}℃。`,
      usedFallback: false,
    };
  } catch {
    return {
      text: `天气服务暂不可用，请按季节给建议：${seasonHintText(plan.date)}`,
      usedFallback: true,
    };
  }
}

async function loadSearchCityHint(places) {
  if (!places || !places.length) return "目的地";
  const first = places[0];
  try {
    const { city } = await resolveAdminByLocation(
      first.longitude,
      first.latitude
    );
    return city || "目的地";
  } catch {
    return first.address || "目的地";
  }
}

function itineraryContextText(slots) {
  if (!slots || !slots.length) return "暂无时段安排。";
  const lines = [];
  for (const slot of slots) {
    let slotTime;
    if (slot.start_minute != null && slot.end_minute != null) {
      const sh = Math.floor(slot.start_minute / 60);
      const sm = slot.start_minute % 60;
      const eh = Math.floor(slot.end_minute / 60);
      const em = slot.end_minute % 60;
      slotTime = `${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}-${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`;
    } else {
      slotTime = slot.label;
    }
    const placeNames =
      slot.places && slot.places.length
        ? slot.places.map((p) => p.name).join("、")
        : "未分配地点";
    const note = (slot.note || "").trim();
    let line = `- 第${slot.day_index}天 ${slotTime} ${slot.label}：${placeNames}`;
    if (note) line += `；备注：${note}`;
    lines.push(line);
  }
  return lines.join("\n");
}

function parseAiJsonResponse(content) {
  let text = (content || "").trim();
  if (!text) return { reply: "未获取到 AI 回复", strengths: [], risks: [], improvements: [] };

  let candidate = text;
  if (!(candidate.startsWith("{") && candidate.endsWith("}"))) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) candidate = match[0];
  }
  try {
    const parsed = JSON.parse(candidate);
    const reply = String(parsed.reply || "").trim() || text;
    const strengthsRaw = parsed.strengths || [];
    const risksRaw = parsed.risks || [];
    const improvementsRaw = parsed.improvements || [];
    const strengths = strengthsRaw
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 5);
    const risks = risksRaw
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 5);
    const improvements = improvementsRaw
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 5);
    return { reply, strengths, risks, improvements };
  } catch {
    return { reply: text, strengths: [], risks: [], improvements: [] };
  }
}

function httpPostJson(url, body, headers, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        ...headers,
      },
      timeout: timeoutMs,
    };
    const req = https.request(options, (res) => {
      let responseData = "";
      res.on("data", (chunk) => (responseData += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseData);
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new AppError(
                ErrorCode.HTTP,
                `AI 服务调用失败: HTTP ${res.statusCode} ${responseData}`.trim(),
                502
              )
            );
          } else {
            resolve(parsed);
          }
        } catch (e) {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new AppError(
                ErrorCode.HTTP,
                `AI 服务调用失败: HTTP ${res.statusCode}`,
                502
              )
            );
          } else {
            resolve(JSON.parse(responseData || "{}"));
          }
        }
      });
    });
    req.on("error", (e) => {
      reject(
        new AppError(
          ErrorCode.HTTP,
          `AI 服务网络错误: ${e.message}`,
          502
        )
      );
    });
    req.on("timeout", () => {
      req.destroy();
      reject(
        new AppError(ErrorCode.HTTP, "AI 服务调用超时", 502)
      );
    });
    req.write(data);
    req.end();
  });
}

function buildAiSystemPrompt(plan, places, itinerarySlots, weatherContext, budgetLines, attractionLines) {
  const placesText =
    places.length
      ? places.map((p) => `${p.name}(${p.address})`).join("、")
      : "暂无地点";
  const budgetPerPerson = plan.budget / Math.max(plan.people_count, 1);
  const itineraryText = itineraryContextText(itinerarySlots);

  return [
    "你是旅行规划助手。请基于提供的结构化上下文生成建议。",
    "请严格遵守以下输出格式：",
    "1) 首先输出给用户的综合建议文字（2-4 段，纯文本，不要使用任何 JSON 格式或 markdown 代码块包裹）。",
    "2) 然后单独一行输出分隔符：---JSON---",
    "3) 最后输出一个 JSON 对象（其中 reply 字段用空字符串占位即可）：",
    '{"reply":"","strengths":["优点1","优点2"],"risks":["风险1","风险2"],"improvements":["改进点1","改进点2"]}',
    "",
    "其他规则：",
    "1) 根据天气信息给出出行建议；若当天天气不可用，按日期对应季节给当地典型天气建议。",
    "2) 结合预算、人数与联网检索到的消费水平信息，判断是否可能超预算并给建议。",
    "3) 结合时段安排与联网检索到的景点信息（建议游玩时长/时机）提出可执行建议。",
    "4) 认真阅读备注，给个性化建议。",
    "5) AI 只是辅助解释，不要替代用户决策；不要虚构不在上下文中的确定性事实，如不确定请明确说明。",
    "上下文如下：",
    `- 规划标题：${plan.title}`,
    `- 日期：${plan.date}`,
    `- 预算：${plan.budget} 元`,
    `- 人数：${plan.people_count} 人`,
    `- 人均预算：${budgetPerPerson.toFixed(2)} 元`,
    `- 用户备注：${plan.preferences || "无"}`,
    `- 地点列表：${placesText}`,
    `- 天气上下文：${weatherContext}`,
    `- 时段安排：`,
    itineraryText,
    `- 联网检索（消费水平）：`,
    budgetLines,
    `- 联网检索（景点游览建议）：`,
    attractionLines,
  ].join("\n");
}

function buildRegularAiSystemPrompt(plan, places, itinerarySlots, weatherContext, budgetLines, attractionLines) {
  const placesText =
    places.length
      ? places.map((p) => `${p.name}(${p.address})`).join("、")
      : "暂无地点";
  const budgetPerPerson = plan.budget / Math.max(plan.people_count, 1);
  const itineraryText = itineraryContextText(itinerarySlots);

  return [
    "你是旅行规划助手。请基于提供的结构化上下文生成建议，输出必须是 JSON：",
    "{",
    '  "reply": "给用户的综合建议，2-4 段",',
    '  "strengths": ["优点1", "优点2"],',
    '  "risks": ["风险1", "风险2"],',
    '  "improvements": ["改进点1", "改进点2"]',
    "}",
    "请严格遵守：",
    "1) 根据天气信息给出出行建议；若当天天气不可用，按日期对应季节给当地典型天气建议。",
    "2) 结合预算、人数与联网检索到的消费水平信息，判断是否可能超预算并给建议。",
    "3) 结合时段安排与联网检索到的景点信息（建议游玩时长/时机）提出可执行建议。",
    "4) 认真阅读备注，给个性化建议。",
    "5) AI 只是辅助解释，不要替代用户决策；不要虚构不在上下文中的确定性事实，如不确定请明确说明。",
    "上下文如下：",
    `- 规划标题：${plan.title}`,
    `- 日期：${plan.date}`,
    `- 预算：${plan.budget} 元`,
    `- 人数：${plan.people_count} 人`,
    `- 人均预算：${budgetPerPerson.toFixed(2)} 元`,
    `- 用户备注：${plan.preferences || "无"}`,
    `- 地点列表：${placesText}`,
    `- 天气上下文：${weatherContext}`,
    `- 时段安排：`,
    itineraryText,
    `- 联网检索（消费水平）：`,
    budgetLines,
    `- 联网检索（景点游览建议）：`,
    attractionLines,
  ].join("\n");
}

async function callDeepSeekForSummary(plan, places, itinerarySlots, payload) {
  const apiKey = resolveDeepSeekApiKey();
  const { text: weatherContext, usedFallback: usedWeatherFallback } =
    await weatherContextForAi(plan, places);
  const cityHint = await loadSearchCityHint(places);

  const budgetQuery = `${cityHint} 旅游 人均 消费 水平 餐饮 交通 门票`;
  const budgetSnippets = await webSearchSnippets(
    budgetQuery,
    3,
    1.0
  );

  const placeNames = places.slice(0, 3).map((p) => p.name);
  let attractionSnippets = [];
  for (const placeName of placeNames) {
    if (attractionSnippets.length >= 6) break;
    const snippets = await webSearchSnippets(
      `${placeName} 建议游玩时长 适合游览时间`,
      2,
      1.0
    );
    attractionSnippets = attractionSnippets.concat(snippets);
  }
  attractionSnippets = attractionSnippets.slice(0, 6);

  const budgetLines = budgetSnippets.length
    ? budgetSnippets.map((line) => `* ${line}`).join("\n")
    : "* 未检索到有效结果，请用保守估计并说明不确定性";
  const attractionLines = attractionSnippets.length
    ? attractionSnippets.map((line) => `* ${line}`).join("\n")
    : "* 未检索到有效结果，请基于通用经验给出建议并说明不确定性";

  const historyForPrompt = (payload.history || [])
    .slice(-10)
    .filter((item) => (item.content || "").trim())
    .map((item) => ({
      role: item.role,
      content: (item.content || "").trim(),
    }));

  const systemPrompt = buildRegularAiSystemPrompt(plan, places, itinerarySlots, weatherContext, budgetLines, attractionLines);

  const messages = [{ role: "system", content: systemPrompt }];
  messages.push(...historyForPrompt);
  messages.push({ role: "user", content: (payload.question || "").trim() });

  const requestBody = {
    model: "deepseek-chat",
    temperature: 0.4,
    messages: messages,
  };

  console.log("[ai_summary] calling DeepSeek with model:", requestBody.model);
  let responseBody;
  try {
    responseBody = await httpPostJson(
      "https://api.deepseek.com/v1/chat/completions",
      requestBody,
      { Authorization: `Bearer ${apiKey}` }
    );
  } catch (e) {
    console.error("[ai_summary] DeepSeek API call failed:", e.message || e);
    throw e;
  }

  const choices = responseBody.choices || [];
  if (!choices.length) {
    throw new AppError(ErrorCode.HTTP, "AI 服务返回内容为空", 502);
  }
  const message = choices[0].message || {};
  let contentObj = message.content;
  let contentText;
  if (typeof contentObj === "string") {
    contentText = contentObj;
  } else if (Array.isArray(contentObj)) {
    contentText = contentObj
      .map((item) =>
        typeof item === "object" ? String(item.text || "") : String(item)
      )
      .join("")
      .trim();
  } else {
    contentText = String(contentObj || "").trim();
  }

  const { reply, strengths, risks, improvements } =
    parseAiJsonResponse(contentText);

  return {
    reply,
    strengths,
    risks,
    improvements,
    used_weather_fallback: usedWeatherFallback,
  };
}

/**
 * Streaming version — calls DeepSeek with stream:true and returns a Node.js
 * Readable that emits SSE events. The frontend can consume these progressively.
 *
 * SSE events:
 *   event: token   data: {"text":"..."}     ← incremental reply text
 *   event: done    data: {reply,strengths,risks,improvements}
 *   event: error   data: {message:"..."}
 */
async function callDeepSeekForSummaryStream(plan, places, itinerarySlots, payload) {
  const { Readable } = require("stream");
  const apiKey = resolveDeepSeekApiKey();
  const { text: weatherContext } = await weatherContextForAi(plan, places);
  const cityHint = await loadSearchCityHint(places);

  const budgetQuery = `${cityHint} 旅游 人均 消费 水平 餐饮 交通 门票`;
  const budgetSnippets = await webSearchSnippets(budgetQuery, 3, 1.0);

  const placeNames = places.slice(0, 3).map((p) => p.name);
  let attractionSnippets = [];
  for (const placeName of placeNames) {
    if (attractionSnippets.length >= 6) break;
    const snippets = await webSearchSnippets(`${placeName} 建议游玩时长 适合游览时间`, 2, 1.0);
    attractionSnippets = attractionSnippets.concat(snippets);
  }
  attractionSnippets = attractionSnippets.slice(0, 6);

  const budgetLines = budgetSnippets.length
    ? budgetSnippets.map((line) => `* ${line}`).join("\n")
    : "* 未检索到有效结果，请用保守估计并说明不确定性";
  const attractionLines = attractionSnippets.length
    ? attractionSnippets.map((line) => `* ${line}`).join("\n")
    : "* 未检索到有效结果，请基于通用经验给出建议并说明不确定性";

  const historyForPrompt = (payload.history || [])
    .slice(-10)
    .filter((item) => (item.content || "").trim())
    .map((item) => ({ role: item.role, content: (item.content || "").trim() }));

  const systemPrompt = buildAiSystemPrompt(plan, places, itinerarySlots, weatherContext, budgetLines, attractionLines);

  const messages = [{ role: "system", content: systemPrompt }];
  messages.push(...historyForPrompt);
  messages.push({ role: "user", content: (payload.question || "").trim() });

  const requestBody = {
    model: "deepseek-chat",
    temperature: 0.4,
    messages: messages,
    stream: true,
  };

  console.log("[ai_summary_stream] calling DeepSeek with stream:", requestBody.model);

  const stream = new Readable({
    read() { /* no-op — data is pushed from the HTTP response handler */ },
  });

  const urlObj = new URL("https://api.deepseek.com/v1/chat/completions");
  const postData = JSON.stringify(requestBody);

  const req = https.request(
    {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      },
      timeout: 90000,
    },
    (res) => {
      if ((res.statusCode || 200) >= 400) {
        let errorBody = "";
        res.on("data", (chunk) => {
          errorBody += chunk.toString();
        });
        res.on("end", () => {
          const message = `AI 服务返回异常状态 ${res.statusCode}${errorBody ? `: ${errorBody.slice(0, 300)}` : ""}`;
          console.error("[ai_summary_stream] bad status:", message);
          if (!stream.destroyed) {
            stream.push(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
            stream.push(null);
          }
        });
        return;
      }

      let sseBuffer = "";
      let replyBuffer = "";
      let fullReply = "";
      let foundSplit = false;
      let jsonBuffer = "";
      const SPLIT = "---JSON---";

      res.on("data", (chunk) => {
        sseBuffer += chunk.toString();

        // DeepSeek SSE lines are separated by \n\n
        const parts = sseBuffer.split("\n\n");
        sseBuffer = parts.pop() || "";

        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;

          // Extract the data: line
          const lines = trimmed.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === "[DONE]") {
              // Stream ended — parse JSON and send done event
              let summary;
              try {
                summary = JSON.parse(jsonBuffer.trim());
              } catch {
                // Fallback: try to extract JSON from buffer
                const match = (jsonBuffer || "").match(/\{[\s\S]*\}/);
                if (match) {
                  try {
                    summary = JSON.parse(match[0]);
                  } catch {
                    summary = { strengths: [], risks: [], improvements: [] };
                  }
                } else {
                  summary = { strengths: [], risks: [], improvements: [] };
                }
              }
              const strengths = (summary.strengths || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
              const risks = (summary.risks || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
              const improvements = (summary.improvements || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);

              const finalReply = fullReply.trim() || replyBuffer.trim();
              const donePayload = JSON.stringify({
                reply: finalReply,
                strengths,
                risks,
                improvements,
              });
              stream.push(`event: done\ndata: ${donePayload}\n\n`);
              stream.push(null);
              return;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (!delta) continue;

              if (!foundSplit) {
                // Append new text and check for the split marker
                replyBuffer += delta;
                const splitIdx = replyBuffer.indexOf(SPLIT);
                if (splitIdx !== -1) {
                  // Stream everything before the split, keep the rest for JSON parsing
                  const beforeSplit = replyBuffer.substring(0, splitIdx);
                  if (beforeSplit) {
                    fullReply += beforeSplit;
                    stream.push(`event: token\ndata: ${JSON.stringify({ text: beforeSplit })}\n\n`);
                  }
                  jsonBuffer = replyBuffer.substring(splitIdx + SPLIT.length);
                  replyBuffer = beforeSplit; // Final reply is everything before SPLIT
                  foundSplit = true;
                }
                // Don't stream yet while we're looking for the split —
                // we only emit tokens from the "safe" portion (already checked for split)
              } else {
                jsonBuffer += delta;
              }
            } catch {
              // Skip unparseable SSE data lines
            }
          }
        }

        // Stream safe portion of replyBuffer (everything except the last SPLIT.length chars,
        // which might be the start of the split marker split across chunks)
        if (!foundSplit && replyBuffer.length > SPLIT.length) {
          const safeLen = replyBuffer.length - SPLIT.length + 1;
          if (safeLen > 0) {
            const safeText = replyBuffer.substring(0, safeLen);
            fullReply += safeText;
            stream.push(`event: token\ndata: ${JSON.stringify({ text: safeText })}\n\n`);
            replyBuffer = replyBuffer.substring(safeLen);
          }
        }
      });

      res.on("error", (e) => {
        console.error("[ai_summary_stream] DeepSeek response error:", e.message);
        if (!stream.destroyed) {
          stream.push(`event: error\ndata: ${JSON.stringify({ message: `AI 服务响应错误: ${e.message}` })}\n\n`);
          stream.push(null);
        }
      });

      res.on("end", () => {
        // If [DONE] was already processed, stream was already ended
        if (stream.destroyed) return;

        // Stream any remaining safe reply text
        if (!foundSplit && replyBuffer.trim()) {
          fullReply += replyBuffer;
          stream.push(`event: token\ndata: ${JSON.stringify({ text: replyBuffer })}\n\n`);
        }

        // Try to parse summary from whatever we have
        let summaryJson = jsonBuffer.trim() || replyBuffer.trim();
        let summary;
        try {
          summary = JSON.parse(summaryJson);
        } catch {
          const match = summaryJson.match(/\{[\s\S]*\}/);
          if (match) {
            try { summary = JSON.parse(match[0]); } catch { summary = null; }
          }
        }
        if (!summary) summary = { strengths: [], risks: [], improvements: [] };

        const strengths = (summary.strengths || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
        const risks = (summary.risks || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
        const improvements = (summary.improvements || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
        const finalReply = foundSplit ? (fullReply.trim() || replyBuffer.trim()) : (fullReply.trim() || summary.reply || "");

        const donePayload = JSON.stringify({ reply: finalReply, strengths, risks, improvements });
        stream.push(`event: done\ndata: ${donePayload}\n\n`);
        stream.push(null);
      });
    }
  );

  req.on("error", (e) => {
    console.error("[ai_summary_stream] request error:", e.message);
    if (!stream.destroyed) {
      stream.push(`event: error\ndata: ${JSON.stringify({ message: `AI 服务网络错误: ${e.message}` })}\n\n`);
      stream.push(null);
    }
  });

  req.on("timeout", () => {
    console.error("[ai_summary_stream] request timeout");
    req.destroy();
    if (!stream.destroyed) {
      stream.push(`event: error\ndata: ${JSON.stringify({ message: "AI 服务调用超时" })}\n\n`);
      stream.push(null);
    }
  });

  req.write(postData);
  req.end();

  return stream;
}

module.exports = {
  nowIso,
  isPlaceholder,
  parseFloatSafe,
  parseIntSafe,
  mapPlanRow,
  mapPlaceRow,
  ensurePlanExists,
  loadPlace,
  loadPlan,
  loadPlanPlaces,
  loadAllPlacesWithPlanTitle,
  loadPlansOrdered,
  loadPlanRiskCheckCache,
  savePlanRiskCheckCache,
  invalidatePlanRiskCheckCache,
  validateItinerarySlots,
  sortItinerarySlots,
  sortDaySlotsForRoute,
  haversineDistanceM,
  formatDurationText,
  ensureMapConfigReady,
  amapGet,
  windPowerToMps,
  resolveAdminByLocation,
  loadWeatherForecastByAdcode,
  evaluateWeatherRisk,
  extractRoutePathAndDuration,
  loadWalkingRouteSummary,
  loadDrivingRouteSummary,
  loadTransitRouteSummary,
  buildRouteLeg,
  loadPlanItinerary,
  loadPlanDayRoute,
  resolveDeepSeekApiKey,
  seasonHintText,
  webSearchSnippets,
  weatherContextForAi,
  loadSearchCityHint,
  itineraryContextText,
  parseAiJsonResponse,
  callDeepSeekForSummary,
  callDeepSeekForSummaryStream,
};
