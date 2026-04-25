from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ErrorCode:
    OK: int = 0
    UNKNOWN: int = 1000
    VALIDATION: int = 1001
    HTTP: int = 1002
    NOT_FOUND: int = 1003
    DB: int = 2000


class AppError(Exception):
    def __init__(self, code: int, message: str, http_status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
