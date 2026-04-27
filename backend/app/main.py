from __future__ import annotations

import json
import re
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .db import db_conn, init_db
from .errors import AppError, ErrorCode
from .response import ApiResponse, ok
from .secrets import YourJsKey, YourSecurityJsCode, YourWebServiceKey


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
    has_custom_time = any(slot.start_minute is not None or slot.end_minute is not None for slot in slots)
    if has_custom_time:
        ranges: list[tuple[int, int]] = []
        for index, slot in enumerate(slots):
            if slot.start_minute is None or slot.end_minute is None:
                raise AppError(
                    code=ErrorCode.VALIDATION,
                    message="自定义时段时，所有时段都必须填写开始与结束时间",
                    http_status=422,
                )
            start_minute = slot.start_minute
            end_minute = slot.end_minute
            if start_minute < 0 or end_minute > 1440 or start_minute >= end_minute:
                raise AppError(
                    code=ErrorCode.VALIDATION,
                    message=f"时段 {index + 1} 时间范围非法，必须满足 00:00 <= 开始 < 结束 <= 24:00",
                    http_status=422,
                )
            ranges.append((start_minute, end_minute))
        ranges.sort(key=lambda item: item[0])
        for i in range(1, len(ranges)):
            prev_end = ranges[i - 1][1]
            curr_start = ranges[i][0]
            if curr_start < prev_end:
                raise AppError(code=ErrorCode.VALIDATION, message="自定义时段之间不能重叠", http_status=422)
    for slot in slots:
        if not slot.label.strip():
            raise AppError(code=ErrorCode.VALIDATION, message="时段名称不能为空", http_status=422)
        if len(set(slot.place_ids)) != len(slot.place_ids):
            raise AppError(code=ErrorCode.VALIDATION, message="同一时段不能重复分配同一地点", http_status=422)


def _sort_itinerary_slots(slots: list[ItinerarySlotData]) -> list[ItinerarySlotData]:
    if slots and all(slot.start_minute is not None and slot.end_minute is not None for slot in slots):
        return sorted(
            slots,
            key=lambda slot: (slot.start_minute or 0, slot.end_minute or 0, slot.sort_index, slot.id),
        )
    return sorted(slots, key=lambda slot: (slot.sort_index, slot.id))


def _load_plan_itinerary(plan_id: int) -> list[ItinerarySlotData]:
    with db_conn() as conn:
        slot_rows = conn.execute(
            """
            SELECT *
            FROM itinerary_slots
            WHERE plan_id = ?
            ORDER BY sort_index ASC, id ASC
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


def create_app() -> FastAPI:
    app = FastAPI(title="Lab3-2 API")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
            for sort_index, slot in enumerate(payload.slots):
                slot_cursor = conn.execute(
                    """
                    INSERT INTO itinerary_slots (plan_id, label, start_minute, end_minute, sort_index, note, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """.strip(),
                    (
                        plan_id,
                        slot.label.strip(),
                        slot.start_minute,
                        slot.end_minute,
                        sort_index,
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
                "offset": "10",
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
