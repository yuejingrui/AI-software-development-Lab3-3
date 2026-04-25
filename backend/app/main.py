from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .db import db_conn, init_db
from .errors import AppError, ErrorCode
from .response import ApiResponse, ok


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

    return app


app = create_app()
