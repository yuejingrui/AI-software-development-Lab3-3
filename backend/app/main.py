from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request as UrlRequest, urlopen

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .db import db_conn, init_db
from .errors import AppError, ErrorCode
from .response import ApiResponse, ok
from .secrets import YourJsKey, YourKeyKey, YourSecret, YourSecurityJsCode, YourWebServiceKey


class HealthData(BaseModel):
    status: str
    db: str


class PlanCreateInput(BaseModel):
    title: str = Field(min_length=1, max_length=50)
    date: str = Field(min_length=1)
    budget: float = Field(ge=0)
    people_count: int = Field(ge=1)
    preferences: str = Field(default="", max_length=500)


class PlanUpdateInput(BaseModel):
    title: str = Field(min_length=1, max_length=50)
    date: str = Field(min_length=1)
    budget: float = Field(ge=0)
    people_count: int = Field(ge=1)
    preferences: str = Field(default="", max_length=500)


class PlanData(BaseModel):
    id: int
    title: str
    date: str
    budget: float
    people_count: int
    preferences: str
    created_at: str
    updated_at: str


class PlaceCreateInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    address: str = Field(min_length=1, max_length=200)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)


class PlaceUpdateInput(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    address: str = Field(min_length=1, max_length=200)
    longitude: float = Field(ge=-180, le=180)
    latitude: float = Field(ge=-90, le=90)


class PlaceData(BaseModel):
    id: int
    plan_id: int
    plan_title: str | None = None
    name: str
    address: str
    longitude: float
    latitude: float
    created_at: str
    updated_at: str


class ItinerarySlotInput(BaseModel):
    id: int | None = None
    day_index: int = Field(default=1, ge=1, le=30)
    label: str = Field(min_length=1, max_length=30)
    start_minute: int | None = Field(default=None, ge=0, le=1440)
    end_minute: int | None = Field(default=None, ge=0, le=1440)
    sort_index: int = Field(default=0, ge=0)
    note: str = Field(default="", max_length=500)
    place_ids: list[int] = Field(default_factory=list)


class ItineraryUpdateInput(BaseModel):
    slots: list[ItinerarySlotInput] = Field(default_factory=list)


class ItinerarySlotPlaceData(BaseModel):
    slot_place_id: int
    sort_index: int
    place_id: int
    name: str
    address: str
    longitude: float
    latitude: float


class ItinerarySlotData(BaseModel):
    id: int
    plan_id: int
    day_index: int
    label: str
    start_minute: int | None
    end_minute: int | None
    sort_index: int
    note: str
    places: list[ItinerarySlotPlaceData]


class MapConfigData(BaseModel):
    js_key: str
    security_js_code: str


class MapSearchItem(BaseModel):
    name: str
    address: str
    longitude: float
    latitude: float


class MapReverseGeocodeData(BaseModel):
    name: str
    address: str


class MapNearbyPoiData(BaseModel):
    name: str
    address: str
    longitude: float
    latitude: float


class WeatherCurrentData(BaseModel):
    province: str
    city: str
    district: str
    adcode: str
    weather: str
    temperature_c: float
    wind_direction: str
    wind_speed_mps: float
    report_time: str


class WeatherForecastDayData(BaseModel):
    date: str
    weather: str
    high_temp_c: float
    low_temp_c: float


class WeatherByLocationData(BaseModel):
    province: str
    city: str
    district: str
    adcode: str
    current: WeatherCurrentData
    forecast: list[WeatherForecastDayData]


class WeatherRiskData(BaseModel):
    has_forecast_for_plan_date: bool
    has_rain_or_snow: bool
    suggestion: str
    matched_weather: str | None = None


class PlanRiskCheckData(BaseModel):
    weather_risk: WeatherRiskData


class AiSummaryHistoryItemInput(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)


class AiSummaryInput(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[AiSummaryHistoryItemInput] = Field(default_factory=list)


class AiSummaryData(BaseModel):
    reply: str
    strengths: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    improvements: list[str] = Field(default_factory=list)
    used_weather_fallback: bool


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _map_plan_row(row: Any) -> PlanData:
    return PlanData(
        id=row["id"],
        title=row["title"],
        date=row["date"],
        budget=row["budget"],
        people_count=row["people_count"],
        preferences=row["preferences"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _map_place_row(row: Any) -> PlaceData:
    plan_title = row["plan_title"] if "plan_title" in row.keys() else None
    return PlaceData(
        id=row["id"],
        plan_id=row["plan_id"],
        plan_title=plan_title,
        name=row["name"],
        address=row["address"],
        longitude=row["longitude"],
        latitude=row["latitude"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _ensure_plan_exists(plan_id: int) -> None:
    with db_conn() as conn:
        row = conn.execute("SELECT id FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if row is None:
            raise AppError(code=ErrorCode.NOT_FOUND, message="规划不存在", http_status=404)


def _load_place(place_id: int) -> PlaceData:
    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT places.*, plans.title AS plan_title
            FROM places
            JOIN plans ON plans.id = places.plan_id
            WHERE places.id = ?
            """.strip(),
            (place_id,),
        ).fetchone()
        if row is None:
            raise AppError(code=ErrorCode.NOT_FOUND, message="地点不存在", http_status=404)
        return _map_place_row(row)


def _load_plan(plan_id: int) -> PlanData:
    with db_conn() as conn:
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if row is None:
            raise AppError(code=ErrorCode.NOT_FOUND, message="规划不存在", http_status=404)
        return _map_plan_row(row)


def _load_plan_places(plan_id: int) -> list[PlaceData]:
    with db_conn() as conn:
        rows = conn.execute(
            """
            SELECT places.*, plans.title AS plan_title
            FROM places
            JOIN plans ON plans.id = places.plan_id
            WHERE places.plan_id = ?
            ORDER BY places.updated_at DESC, places.id DESC
            """.strip(),
            (plan_id,),
        ).fetchall()
        return [_map_place_row(row) for row in rows]


def _load_plan_risk_check_cache(plan_id: int) -> PlanRiskCheckData | None:
    with db_conn() as conn:
        row = conn.execute(
            """
            SELECT payload_json
            FROM risk_check_cache
            WHERE plan_id = ?
            """.strip(),
            (plan_id,),
        ).fetchone()
        if row is None:
            return None
        payload_json = str(row["payload_json"] or "").strip()
        if not payload_json:
            return None
        try:
            return PlanRiskCheckData.model_validate_json(payload_json)
        except Exception:
            return None


def _save_plan_risk_check_cache(plan_id: int, data: PlanRiskCheckData) -> None:
    with db_conn() as conn:
        conn.execute(
            """
            INSERT INTO risk_check_cache (plan_id, payload_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(plan_id) DO UPDATE SET
              payload_json = excluded.payload_json,
              updated_at = excluded.updated_at
            """.strip(),
            (plan_id, data.model_dump_json(), _now_iso()),
        )
        conn.commit()


def _invalidate_plan_risk_check_cache(plan_id: int) -> None:
    with db_conn() as conn:
        conn.execute("DELETE FROM risk_check_cache WHERE plan_id = ?", (plan_id,))
        conn.commit()


def _is_placeholder(value: str) -> bool:
    return value.strip() in {"", "------"}


def _validate_itinerary_slots(slots: list[ItinerarySlotInput]) -> None:
    if not slots:
        return
    slots_by_day: dict[int, list[ItinerarySlotInput]] = defaultdict(list)
    for slot in slots:
        slots_by_day[slot.day_index].append(slot)

    for day_index, day_slots in slots_by_day.items():
        has_custom_time = any(slot.start_minute is not None or slot.end_minute is not None for slot in day_slots)
        if has_custom_time:
            ranges: list[tuple[int, int]] = []
            for index, slot in enumerate(day_slots):
                if slot.start_minute is None or slot.end_minute is None:
                    raise AppError(
                        code=ErrorCode.VALIDATION,
                        message=f"第 {day_index} 天存在自定义时段时，所有时段都必须填写开始与结束时间",
                        http_status=422,
                    )
                start_minute = slot.start_minute
                end_minute = slot.end_minute
                if start_minute < 0 or end_minute > 1440 or start_minute >= end_minute:
                    raise AppError(
                        code=ErrorCode.VALIDATION,
                        message=f"第 {day_index} 天时段 {index + 1} 时间范围非法，必须满足 00:00 <= 开始 < 结束 <= 24:00",
                        http_status=422,
                    )
                ranges.append((start_minute, end_minute))
            ranges.sort(key=lambda item: item[0])
            for i in range(1, len(ranges)):
                prev_end = ranges[i - 1][1]
                curr_start = ranges[i][0]
                if curr_start < prev_end:
                    raise AppError(code=ErrorCode.VALIDATION, message=f"第 {day_index} 天的时段之间不能重叠", http_status=422)
        for slot in day_slots:
            if not slot.label.strip():
                raise AppError(code=ErrorCode.VALIDATION, message="时段名称不能为空", http_status=422)
            if len(set(slot.place_ids)) != len(slot.place_ids):
                raise AppError(code=ErrorCode.VALIDATION, message="同一时段不能重复分配同一地点", http_status=422)

def _sort_itinerary_slots(slots: list[ItinerarySlotData]) -> list[ItinerarySlotData]:
    if slots and all(slot.start_minute is not None and slot.end_minute is not None for slot in slots):
        return sorted(
            slots,
            key=lambda slot: (slot.day_index, slot.start_minute or 0, slot.end_minute or 0, slot.sort_index, slot.id),
        )
    return sorted(slots, key=lambda slot: (slot.day_index, slot.sort_index, slot.id))


def _load_plan_itinerary(plan_id: int) -> list[ItinerarySlotData]:
    with db_conn() as conn:
        slot_rows = conn.execute(
            """
            SELECT *
            FROM itinerary_slots
            WHERE plan_id = ?
            ORDER BY day_index ASC, sort_index ASC, id ASC
            """.strip(),
            (plan_id,),
        ).fetchall()
        if not slot_rows:
            return []
        slot_ids = [int(row["id"]) for row in slot_rows]
        placeholders = ",".join("?" for _ in slot_ids)
        place_rows = conn.execute(
            f"""
            SELECT isp.id AS slot_place_id, isp.slot_id, isp.sort_index, p.*
            FROM itinerary_slot_places AS isp
            JOIN places AS p ON p.id = isp.place_id
            WHERE isp.slot_id IN ({placeholders}) AND p.plan_id = ?
            ORDER BY isp.sort_index ASC, isp.id ASC
            """.strip(),
            (*slot_ids, plan_id),
        ).fetchall()
        places_by_slot: dict[int, list[ItinerarySlotPlaceData]] = defaultdict(list)
        for row in place_rows:
            slot_id = int(row["slot_id"])
            places_by_slot[slot_id].append(
                ItinerarySlotPlaceData(
                    slot_place_id=int(row["slot_place_id"]),
                    sort_index=int(row["sort_index"]),
                    place_id=int(row["id"]),
                    name=row["name"],
                    address=row["address"],
                    longitude=row["longitude"],
                    latitude=row["latitude"],
                )
            )
        slots = [
            ItinerarySlotData(
                id=int(row["id"]),
                plan_id=int(row["plan_id"]),
                day_index=int(row["day_index"]) if row["day_index"] is not None else 1,
                label=row["label"],
                start_minute=row["start_minute"],
                end_minute=row["end_minute"],
                sort_index=int(row["sort_index"]),
                note=row["note"],
                places=places_by_slot.get(int(row["id"]), []),
            )
            for row in slot_rows
        ]
        return _sort_itinerary_slots(slots)


def _ensure_map_config_ready() -> None:
    if _is_placeholder(YourJsKey) or _is_placeholder(YourSecurityJsCode) or _is_placeholder(YourWebServiceKey):
        raise AppError(code=ErrorCode.VALIDATION, message="后端地图密钥未配置，请先修改 backend/app/secrets.py", http_status=400)


def _amap_get(path: str, params: dict[str, str]) -> dict[str, Any]:
    query = urlencode(params)
    url = f"https://restapi.amap.com{path}?{query}"
    try:
        with urlopen(url, timeout=8) as response:
            payload = response.read().decode("utf-8")
            return json.loads(payload)
    except AppError:
        raise
    except Exception as exc:
        raise AppError(code=ErrorCode.HTTP, message=f"调用高德服务失败: {exc}", http_status=502) from exc


def _parse_float(value: Any, fallback: float = 0.0) -> float:
    try:
        return float(str(value).strip())
    except Exception:
        return fallback


def _wind_power_to_mps(wind_power_text: str) -> float:
    # 高德返回风力等级，需求里要求使用 m/s，这里用蒲福等级近似换算。
    beaufort_to_mps = {
        0: 0.2,
        1: 1.5,
        2: 3.3,
        3: 5.4,
        4: 7.9,
        5: 10.7,
        6: 13.8,
        7: 17.1,
        8: 20.7,
        9: 24.4,
        10: 28.4,
        11: 32.6,
        12: 36.9,
    }
    levels = [int(item) for item in re.findall(r"\d+", wind_power_text)]
    if not levels:
        return 0.0
    if len(levels) >= 2:
        level = int(round((levels[0] + levels[1]) / 2))
    else:
        level = levels[0]
    level = max(0, min(level, 12))
    return beaufort_to_mps[level]


def _resolve_admin_by_location(longitude: float, latitude: float) -> tuple[str, str, str, str]:
    reverse_body = _amap_get(
        "/v3/geocode/regeo",
        {
            "key": YourWebServiceKey,
            "location": f"{longitude},{latitude}",
            "extensions": "base",
        },
    )
    if reverse_body.get("status") != "1":
        raise AppError(code=ErrorCode.HTTP, message=reverse_body.get("info", "逆地理解析失败"), http_status=502)
    address_component = (reverse_body.get("regeocode") or {}).get("addressComponent") or {}
    adcode = str(address_component.get("adcode") or "").strip()
    if not adcode:
        raise AppError(code=ErrorCode.HTTP, message="未获取到城市编码 adcode", http_status=502)
    province = str(address_component.get("province") or "").strip() or "未知省份"
    city_raw = address_component.get("city")
    city = str(city_raw or "").strip() if not isinstance(city_raw, list) else ""
    if not city:
        city = province
    district = str(address_component.get("district") or "").strip() or "未知区县"
    return province, city, district, adcode


def _load_weather_forecast_by_adcode(adcode: str) -> list[WeatherForecastDayData]:
    forecast_body = _amap_get(
        "/v3/weather/weatherInfo",
        {
            "key": YourWebServiceKey,
            "city": adcode,
            "extensions": "all",
        },
    )
    if forecast_body.get("status") != "1":
        raise AppError(code=ErrorCode.HTTP, message=forecast_body.get("info", "天气预报查询失败"), http_status=502)
    forecasts = forecast_body.get("forecasts") or []
    casts = (forecasts[0] or {}).get("casts") if forecasts else []
    cast_rows = casts or []
    forecast: list[WeatherForecastDayData] = []
    for cast in cast_rows:
        row = cast or {}
        day_weather = str(row.get("dayweather") or "").strip()
        night_weather = str(row.get("nightweather") or "").strip()
        weather = day_weather or night_weather or "未知"
        day_temp = _parse_float(row.get("daytemp"), 0.0)
        night_temp = _parse_float(row.get("nighttemp"), 0.0)
        high_temp = max(day_temp, night_temp)
        low_temp = min(day_temp, night_temp)
        date_text = str(row.get("date") or "").strip()
        try:
            date.fromisoformat(date_text)
        except ValueError:
            continue
        forecast.append(
            WeatherForecastDayData(
                date=date_text,
                weather=weather,
                high_temp_c=high_temp,
                low_temp_c=low_temp,
            )
        )
    return forecast


def _evaluate_weather_risk(plan: PlanData, places: list[PlaceData]) -> WeatherRiskData:
    plan_date_text = plan.date.strip()
    if not plan_date_text:
        return WeatherRiskData(
            has_forecast_for_plan_date=False,
            has_rain_or_snow=False,
            suggestion="未设置规划日期，无法判断雨天户外风险",
        )
    try:
        date.fromisoformat(plan_date_text)
    except ValueError:
        return WeatherRiskData(
            has_forecast_for_plan_date=False,
            has_rain_or_snow=False,
            suggestion="规划日期格式非法，无法判断雨天户外风险",
        )
    if not places:
        return WeatherRiskData(
            has_forecast_for_plan_date=False,
            has_rain_or_snow=False,
            suggestion="暂无规划地点，无法判断雨天户外风险",
        )
    forecast_by_adcode: dict[str, list[WeatherForecastDayData]] = {}
    try:
        for place in places:
            _, _, _, adcode = _resolve_admin_by_location(place.longitude, place.latitude)
            if adcode not in forecast_by_adcode:
                forecast_by_adcode[adcode] = _load_weather_forecast_by_adcode(adcode)
            forecast = forecast_by_adcode[adcode]
            matched = next((item for item in forecast if item.date == plan_date_text), None)
            if matched is None:
                continue
            risky = ("雨" in matched.weather) or ("雪" in matched.weather)
            if risky:
                return WeatherRiskData(
                    has_forecast_for_plan_date=True,
                    has_rain_or_snow=True,
                    suggestion="建议谨慎选择户外活动",
                    matched_weather=matched.weather,
                )
    except AppError as exc:
        if "EXCEEDED_THE_LIMIT" in exc.message or "LIMIT" in exc.message:
            return WeatherRiskData(
                has_forecast_for_plan_date=False,
                has_rain_or_snow=False,
                suggestion="天气服务限流，暂无法判断雨天户外风险",
            )
        raise
    # 存在地点但未命中任一日期预报，或命中了但都不含雨雪
    for forecast in forecast_by_adcode.values():
        matched = next((item for item in forecast if item.date == plan_date_text), None)
        if matched is not None:
            return WeatherRiskData(
                has_forecast_for_plan_date=True,
                has_rain_or_snow=False,
                suggestion="当前预报未见雨雪，可正常安排户外活动",
                matched_weather=matched.weather,
            )
    return WeatherRiskData(
        has_forecast_for_plan_date=False,
        has_rain_or_snow=False,
        suggestion="规划日期暂无天气预报，无法判断雨天户外风险",
    )


def _resolve_glm_api_key() -> str:
    preferred = str(YourKeyKey).strip()
    fallback = str(YourSecret).strip()
    key = preferred if preferred and not _is_placeholder(preferred) else fallback
    if not key or _is_placeholder(key):
        raise AppError(code=ErrorCode.VALIDATION, message="后端 AI 密钥未配置，请先修改 backend/app/secrets.py", http_status=400)
    return key


def _season_hint_text(plan_date_text: str) -> str:
    try:
        month = date.fromisoformat(plan_date_text).month
    except Exception:
        month = 4
    if month in (12, 1, 2):
        return "冬季，通常偏冷，建议保暖并优先考虑室内或防风路线。"
    if month in (3, 4, 5):
        return "春季，通常温和但早晚温差可能较大，建议洋葱式穿搭。"
    if month in (6, 7, 8):
        return "夏季，通常炎热，建议避开正午暴晒并注意补水。"
    return "秋季，通常较舒适但昼夜温差逐步增大，建议备薄外套。"


def _web_search_snippets(query: str, max_items: int = 3, timeout_sec: float = 2.0) -> list[str]:
    keyword = query.strip()
    if not keyword:
        return []
    params = urlencode({"q": keyword, "format": "json", "no_html": "1", "no_redirect": "1"})
    url = f"https://api.duckduckgo.com/?{params}"
    request = UrlRequest(url=url, method="GET", headers={"User-Agent": "Lab3-2/ai-summary"})
    try:
        with urlopen(request, timeout=timeout_sec) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception:
        return []
    snippets: list[str] = []
    abstract_text = str(payload.get("AbstractText") or "").strip()
    if abstract_text:
        snippets.append(abstract_text)
    related_topics = payload.get("RelatedTopics") or []
    for item in related_topics:
        if isinstance(item, dict) and item.get("Text"):
            snippets.append(str(item.get("Text")))
        elif isinstance(item, dict):
            nested = item.get("Topics") or []
            for nested_item in nested:
                if isinstance(nested_item, dict) and nested_item.get("Text"):
                    snippets.append(str(nested_item.get("Text")))
                    if len(snippets) >= max_items:
                        break
        if len(snippets) >= max_items:
            break
    deduped: list[str] = []
    seen: set[str] = set()
    for text in snippets:
        normalized = text.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(normalized)
        if len(deduped) >= max_items:
            break
    return deduped


def _weather_context_for_ai(plan: PlanData, places: list[PlaceData]) -> tuple[str, bool]:
    if not places:
        return f"暂无规划地点；天气不可用时请按季节给建议：{_season_hint_text(plan.date)}", True
    first = places[0]
    try:
        province, city, district, adcode = _resolve_admin_by_location(first.longitude, first.latitude)
        live_body = _amap_get(
            "/v3/weather/weatherInfo",
            {
                "key": YourWebServiceKey,
                "city": adcode,
                "extensions": "base",
            },
        )
        weather_text = "未知"
        temperature_text = "未知"
        if live_body.get("status") == "1":
            lives = live_body.get("lives") or []
            if lives:
                live = lives[0] or {}
                weather_text = str(live.get("weather") or "未知").strip()
                temperature_text = str(live.get("temperature") or "未知").strip()
        forecast = _load_weather_forecast_by_adcode(adcode)
        matched = next((item for item in forecast if item.date == plan.date), None)
        if matched is None:
            return (
                f"地点行政区：{province}{city}{district}；实时天气：{weather_text}，气温 {temperature_text}℃。"
                f"规划日期 {plan.date} 无可用预报，请按季节给建议：{_season_hint_text(plan.date)}",
                True,
            )
        return (
            f"地点行政区：{province}{city}{district}；实时天气：{weather_text}，气温 {temperature_text}℃；"
            f"规划日期 {plan.date} 预报：{matched.weather}，{matched.low_temp_c}~{matched.high_temp_c}℃。",
            False,
        )
    except Exception:
        return f"天气服务暂不可用，请按季节给建议：{_season_hint_text(plan.date)}", True


def _load_search_city_hint(places: list[PlaceData]) -> str:
    if not places:
        return "目的地"
    first = places[0]
    try:
        _, city, _, _ = _resolve_admin_by_location(first.longitude, first.latitude)
        return city or "目的地"
    except Exception:
        return places[0].address or "目的地"


def _itinerary_context_text(slots: list[ItinerarySlotData]) -> str:
    if not slots:
        return "暂无时段安排。"
    lines: list[str] = []
    for slot in slots:
        if slot.start_minute is not None and slot.end_minute is not None:
            start_h = slot.start_minute // 60
            start_m = slot.start_minute % 60
            end_h = slot.end_minute // 60
            end_m = slot.end_minute % 60
            slot_time = f"{start_h:02d}:{start_m:02d}-{end_h:02d}:{end_m:02d}"
        else:
            slot_time = slot.label
        place_names = "、".join(place.name for place in slot.places) if slot.places else "未分配地点"
        note = slot.note.strip()
        line = f"- 第{slot.day_index}天 {slot_time} {slot.label}：{place_names}"
        if note:
            line += f"；备注：{note}"
        lines.append(line)
    return "\n".join(lines)


def _parse_ai_json_response(content: str) -> tuple[str, list[str], list[str], list[str]]:
    text = content.strip()
    if not text:
        return ("未获取到 AI 回复", [], [], [])
    candidate = text
    if not (candidate.startswith("{") and candidate.endswith("}")):
        matched = re.search(r"\{[\s\S]*\}", text)
        if matched:
            candidate = matched.group(0)
    try:
        parsed = json.loads(candidate)
    except Exception:
        return (text, [], [], [])
    reply = str(parsed.get("reply") or "").strip() or text
    strengths_raw = parsed.get("strengths") or []
    risks_raw = parsed.get("risks") or []
    improvements_raw = parsed.get("improvements") or []
    strengths = [str(item).strip() for item in strengths_raw if str(item).strip()]
    risks = [str(item).strip() for item in risks_raw if str(item).strip()]
    improvements = [str(item).strip() for item in improvements_raw if str(item).strip()]
    return (reply, strengths[:5], risks[:5], improvements[:5])


def _call_glm_for_summary(
    plan: PlanData,
    places: list[PlaceData],
    itinerary_slots: list[ItinerarySlotData],
    payload: AiSummaryInput,
) -> AiSummaryData:
    api_key = _resolve_glm_api_key()
    weather_context, used_weather_fallback = _weather_context_for_ai(plan, places)
    city_hint = _load_search_city_hint(places)
    web_deadline = time.monotonic() + 4.0
    budget_query = f"{city_hint} 旅游 人均 消费 水平 餐饮 交通 门票"
    budget_snippets = _web_search_snippets(budget_query, max_items=3, timeout_sec=1.5)
    place_names = [place.name for place in places[:3]]
    attraction_snippets: list[str] = []
    for place_name in place_names:
        if time.monotonic() > web_deadline:
            break
        snippets = _web_search_snippets(f"{place_name} 建议游玩时长 适合游览时间", max_items=2, timeout_sec=1.5)
        attraction_snippets.extend(snippets)
        if len(attraction_snippets) >= 6:
            break
    attraction_snippets = attraction_snippets[:6]

    places_text = "、".join([f"{item.name}({item.address})" for item in places]) if places else "暂无地点"
    budget_per_person = plan.budget / max(plan.people_count, 1)
    itinerary_text = _itinerary_context_text(itinerary_slots)
    history_for_prompt = [
        {"role": item.role, "content": item.content.strip()}
        for item in payload.history[-10:]
        if item.content.strip()
    ]
    system_prompt = f"""
你是旅行规划助手。请基于提供的结构化上下文生成建议，输出必须是 JSON：
{{
  "reply": "给用户的综合建议，2-4 段",
  "strengths": ["优点1", "优点2"],
  "risks": ["风险1", "风险2"],
  "improvements": ["改进点1", "改进点2"]
}}
请严格遵守：
1) 根据天气信息给出出行建议；若当天天气不可用，按日期对应季节给当地典型天气建议。
2) 结合预算、人数与联网检索到的消费水平信息，判断是否可能超预算并给建议。
3) 结合时段安排与联网检索到的景点信息（建议游玩时长/时机）提出可执行建议。
4) 认真阅读备注，给个性化建议。
5) AI 只是辅助解释，不要替代用户决策；不要虚构不在上下文中的确定性事实，如不确定请明确说明。
上下文如下：
- 规划标题：{plan.title}
- 日期：{plan.date}
- 预算：{plan.budget} 元
- 人数：{plan.people_count} 人
- 人均预算：{budget_per_person:.2f} 元
- 用户备注：{plan.preferences or "无"}
- 地点列表：{places_text}
- 天气上下文：{weather_context}
- 时段安排：
{itinerary_text}
- 联网检索（消费水平）：
{chr(10).join(f"* {line}" for line in budget_snippets) if budget_snippets else "* 未检索到有效结果，请用保守估计并说明不确定性"}
- 联网检索（景点游览建议）：
{chr(10).join(f"* {line}" for line in attraction_snippets) if attraction_snippets else "* 未检索到有效结果，请基于通用经验给出建议并说明不确定性"}
""".strip()
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    messages.extend(history_for_prompt)
    messages.append({"role": "user", "content": payload.question.strip()})

    request_body = {
        "model": "glm-4-flash",
        "temperature": 0.4,
        "messages": messages,
    }
    request = UrlRequest(
        url="https://open.bigmodel.cn/api/paas/v4/chat/completions",
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
    )
    try:
        with urlopen(request, timeout=12) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            detail = ""
        raise AppError(code=ErrorCode.HTTP, message=f"AI 服务调用失败: HTTP {exc.code} {detail}".strip(), http_status=502) from exc
    except URLError as exc:
        raise AppError(code=ErrorCode.HTTP, message=f"AI 服务网络错误: {exc}", http_status=502) from exc
    except Exception as exc:
        raise AppError(code=ErrorCode.HTTP, message=f"AI 服务调用失败: {exc}", http_status=502) from exc

    choices = body.get("choices") or []
    if not choices:
        raise AppError(code=ErrorCode.HTTP, message="AI 服务返回内容为空", http_status=502)
    message = choices[0].get("message") or {}
    content_obj = message.get("content")
    if isinstance(content_obj, str):
        content_text = content_obj
    elif isinstance(content_obj, list):
        chunks: list[str] = []
        for item in content_obj:
            if isinstance(item, dict):
                chunks.append(str(item.get("text") or ""))
            else:
                chunks.append(str(item))
        content_text = "".join(chunks).strip()
    else:
        content_text = str(content_obj or "").strip()
    reply, strengths, risks, improvements = _parse_ai_json_response(content_text)
    return AiSummaryData(
        reply=reply,
        strengths=strengths,
        risks=risks,
        improvements=improvements,
        used_weather_fallback=used_weather_fallback,
    )


def create_app() -> FastAPI:
    app = FastAPI(title="Lab3-2 API")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    def _startup() -> None:
        init_db()

    @app.exception_handler(AppError)
    async def _handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content=ApiResponse[Any](code=exc.code, message=exc.message, data=None).model_dump(),
        )

    @app.exception_handler(HTTPException)
    async def _handle_http_exception(_: Request, exc: HTTPException) -> JSONResponse:
        message = exc.detail if isinstance(exc.detail, str) else "HTTP error"
        return JSONResponse(
            status_code=exc.status_code,
            content=ApiResponse[Any](code=ErrorCode.HTTP, message=message, data=None).model_dump(),
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=ApiResponse[Any](code=ErrorCode.VALIDATION, message=str(exc), data=None).model_dump(),
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=500,
            content=ApiResponse[Any](code=ErrorCode.UNKNOWN, message=str(exc), data=None).model_dump(),
        )

    @app.get("/health", response_model=ApiResponse[HealthData])
    def health() -> ApiResponse[HealthData]:
        with db_conn() as conn:
            conn.execute("SELECT 1;")
        return ok(HealthData(status="ok", db="ok"))

    @app.post("/plans", response_model=ApiResponse[PlanData])
    def create_plan(payload: PlanCreateInput) -> ApiResponse[PlanData]:
        now = _now_iso()
        with db_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO plans (title, date, budget, people_count, preferences, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """.strip(),
                (
                    payload.title.strip(),
                    payload.date.strip(),
                    payload.budget,
                    payload.people_count,
                    payload.preferences.strip(),
                    now,
                    now,
                ),
            )
            conn.commit()
            plan_id = int(cursor.lastrowid)
            row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
            if row is None:
                raise AppError(code=ErrorCode.DB, message="创建规划失败", http_status=500)
            return ok(_map_plan_row(row))

    @app.get("/plans/{plan_id}", response_model=ApiResponse[PlanData])
    def get_plan(plan_id: int) -> ApiResponse[PlanData]:
        return ok(_load_plan(plan_id))

    @app.put("/plans/{plan_id}", response_model=ApiResponse[PlanData])
    def update_plan(plan_id: int, payload: PlanUpdateInput) -> ApiResponse[PlanData]:
        now = _now_iso()
        with db_conn() as conn:
            cursor = conn.execute(
                """
                UPDATE plans
                SET title = ?, date = ?, budget = ?, people_count = ?, preferences = ?, updated_at = ?
                WHERE id = ?
                """.strip(),
                (
                    payload.title.strip(),
                    payload.date.strip(),
                    payload.budget,
                    payload.people_count,
                    payload.preferences.strip(),
                    now,
                    plan_id,
                ),
            )
            conn.commit()
            if cursor.rowcount == 0:
                raise AppError(code=ErrorCode.NOT_FOUND, message="规划不存在", http_status=404)
            row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
            if row is None:
                raise AppError(code=ErrorCode.DB, message="读取更新后规划失败", http_status=500)
            plan = _map_plan_row(row)
        _invalidate_plan_risk_check_cache(plan_id)
        return ok(plan)

    @app.get("/plans", response_model=ApiResponse[list[PlanData]])
    def list_plans() -> ApiResponse[list[PlanData]]:
        with db_conn() as conn:
            rows = conn.execute("SELECT * FROM plans ORDER BY updated_at DESC, id DESC").fetchall()
            return ok([_map_plan_row(row) for row in rows])

    @app.post("/plans/{plan_id}/places", response_model=ApiResponse[PlaceData])
    def create_place(plan_id: int, payload: PlaceCreateInput) -> ApiResponse[PlaceData]:
        _ensure_plan_exists(plan_id)
        now = _now_iso()
        with db_conn() as conn:
            cursor = conn.execute(
                """
                INSERT INTO places (plan_id, name, address, longitude, latitude, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """.strip(),
                (
                    plan_id,
                    payload.name.strip(),
                    payload.address.strip(),
                    payload.longitude,
                    payload.latitude,
                    now,
                    now,
                ),
            )
            conn.commit()
            place_id = int(cursor.lastrowid)
        _invalidate_plan_risk_check_cache(plan_id)
        return ok(_load_place(place_id))

    @app.get("/plans/{plan_id}/places", response_model=ApiResponse[list[PlaceData]])
    def list_plan_places(plan_id: int) -> ApiResponse[list[PlaceData]]:
        _ensure_plan_exists(plan_id)
        return ok(_load_plan_places(plan_id))

    @app.get("/plans/{plan_id}/risk-check", response_model=ApiResponse[PlanRiskCheckData])
    def get_plan_risk_check(plan_id: int) -> ApiResponse[PlanRiskCheckData]:
        _ensure_map_config_ready()
        _ensure_plan_exists(plan_id)
        cached = _load_plan_risk_check_cache(plan_id)
        if cached is not None:
            return ok(cached)
        plan = _load_plan(plan_id)
        places = _load_plan_places(plan_id)
        weather_risk = _evaluate_weather_risk(plan, places)
        result = PlanRiskCheckData(weather_risk=weather_risk)
        _save_plan_risk_check_cache(plan_id, result)
        return ok(result)

    @app.get("/places", response_model=ApiResponse[list[PlaceData]])
    def list_places() -> ApiResponse[list[PlaceData]]:
        with db_conn() as conn:
            rows = conn.execute(
                """
                SELECT places.*, plans.title AS plan_title
                FROM places
                JOIN plans ON plans.id = places.plan_id
                ORDER BY places.updated_at DESC, places.id DESC
                """.strip()
            ).fetchall()
            return ok([_map_place_row(row) for row in rows])

    @app.put("/places/{place_id}", response_model=ApiResponse[PlaceData])
    def update_place(place_id: int, payload: PlaceUpdateInput) -> ApiResponse[PlaceData]:
        now = _now_iso()
        with db_conn() as conn:
            cursor = conn.execute(
                """
                UPDATE places
                SET name = ?, address = ?, longitude = ?, latitude = ?, updated_at = ?
                WHERE id = ?
                """.strip(),
                (
                    payload.name.strip(),
                    payload.address.strip(),
                    payload.longitude,
                    payload.latitude,
                    now,
                    place_id,
                ),
            )
            conn.commit()
            if cursor.rowcount == 0:
                raise AppError(code=ErrorCode.NOT_FOUND, message="地点不存在", http_status=404)
        place = _load_place(place_id)
        _invalidate_plan_risk_check_cache(place.plan_id)
        return ok(place)

    @app.delete("/places/{place_id}", response_model=ApiResponse[dict[str, bool]])
    def delete_place(place_id: int) -> ApiResponse[dict[str, bool]]:
        with db_conn() as conn:
            row = conn.execute("SELECT plan_id FROM places WHERE id = ?", (place_id,)).fetchone()
            if row is None:
                raise AppError(code=ErrorCode.NOT_FOUND, message="地点不存在", http_status=404)
            plan_id = int(row["plan_id"])
            cursor = conn.execute("DELETE FROM places WHERE id = ?", (place_id,))
            conn.commit()
            if cursor.rowcount == 0:
                raise AppError(code=ErrorCode.NOT_FOUND, message="地点不存在", http_status=404)
        _invalidate_plan_risk_check_cache(plan_id)
        return ok({"deleted": True})

    @app.get("/plans/{plan_id}/itinerary", response_model=ApiResponse[list[ItinerarySlotData]])
    def get_plan_itinerary(plan_id: int) -> ApiResponse[list[ItinerarySlotData]]:
        _ensure_plan_exists(plan_id)
        return ok(_load_plan_itinerary(plan_id))

    @app.put("/plans/{plan_id}/itinerary", response_model=ApiResponse[list[ItinerarySlotData]])
    def replace_plan_itinerary(plan_id: int, payload: ItineraryUpdateInput) -> ApiResponse[list[ItinerarySlotData]]:
        _ensure_plan_exists(plan_id)
        _validate_itinerary_slots(payload.slots)
        place_ids = sorted({place_id for slot in payload.slots for place_id in slot.place_ids})
        with db_conn() as conn:
            if place_ids:
                placeholders = ",".join("?" for _ in place_ids)
                rows = conn.execute(
                    f"""
                    SELECT id
                    FROM places
                    WHERE plan_id = ? AND id IN ({placeholders})
                    """.strip(),
                    (plan_id, *place_ids),
                ).fetchall()
                existing_place_ids = {int(row["id"]) for row in rows}
                missing_ids = [str(pid) for pid in place_ids if pid not in existing_place_ids]
                if missing_ids:
                    raise AppError(
                        code=ErrorCode.VALIDATION,
                        message=f"存在不属于当前规划的地点: {', '.join(missing_ids)}",
                        http_status=422,
                    )
            conn.execute(
                """
                DELETE FROM itinerary_slot_places
                WHERE slot_id IN (SELECT id FROM itinerary_slots WHERE plan_id = ?)
                """.strip(),
                (plan_id,),
            )
            conn.execute("DELETE FROM itinerary_slots WHERE plan_id = ?", (plan_id,))
            now = _now_iso()
            for slot in payload.slots:
                slot_cursor = conn.execute(
                    """
                    INSERT INTO itinerary_slots (plan_id, day_index, label, start_minute, end_minute, sort_index, note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """.strip(),
                    (
                        plan_id,
                        slot.day_index,
                        slot.label.strip(),
                        slot.start_minute,
                        slot.end_minute,
                        slot.sort_index,
                        slot.note.strip(),
                        now,
                        now,
                    ),
                )
                slot_id = int(slot_cursor.lastrowid)
                for place_sort_index, place_id in enumerate(slot.place_ids):
                    conn.execute(
                        """
                        INSERT INTO itinerary_slot_places (slot_id, place_id, sort_index, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        """.strip(),
                        (slot_id, place_id, place_sort_index, now, now),
                    )
            conn.commit()
        _invalidate_plan_risk_check_cache(plan_id)
        return ok(_load_plan_itinerary(plan_id))

    @app.post("/plans/{plan_id}/ai-summary", response_model=ApiResponse[AiSummaryData])
    def plan_ai_summary(plan_id: int, payload: AiSummaryInput) -> ApiResponse[AiSummaryData]:
        _ensure_plan_exists(plan_id)
        plan = _load_plan(plan_id)
        places = _load_plan_places(plan_id)
        itinerary_slots = _load_plan_itinerary(plan_id)
        try:
            result = _call_glm_for_summary(plan=plan, places=places, itinerary_slots=itinerary_slots, payload=payload)
        except AppError:
            # 降级为本地规则建议，避免前端出现“Failed to fetch”并中断使用。
            place_count = len(places)
            has_notes = bool(plan.preferences.strip())
            result = AiSummaryData(
                reply=(
                    "AI 服务当前不可用，已返回降级建议："
                    "请优先检查天气与时段冲突、核对预算与人数的人均成本，并在关键时段预留机动时间。"
                ),
                strengths=[
                    "已完成基础规划信息（日期/预算/人数）",
                    f"已加入地点数量：{place_count}",
                ],
                risks=[
                    "外部 AI 服务暂时不可用，建议稍后重试",
                    "若当天天气突变，户外时段可能需要调整",
                ],
                improvements=[
                    "优先补齐每个时段的核心地点与预计停留时长",
                    "为交通与排队预留 15~30 分钟缓冲",
                    "若有个性化备注，建议逐项映射到时段安排" if has_notes else "可补充个性化备注以获得更精准建议",
                ],
                used_weather_fallback=True,
            )
        return ok(result)

    @app.get("/map/config", response_model=ApiResponse[MapConfigData])
    def get_map_config() -> ApiResponse[MapConfigData]:
        _ensure_map_config_ready()
        return ok(MapConfigData(js_key=YourJsKey, security_js_code=YourSecurityJsCode))

    @app.get("/map/search", response_model=ApiResponse[list[MapSearchItem]])
    def map_search(keywords: str) -> ApiResponse[list[MapSearchItem]]:
        _ensure_map_config_ready()
        keyword = keywords.strip()
        if not keyword:
            raise AppError(code=ErrorCode.VALIDATION, message="关键词不能为空", http_status=422)
        body = _amap_get(
            "/v3/place/text",
            {
                "key": YourWebServiceKey,
                "keywords": keyword,
                "offset": "5",
                "page": "1",
                "extensions": "base",
            },
        )
        if body.get("status") != "1":
            raise AppError(code=ErrorCode.HTTP, message=body.get("info", "地点搜索失败"), http_status=502)
        rows = body.get("pois") or []
        data: list[MapSearchItem] = []
        for row in rows:
            location = str(row.get("location", ""))
            parts = location.split(",")
            if len(parts) != 2:
                continue
            try:
                longitude = float(parts[0])
                latitude = float(parts[1])
            except Exception:
                continue
            data.append(
                MapSearchItem(
                    name=str(row.get("name") or "未命名地点").strip(),
                    address=str(row.get("address") or "地址未知").strip(),
                    longitude=longitude,
                    latitude=latitude,
                )
            )
        return ok(data)

    @app.get("/map/reverse-geocode", response_model=ApiResponse[MapReverseGeocodeData])
    def map_reverse_geocode(longitude: float, latitude: float) -> ApiResponse[MapReverseGeocodeData]:
        _ensure_map_config_ready()
        if longitude < -180 or longitude > 180 or latitude < -90 or latitude > 90:
            raise AppError(code=ErrorCode.VALIDATION, message="经纬度范围非法", http_status=422)
        body = _amap_get(
            "/v3/geocode/regeo",
            {
                "key": YourWebServiceKey,
                "location": f"{longitude},{latitude}",
                "extensions": "all",
            },
        )
        if body.get("status") != "1":
            raise AppError(code=ErrorCode.HTTP, message=body.get("info", "逆地理解析失败"), http_status=502)
        regeocode = body.get("regeocode") or {}
        formatted_address = str(regeocode.get("formatted_address") or "").strip()
        address_component = regeocode.get("addressComponent") or {}
        street_number = address_component.get("streetNumber") or {}
        pois = regeocode.get("pois") or []

        poi_name = ""
        poi_address = ""
        if pois:
            first_poi = pois[0] or {}
            poi_name = str(first_poi.get("name") or "").strip()
            poi_address = str(first_poi.get("address") or "").strip()

        building_name = str((address_component.get("building") or {}).get("name") or "").strip()
        neighborhood_name = str((address_component.get("neighborhood") or {}).get("name") or "").strip()
        street = str(street_number.get("street") or "").strip()
        number = str(street_number.get("number") or "").strip()

        doorplate = (f"{street}{number}").strip()
        if not doorplate:
            doorplate = number or street

        name = poi_name or building_name or neighborhood_name or doorplate or formatted_address or "未命名地点"
        address = doorplate or poi_address or formatted_address or "地址未知"
        return ok(MapReverseGeocodeData(name=name, address=address))

    @app.get("/map/nearby-poi", response_model=ApiResponse[MapNearbyPoiData | None])
    def map_nearby_poi(longitude: float, latitude: float) -> ApiResponse[MapNearbyPoiData | None]:
        _ensure_map_config_ready()
        if longitude < -180 or longitude > 180 or latitude < -90 or latitude > 90:
            raise AppError(code=ErrorCode.VALIDATION, message="经纬度范围非法", http_status=422)
        body = _amap_get(
            "/v3/place/around",
            {
                "key": YourWebServiceKey,
                "location": f"{longitude},{latitude}",
                "radius": "120",
                "offset": "1",
                "page": "1",
                "extensions": "base",
            },
        )
        if body.get("status") != "1":
            raise AppError(code=ErrorCode.HTTP, message=body.get("info", "周边地点查询失败"), http_status=502)
        pois = body.get("pois") or []
        if not pois:
            return ok(None)
        first = pois[0] or {}
        location = str(first.get("location") or "").strip()
        parts = location.split(",")
        if len(parts) != 2:
            return ok(None)
        try:
            poi_longitude = float(parts[0])
            poi_latitude = float(parts[1])
        except Exception:
            return ok(None)
        return ok(
            MapNearbyPoiData(
                name=str(first.get("name") or "未命名地点").strip(),
                address=str(first.get("address") or "地址未知").strip(),
                longitude=poi_longitude,
                latitude=poi_latitude,
            )
        )

    @app.get("/weather/by-location", response_model=ApiResponse[WeatherByLocationData])
    def weather_by_location(longitude: float, latitude: float) -> ApiResponse[WeatherByLocationData]:
        _ensure_map_config_ready()
        if longitude < -180 or longitude > 180 or latitude < -90 or latitude > 90:
            raise AppError(code=ErrorCode.VALIDATION, message="经纬度范围非法", http_status=422)

        province, city, district, adcode = _resolve_admin_by_location(longitude, latitude)

        live_body = _amap_get(
            "/v3/weather/weatherInfo",
            {
                "key": YourWebServiceKey,
                "city": adcode,
                "extensions": "base",
            },
        )
        if live_body.get("status") != "1":
            raise AppError(code=ErrorCode.HTTP, message=live_body.get("info", "实时天气查询失败"), http_status=502)
        lives = live_body.get("lives") or []
        if not lives:
            raise AppError(code=ErrorCode.HTTP, message="未获取到实时天气信息", http_status=502)
        live = lives[0] or {}

        current = WeatherCurrentData(
            province=province,
            city=city,
            district=district,
            adcode=adcode,
            weather=str(live.get("weather") or "未知").strip(),
            temperature_c=_parse_float(live.get("temperature"), 0.0),
            wind_direction=str(live.get("winddirection") or "未知").strip(),
            wind_speed_mps=_wind_power_to_mps(str(live.get("windpower") or "")),
            report_time=str(live.get("reporttime") or "").strip(),
        )

        forecast = _load_weather_forecast_by_adcode(adcode)

        return ok(
            WeatherByLocationData(
                province=province,
                city=city,
                district=district,
                adcode=adcode,
                current=current,
                forecast=forecast,
            )
        )

    return app


app = create_app()
