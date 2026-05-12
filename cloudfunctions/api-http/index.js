"use strict";

const { corsHeaders, ok, errorResponse } = require("./response");
const { ErrorCode, AppError } = require("./errors");
const {
  COLLECTIONS,
  ensureCollections,
  nowIso,
  findOneByField,
  listByField,
  addDoc,
  updateByField,
  removeByField,
  removeByFieldIn,
  listByFieldIn,
} = require("./store");
const { YourJsKey, YourSecurityJsCode, YourWebServiceKey } = require("./secrets");
const {
  mapPlanRow,
  ensurePlanExists,
  loadPlace,
  loadPlan,
  loadPlanPlaces,
  loadAllPlacesWithPlanTitle,
  loadPlansOrdered,
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
  callDeepSeekForSummary,
  callDeepSeekForSummaryStream,
} = require("./utils");

function matchRoute(path) {
  if (path.startsWith("/api/") || path === "/api") path = path.slice(4) || "/";
  if (path.startsWith("/api-http/") || path === "/api-http") path = path.slice(9) || "/";
  if (path === "/health") return { handler: "health" };
  if (path === "/plans") return { handler: "plans" };
  let m = path.match(/^\/plans\/(\d+)\/pin$/);
  if (m) return { handler: "plan_pin", plan_id: parseInt(m[1], 10) };
  m = path.match(/^\/plans\/(\d+)$/);
  if (m) return { handler: "plan_by_id", plan_id: parseInt(m[1], 10) };
  m = path.match(/^\/plans\/(\d+)\/places$/);
  if (m) return { handler: "plan_places", plan_id: parseInt(m[1], 10) };
  m = path.match(/^\/plans\/(\d+)\/risk-check$/);
  if (m) return { handler: "risk_check", plan_id: parseInt(m[1], 10) };
  m = path.match(/^\/plans\/(\d+)\/itinerary$/);
  if (m) return { handler: "itinerary", plan_id: parseInt(m[1], 10) };
  m = path.match(/^\/plans\/(\d+)\/itinerary\/day-route$/);
  if (m) return { handler: "day_route", plan_id: parseInt(m[1], 10) };
  m = path.match(/^\/plans\/(\d+)\/ai-summary$/);
  if (m) return { handler: "ai_summary", plan_id: parseInt(m[1], 10) };
  m = path.match(/^\/places(?:\/(\d+))?$/);
  if (m) return { handler: "places", place_id: m[1] ? parseInt(m[1], 10) : null };
  if (path === "/map/config") return { handler: "map_config" };
  if (path === "/map/search") return { handler: "map_search" };
  if (path === "/map/reverse-geocode") return { handler: "map_reverse_geocode" };
  if (path === "/map/nearby-poi") return { handler: "map_nearby_poi" };
  if (path === "/weather/by-location") return { handler: "weather" };
  return null;
}

function generateEntityId() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

async function allocateId(collectionName) {
  for (let i = 0; i < 10; i += 1) {
    const id = generateEntityId();
    const exists = await findOneByField(collectionName, "id", id);
    if (!exists) return id;
  }
  throw new AppError(ErrorCode.DB, "生成 ID 失败，请重试", 500);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOnPlanNotFound(task) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await task();
    } catch (e) {
      const isPlanNotFound = e instanceof AppError && e.code === ErrorCode.NOT_FOUND && e.message === "规划不存在";
      if (!isPlanNotFound || attempt >= 4) throw e;
      await sleep(120);
    }
  }
  throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
}

