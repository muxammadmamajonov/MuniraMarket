"""Small validators shared by request models."""

from collections.abc import Callable
from typing import Literal, TypeVar

from pydantic_core import PydanticCustomError

T = TypeVar("T")

_MESSAGES = {
    "string_type": "Input should be a valid string",
    "bool_type": "Input should be a valid boolean",
}


def refuse_null(error_type: Literal["string_type", "bool_type"]) -> Callable[[T | None], T]:
    """For an optional, NOT nullable field declared ``X | SkipJsonSchema[None] = None``.

    Validators do not run on defaults, so ``None`` here was sent explicitly: refuse it with the
    error a non-nullable field gives (the field's schema already omits ``null``).
    """

    def check(value: T | None) -> T:
        if value is None:
            raise PydanticCustomError(error_type, _MESSAGES[error_type])
        return value

    return check
