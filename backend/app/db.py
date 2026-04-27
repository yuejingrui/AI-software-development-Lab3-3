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
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS _healthcheck (
              id INTEGER PRIMARY KEY,
              touched_at TEXT NOT NULL
            );
            """.strip()
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plans (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              date TEXT NOT NULL,
              budget REAL NOT NULL,
              people_count INTEGER NOT NULL,
              preferences TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """.strip()
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS places (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              plan_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              address TEXT NOT NULL,
              longitude REAL NOT NULL,
              latitude REAL NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (plan_id) REFERENCES plans (id)
            );
            """.strip()
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS itinerary_slots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              plan_id INTEGER NOT NULL,
              day_index INTEGER NOT NULL DEFAULT 1,
              label TEXT NOT NULL,
              start_minute INTEGER NULL,
              end_minute INTEGER NULL,
              sort_index INTEGER NOT NULL DEFAULT 0,
              note TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
            );
            """.strip()
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS itinerary_slot_places (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              slot_id INTEGER NOT NULL,
              place_id INTEGER NOT NULL,
              sort_index INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (slot_id) REFERENCES itinerary_slots (id) ON DELETE CASCADE,
              FOREIGN KEY (place_id) REFERENCES places (id) ON DELETE CASCADE
            );
            """.strip()
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS risk_check_cache (
              plan_id INTEGER PRIMARY KEY,
              payload_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
            );
            """.strip()
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_places_plan_id
            ON places (plan_id);
            """.strip()
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_itinerary_slots_plan_id
            ON itinerary_slots (plan_id);
            """.strip()
        )
        slot_columns = conn.execute("PRAGMA table_info(itinerary_slots)").fetchall()
        slot_column_names = {
            str(row["name"] if isinstance(row, sqlite3.Row) else row[1])
            for row in slot_columns
        }
        if "day_index" not in slot_column_names:
            conn.execute("ALTER TABLE itinerary_slots ADD COLUMN day_index INTEGER NOT NULL DEFAULT 1;")
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_itinerary_slot_places_slot_id
            ON itinerary_slot_places (slot_id);
            """.strip()
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_itinerary_slot_places_place_id
            ON itinerary_slot_places (place_id);
            """.strip()
        )
        conn.commit()


@contextmanager
def db_conn() -> Iterator[sqlite3.Connection]:
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(get_db_path(), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON;")
        yield conn
    except sqlite3.Error as e:
        raise AppError(code=ErrorCode.DB, message=f"DB error: {e}", http_status=500) from e
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