async function routeRequest(event, context) {
  const { path, httpMethod, body: rawBody, queryStringParameters, headers: reqHeaders } = event;
  const origin = (reqHeaders && (reqHeaders.origin || reqHeaders.Origin)) || "";
  const params = queryStringParameters || {};
  const route = matchRoute(path);
  if (!route) {
    return { statusCode: 404, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.NOT_FOUND, "Not Found")) };
  }

  let payload;
  try {
    payload = rawBody ? (typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody) : {};
  } catch {
    payload = {};
  }

  if (route.handler === "health") {
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    await ensureCollections();
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ status: "ok", db: "ok" })) };
  }

  if (route.handler === "plans") {
    if (httpMethod === "POST") {
      const now = nowIso();
      const planId = await allocateId(COLLECTIONS.plans);
      await addDoc(COLLECTIONS.plans, {
        id: planId,
        title: (payload.title || "").trim(),
        date: (payload.date || "").trim(),
        budget: Number(payload.budget),
        people_count: Number(payload.people_count),
        preferences: (payload.preferences || "").trim(),
        pinned: 0,
        created_at: now,
        updated_at: now,
      });
      const createdPlaces = [];
      for (const place of (payload.places || [])) {
        const placeId = await allocateId(COLLECTIONS.places);
        await addDoc(COLLECTIONS.places, {
          id: placeId,
          plan_id: planId,
          name: (place.name || "").trim(),
          address: (place.address || "").trim(),
          longitude: Number(place.longitude),
          latitude: Number(place.latitude),
          created_at: now,
          updated_at: now,
        });
        createdPlaces.push(await loadPlace(placeId));
      }
      const row = await findOneByField(COLLECTIONS.plans, "id", planId);
      const planData = mapPlanRow(row);
      planData.places = createdPlaces;
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(planData)) };
    }
    if (httpMethod === "GET") {
      const rows = await loadPlansOrdered();
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(rows)) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  if (route.handler === "plan_by_id") {
    const planId = route.plan_id;
    if (httpMethod === "GET") {
      const data = await retryOnPlanNotFound(async () => loadPlan(planId));
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
    }
    if (httpMethod === "PUT") {
      const updated = await updateByField(COLLECTIONS.plans, "id", planId, {
        title: (payload.title || "").trim(),
        date: (payload.date || "").trim(),
        budget: Number(payload.budget),
        people_count: Number(payload.people_count),
        preferences: (payload.preferences || "").trim(),
        updated_at: nowIso(),
      });
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
      await invalidatePlanRiskCheckCache(planId);
      const row = await findOneByField(COLLECTIONS.plans, "id", planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(mapPlanRow(row))) };
    }
    if (httpMethod === "DELETE") {
      const plan = await findOneByField(COLLECTIONS.plans, "id", planId);
      if (!plan) throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
      const slots = await listByField(COLLECTIONS.itinerarySlots, "plan_id", planId);
      const slotIds = slots.map((s) => s.id);
      await removeByFieldIn(COLLECTIONS.itinerarySlotPlaces, "slot_id", slotIds);
      await removeByField(COLLECTIONS.itinerarySlots, "plan_id", planId);
      await removeByField(COLLECTIONS.places, "plan_id", planId);
      await removeByField(COLLECTIONS.riskCheckCache, "plan_id", planId);
      await removeByField(COLLECTIONS.plans, "id", planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ deleted: true })) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  if (route.handler === "plan_pin") {
    const planId = route.plan_id;
    if (httpMethod === "PUT") {
      const plan = await findOneByField(COLLECTIONS.plans, "id", planId);
      if (!plan) throw new AppError(ErrorCode.NOT_FOUND, "规划不存在", 404);
      const newPinned = plan.pinned ? 0 : 1;
      await updateByField(COLLECTIONS.plans, "id", planId, { pinned: newPinned, updated_at: nowIso() });
      const row = await findOneByField(COLLECTIONS.plans, "id", planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(mapPlanRow(row))) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  if (route.handler === "plan_places") {
    const planId = route.plan_id;
    if (httpMethod === "POST") {
      await retryOnPlanNotFound(async () => ensurePlanExists(planId));
      const placeId = await allocateId(COLLECTIONS.places);
      await addDoc(COLLECTIONS.places, {
        id: placeId,
        plan_id: planId,
        name: (payload.name || "").trim(),
        address: (payload.address || "").trim(),
        longitude: Number(payload.longitude),
        latitude: Number(payload.latitude),
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      await invalidatePlanRiskCheckCache(planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(await loadPlace(placeId))) };
    }
    if (httpMethod === "GET") {
      const data = await retryOnPlanNotFound(async () => {
        await ensurePlanExists(planId);
        return await loadPlanPlaces(planId);
      });
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  if (route.handler === "places") {
    const placeId = route.place_id;
    if (httpMethod === "GET" && placeId === null) {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(await loadAllPlacesWithPlanTitle())) };
    }
    if (httpMethod === "GET" && placeId !== null) {
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(await loadPlace(placeId))) };
    }
    if (httpMethod === "PUT" && placeId !== null) {
      const updated = await updateByField(COLLECTIONS.places, "id", placeId, {
        name: (payload.name || "").trim(),
        address: (payload.address || "").trim(),
        longitude: Number(payload.longitude),
        latitude: Number(payload.latitude),
        updated_at: nowIso(),
      });
      if (!updated) throw new AppError(ErrorCode.NOT_FOUND, "地点不存在", 404);
      const place = await loadPlace(placeId);
      await invalidatePlanRiskCheckCache(place.plan_id);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(place)) };
    }
    if (httpMethod === "DELETE" && placeId !== null) {
      const row = await findOneByField(COLLECTIONS.places, "id", placeId);
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, "地点不存在", 404);
      await removeByField(COLLECTIONS.places, "id", placeId);
      await removeByField(COLLECTIONS.itinerarySlotPlaces, "place_id", placeId);
      await invalidatePlanRiskCheckCache(row.plan_id);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ deleted: true })) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  if (route.handler === "risk_check") {
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    const planId = route.plan_id;
    ensureMapConfigReady();
    await retryOnPlanNotFound(async () => ensurePlanExists(planId));
    const plan = await retryOnPlanNotFound(async () => loadPlan(planId));
    const places = await loadPlanPlaces(planId);
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ weather_risk: await evaluateWeatherRisk(plan, places) })) };
  }

  if (route.handler === "itinerary") {
    const planId = route.plan_id;
    if (httpMethod === "GET") {
      const data = await retryOnPlanNotFound(async () => {
        await ensurePlanExists(planId);
        return await loadPlanItinerary(planId);
      });
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
    }
    if (httpMethod === "PUT") {
      await retryOnPlanNotFound(async () => ensurePlanExists(planId));
      const slots = payload.slots || [];
      validateItinerarySlots(slots);
      const placeIds = [...new Set(slots.flatMap((s) => s.place_ids || []))];
      if (placeIds.length) {
        const rows = await listByFieldIn(COLLECTIONS.places, "id", placeIds);
        const existing = new Set(rows.filter((r) => r.plan_id === planId).map((r) => r.id));
        const missing = placeIds.filter((id) => !existing.has(id));
        if (missing.length) throw new AppError(ErrorCode.VALIDATION, `存在不属于当前规划的地点: ${missing.join(", ")}`, 422);
      }
      const oldSlots = await listByField(COLLECTIONS.itinerarySlots, "plan_id", planId);
      const oldSlotIds = oldSlots.map((s) => s.id);
      await removeByFieldIn(COLLECTIONS.itinerarySlotPlaces, "slot_id", oldSlotIds);
      await removeByField(COLLECTIONS.itinerarySlots, "plan_id", planId);
      const now = nowIso();
      for (const slot of slots) {
        const slotId = await allocateId(COLLECTIONS.itinerarySlots);
        await addDoc(COLLECTIONS.itinerarySlots, {
          id: slotId,
          plan_id: planId,
          day_index: slot.day_index || 1,
          label: (slot.label || "").trim(),
          start_minute: slot.start_minute != null ? slot.start_minute : null,
          end_minute: slot.end_minute != null ? slot.end_minute : null,
          sort_index: slot.sort_index || 0,
          note: (slot.note || "").trim(),
          created_at: now,
          updated_at: now,
        });
        const pids = slot.place_ids || [];
        for (let i = 0; i < pids.length; i += 1) {
          await addDoc(COLLECTIONS.itinerarySlotPlaces, {
            id: await allocateId(COLLECTIONS.itinerarySlotPlaces),
            slot_id: slotId,
            place_id: pids[i],
            sort_index: i,
            created_at: now,
            updated_at: now,
          });
        }
      }
      await invalidatePlanRiskCheckCache(planId);
      return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(await loadPlanItinerary(planId))) };
    }
    return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
  }

  if (route.handler === "day_route") {
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    const planId = route.plan_id;
    await retryOnPlanNotFound(async () => ensurePlanExists(planId));
    const dayIndex = parseInt(params.day_index, 10);
    if (isNaN(dayIndex) || dayIndex < 1 || dayIndex > 30) throw new AppError(ErrorCode.VALIDATION, "天数范围非法", 422);
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(await loadPlanDayRoute(planId, dayIndex))) };
  }

  if (route.handler === "ai_summary") {
    if (httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    const planId = route.plan_id;
    const useStream = params.stream === "1";

    await retryOnPlanNotFound(async () => ensurePlanExists(planId));
    const plan = await retryOnPlanNotFound(async () => loadPlan(planId));
    const places = await loadPlanPlaces(planId);
    const itinerarySlots = await loadPlanItinerary(planId);

    // ── Streaming path ──────────────────────────────────────────
    if (useStream) {
      // Use context.res for true SSE when running as HTTP cloud function
      const httpRes = context && context.res;
      if (httpRes) {
        try {
          const stream = await callDeepSeekForSummaryStream(plan, places, itinerarySlots, payload);
          httpRes.writeHead(200, {
            ...corsHeaders(origin),
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          stream.pipe(httpRes);
          return undefined;
        } catch (e) {
          console.error("[ai_summary stream] error:", e.message || e, "code:", e.code || "none");
          if (!httpRes.writableEnded) {
            const placeCount = places.length;
            const hasNotes = !!(plan.preferences || "").trim();
            const fallback = {
              reply: "AI 服务当前不可用，已返回降级建议：请优先检查天气与时段冲突、核对预算与人数的人均成本，并在关键时段预留机动时间。",
              strengths: ["已完成基础规划信息（日期/预算/人数）", `已加入地点数量：${placeCount}`],
              risks: ["外部 AI 服务暂时不可用，建议稍后重试", "若当天天气突变，户外时段可能需要调整"],
              improvements: [
                "优先补齐每个时段的核心地点与预计停留时长",
                "为交通与排队预留 15~30 分钟缓冲",
                hasNotes ? "若有个性化备注，建议逐项映射到时段安排" : "可补充个性化备注以获得更精准建议",
              ],
            };
            httpRes.write(`event: done\ndata: ${JSON.stringify(fallback)}\n\n`);
            httpRes.end();
          }
          return undefined;
        }
      }

      // Fallback for SCF mode (no context.res): return Readable as body
      try {
        const stream = await callDeepSeekForSummaryStream(plan, places, itinerarySlots, payload);
        return {
          statusCode: 200,
          headers: {
            ...corsHeaders(origin),
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
          body: stream,
        };
      } catch (e) {
        console.error("[ai_summary stream] error:", e.message || e, "code:", e.code || "none");
        const { Readable } = require("stream");
        const errStream = new Readable({ read() {} });
        const placeCount = places.length;
        const hasNotes = !!(plan.preferences || "").trim();
        const fallback = {
          reply: "AI 服务当前不可用，已返回降级建议：请优先检查天气与时段冲突、核对预算与人数的人均成本，并在关键时段预留机动时间。",
          strengths: ["已完成基础规划信息（日期/预算/人数）", `已加入地点数量：${placeCount}`],
          risks: ["外部 AI 服务暂时不可用，建议稍后重试", "若当天天气突变，户外时段可能需要调整"],
          improvements: [
            "优先补齐每个时段的核心地点与预计停留时长",
            "为交通与排队预留 15~30 分钟缓冲",
            hasNotes ? "若有个性化备注，建议逐项映射到时段安排" : "可补充个性化备注以获得更精准建议",
          ],
        };
        const donePayload = JSON.stringify(fallback);
        errStream.push(`event: done\ndata: ${donePayload}\n\n`);
        errStream.push(null);
        return {
          statusCode: 200,
          headers: {
            ...corsHeaders(origin),
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
          body: errStream,
        };
      }
    }

    // ── Non-streaming path ──────────────────────────────────────
    let result;
    try {
      result = await callDeepSeekForSummary(plan, places, itinerarySlots, payload);
    } catch (e) {
      console.error("[ai_summary] error:", e.message || e, "code:", e.code || "none");
      if (!(e instanceof AppError)) throw e;
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
    }
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(result)) };
  }

  if (route.handler === "map_config") {
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    ensureMapConfigReady();
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ js_key: YourJsKey, security_js_code: YourSecurityJsCode })) };
  }

  if (route.handler === "map_search") {
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    ensureMapConfigReady();
    const keyword = (params.keywords || "").trim();
    if (!keyword) throw new AppError(ErrorCode.VALIDATION, "关键词不能为空", 422);
    const body = await amapGet("/v3/place/text", { key: YourWebServiceKey, keywords: keyword, offset: "5", page: "1", extensions: "base" });
    if (body.status !== "1") throw new AppError(ErrorCode.HTTP, body.info || "地点搜索失败", 502);
    const data = [];
    for (const row of (body.pois || [])) {
      const parts = String(row.location || "").split(",");
      if (parts.length !== 2) continue;
      const lon = parseFloatSafe(parts[0], NaN);
      const lat = parseFloatSafe(parts[1], NaN);
      if (isNaN(lon) || isNaN(lat)) continue;
      data.push({ name: String(row.name || "未命名地点").trim(), address: String(row.address || "地址未知").trim(), longitude: lon, latitude: lat });
    }
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(data)) };
  }

  if (route.handler === "map_reverse_geocode") {
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    ensureMapConfigReady();
    const lon = parseFloat(params.longitude);
    const lat = parseFloat(params.latitude);
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
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    ensureMapConfigReady();
    const lon = parseFloat(params.longitude);
    const lat = parseFloat(params.latitude);
    if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new AppError(ErrorCode.VALIDATION, "经纬度范围非法", 422);
    const body = await amapGet("/v3/place/around", { key: YourWebServiceKey, location: `${lon},${lat}`, radius: "120", offset: "1", page: "1", extensions: "base" });
    if (body.status !== "1") throw new AppError(ErrorCode.HTTP, body.info || "周边地点查询失败", 502);
    const pois = body.pois || [];
    if (!pois.length) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(null)) };
    const first = pois[0] || {};
    const parts = String(first.location || "").trim().split(",");
    if (parts.length !== 2) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(null)) };
    const poiLon = parseFloatSafe(parts[0], NaN);
    const poiLat = parseFloatSafe(parts[1], NaN);
    if (isNaN(poiLon) || isNaN(poiLat)) return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok(null)) };
    return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(ok({ name: String(first.name || "未命名地点").trim(), address: String(first.address || "地址未知").trim(), longitude: poiLon, latitude: poiLat })) };
  }

  if (route.handler === "weather") {
    if (httpMethod !== "GET") return { statusCode: 405, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.HTTP, "Method Not Allowed")) };
    ensureMapConfigReady();
    const lon = parseFloat(params.longitude);
    const lat = parseFloat(params.latitude);
    if (isNaN(lon) || isNaN(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new AppError(ErrorCode.VALIDATION, "经纬度范围非法", 422);
    const { province, city, district, adcode } = await resolveAdminByLocation(lon, lat);
    const liveBody = await amapGet("/v3/weather/weatherInfo", { key: YourWebServiceKey, city: adcode, extensions: "base" });
    if (liveBody.status !== "1") throw new AppError(ErrorCode.HTTP, liveBody.info || "实时天气查询失败", 502);
    const lives = liveBody.lives || [];
    if (!lives.length) throw new AppError(ErrorCode.HTTP, "未获取到实时天气信息", 502);
    const live = lives[0] || {};
    const current = {
      province,
      city,
      district,
      adcode,
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
  const reqHeaders = event.headers || {};
  const origin = (reqHeaders.origin || reqHeaders.Origin) || "";
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  await ensureCollections();
  try {
    const result = await routeRequest(event, context);
    // undefined means response was already sent via context.res (HTTP cloud function SSE)
    if (result === undefined) return;
    return result;
  } catch (e) {
    if (e instanceof AppError) {
      return { statusCode: e.httpStatus, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(e.code, e.message)) };
    }
    if (e instanceof SyntaxError) {
      return { statusCode: 422, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.VALIDATION, e.message)) };
    }
    return { statusCode: 500, headers: corsHeaders(origin), body: JSON.stringify(errorResponse(ErrorCode.UNKNOWN, e.message)) };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// HTTP cloud function server (SCF HTTP Protocol)
// Started via scf_bootstrap. Proxies HTTP requests to the existing routing.
// ═══════════════════════════════════════════════════════════════════════════
const http = require("http");
const PORT = parseInt(process.env.TENCENTCLOUD_SERVER_PORT, 10) || 9000;

http
  .createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || "/", "http://localhost");
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      let rawBody;
      if (chunks.length) {
        rawBody = Buffer.concat(chunks).toString("utf-8");
      }

      const event = {
        path: parsedUrl.pathname,
        httpMethod: req.method,
        queryStringParameters: Object.fromEntries(parsedUrl.searchParams),
        headers: req.headers,
        body: rawBody,
      };

      const origin = (req.headers.origin || req.headers.Origin) || "";

      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(origin));
        res.end();
        return;
      }

      await ensureCollections();

      const result = await routeRequest(event, { res });
      if (result === undefined) return; // SSE streaming, response already piped

      if (result.body instanceof require("stream").Readable) {
        // SCF fallback: pipe stream
        res.writeHead(result.statusCode || 200, result.headers || corsHeaders(origin));
        result.body.pipe(res);
        return;
      }

      const statusCode = result.statusCode || 200;
      const headers = result.headers || corsHeaders(origin);
      const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body || "");
      res.writeHead(statusCode, headers);
      res.end(body);
    } catch (e) {
      const origin = (req.headers.origin || req.headers.Origin) || "";
      if (!res.writableEnded) {
        res.writeHead(500, corsHeaders(origin));
        res.end(JSON.stringify(errorResponse(ErrorCode.UNKNOWN, e.message || "Internal Server Error")));
      }
    }
  })
  .listen(PORT, () => {
    console.log(`api-http listening on port ${PORT}`);
  });
