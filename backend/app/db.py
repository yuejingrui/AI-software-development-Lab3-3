from __future__ import annotations

import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .errors import AppError, ErrorCode


def _default_db_path() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "app.db"


def get_db_path() -> Path:
    env_path = os.getenv("APP_DB_PATH")
    return Path(env_path).expanduser().resolve() if env_path else _default_db_path()


def init_db() -> None:
    db_path = get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS _healthcheck (
              id INTEGER PRIMARY KEY,
              touched_at TEXT NOT NULL
            );
            """.strip()
        )
        conn.commit()


@contextmanager
def db_conn() -> Iterator[sqlite3.Connection]:
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(get_db_path(), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        yield conn
    except sqlite3.Error as e:
        raise AppError(code=ErrorCode.DB, message=f"DB error: {e}", http_status=500) from e
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
