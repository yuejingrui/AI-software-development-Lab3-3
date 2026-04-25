from __future__ import annotations

import json
from datetime import datetime, timezone
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


class MapConfigData(BaseModel):
    js_key: str
    security_js_code: str


class MapSearchItem(BaseModel):
    name: str
    address: str
    longitude: float
    latitude: float


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


def _is_placeholder(value: str) -> bool:
    return value.strip() in {"", "------"}


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
        with db_conn() as conn:
            row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
            if row is None:
                raise AppError(code=ErrorCode.NOT_FOUND, message="规划不存在", http_status=404)
            return ok(_map_plan_row(row))

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
            return ok(_map_plan_row(row))

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
        return ok(_load_place(place_id))

    @app.get("/plans/{plan_id}/places", response_model=ApiResponse[list[PlaceData]])
    def list_plan_places(plan_id: int) -> ApiResponse[list[PlaceData]]:
        _ensure_plan_exists(plan_id)
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
            return ok([_map_place_row(row) for row in rows])

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
        return ok(_load_place(place_id))

    @app.delete("/places/{place_id}", response_model=ApiResponse[dict[str, bool]])
    def delete_place(place_id: int) -> ApiResponse[dict[str, bool]]:
        with db_conn() as conn:
            cursor = conn.execute("DELETE FROM places WHERE id = ?", (place_id,))
            conn.commit()
            if cursor.rowcount == 0:
                raise AppError(code=ErrorCode.NOT_FOUND, message="地点不存在", http_status=404)
            return ok({"deleted": True})

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

    @app.get("/map/reverse-geocode", response_model=ApiResponse[str])
    def map_reverse_geocode(longitude: float, latitude: float) -> ApiResponse[str]:
        _ensure_map_config_ready()
        if longitude < -180 or longitude > 180 or latitude < -90 or latitude > 90:
            raise AppError(code=ErrorCode.VALIDATION, message="经纬度范围非法", http_status=422)
        body = _amap_get(
            "/v3/geocode/regeo",
            {
                "key": YourWebServiceKey,
                "location": f"{longitude},{latitude}",
                "extensions": "base",
            },
        )
        if body.get("status") != "1":
            raise AppError(code=ErrorCode.HTTP, message=body.get("info", "逆地理解析失败"), http_status=502)
        address = ((body.get("regeocode") or {}).get("formatted_address") or "").strip()
        return ok(address)

    return app


app = create_app()
