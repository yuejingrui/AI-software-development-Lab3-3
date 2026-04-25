from __future__ import annotations

from typing import Generic, Optional, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    code: int
    message: str
    data: Optional[T] = None


def ok(data: T | None = None, message: str = "OK") -> ApiResponse[T]:
    return ApiResponse(code=0, message=message, data=data)

