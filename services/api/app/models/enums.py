"""Persisted enums. Database labels are the enum *values* (not the Python member names)."""

from enum import StrEnum

from sqlalchemy import Enum as SAEnum


class Language(StrEnum):
    UZ = "uz"
    RU = "ru"


class UserRole(StrEnum):
    CUSTOMER = "customer"
    OPERATOR = "operator"
    ADMIN = "admin"


class Unit(StrEnum):
    PIECE = "piece"
    KG = "kg"
    G = "g"
    L = "l"
    ML = "ml"


class PaymentMethod(StrEnum):
    CASH_ON_DELIVERY = "cash_on_delivery"
    CARD_ON_DELIVERY = "card_on_delivery"


def pg_enum(enum_cls: type[StrEnum], name: str) -> SAEnum:
    """Native PostgreSQL enum that stores member values."""
    return SAEnum(
        enum_cls,
        name=name,
        values_callable=lambda members: [member.value for member in members],
        validate_strings=True,
    )
