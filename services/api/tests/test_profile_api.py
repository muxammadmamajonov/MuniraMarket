"""Profile hub without a database: validation rules, ``PATCH /me`` and the address routes."""

import uuid
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from app.api import auth_deps
from app.api.routes import me as me_routes
from app.domain.profile import (
    MAX_SAVED_ADDRESSES,
    check_birth_date,
    normalize_profile_phone,
    parse_birth_date,
    tashkent_today,
)
from app.repositories.addresses import (
    AddressInput,
    AddressLimitReachedError,
    SavedAddressRecord,
)
from app.repositories.users import UNSET, TelegramProfile
from app.schemas.addresses import SavedAddressRequest
from app.schemas.users import UpdateProfileRequest
from tests.conftest import FakeUserRepository

ACTOR = 123456789
ME = "/api/v1/me"
ADDRESSES = "/api/v1/me/addresses"
NOW = datetime(2026, 11, 13, 9, 0, tzinfo=UTC)


# --- pure rules -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "+998901234567",
        "998901234567",
        "901234567",
        "+998 90 123 45 67",
        "(90) 123-45-67",
        " 90 123 45 67 ",
        "+998 (90) 123-45-67",
    ],
)
def test_profile_phone_accepts_uzbek_forms(raw: str) -> None:
    assert normalize_profile_phone(raw) == "+998901234567"


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "12345678",  # 8 digits
        "9012345678",  # 10 digits
        "+79123456789",
        "+99890123456",  # +998 and 8 digits
        "+9989012345678",  # +998 and 10 digits
        "+901234567",
        "998+901234567",
        "tel:901234567",
        "90.123.45.67",
        "٩٠١٢٣٤٥٦٧",  # Arabic-Indic digits
    ],
)
def test_profile_phone_refuses_anything_else(raw: str) -> None:
    with pytest.raises(ValueError, match="Uzbekistan"):
        normalize_profile_phone(raw)


def test_birth_date_bounds() -> None:
    today = date(2026, 11, 13)
    assert check_birth_date(date(1900, 1, 1), today=today) == date(1900, 1, 1)
    assert check_birth_date(today, today=today) == today
    for bad in (date(1899, 12, 31), date(2026, 11, 14)):
        with pytest.raises(ValueError, match="between"):
            check_birth_date(bad, today=today)


@pytest.mark.parametrize(
    "raw", ["2000-1-01", "2000/01/01", "2000-02-30", "20000101", "2000-01-01T00:00:00", 20000101]
)
def test_birth_date_format(raw: object) -> None:
    with pytest.raises(ValueError, match="YYYY-MM-DD"):
        parse_birth_date(raw)


def test_tashkent_today_is_utc_plus_five() -> None:
    assert tashkent_today(datetime(2026, 11, 13, 18, 59, tzinfo=UTC)) == date(2026, 11, 13)
    assert tashkent_today(datetime(2026, 11, 13, 19, 0, tzinfo=UTC)) == date(2026, 11, 14)


# --- request models -----------------------------------------------------------------------------


def _errors(model: type[Any], payload: dict[str, Any]) -> list[tuple[tuple[Any, ...], str]]:
    with pytest.raises(ValidationError) as caught:
        model.model_validate(payload)
    return [(error["loc"], error["msg"]) for error in caught.value.errors()]


def test_profile_request_needs_at_least_one_key() -> None:
    assert _errors(UpdateProfileRequest, {}) == [
        ((), "Value error, at least one field is required")
    ]


def test_profile_request_refuses_unknown_keys_and_null_first_name() -> None:
    assert _errors(UpdateProfileRequest, {"username": "x"}) == [
        (("username",), "Extra inputs are not permitted")
    ]
    assert _errors(UpdateProfileRequest, {"first_name": None}) == [
        (("first_name",), "Input should be a valid string")
    ]


def test_profile_request_names() -> None:
    parsed = UpdateProfileRequest.model_validate({"first_name": "  Aziza ", "last_name": "   "})
    assert (parsed.first_name, parsed.last_name) == ("Aziza", None)
    assert parsed.model_fields_set == {"first_name", "last_name"}
    assert UpdateProfileRequest.model_validate({"last_name": None}).last_name is None
    assert _errors(UpdateProfileRequest, {"first_name": "  "}) == [
        (("first_name",), "String should have at least 1 character")
    ]
    assert _errors(UpdateProfileRequest, {"first_name": "a" * 65}) == [
        (("first_name",), "String should have at most 64 characters")
    ]
    assert _errors(UpdateProfileRequest, {"last_name": "b" * 65})[0][0] == ("last_name",)
    assert _errors(UpdateProfileRequest, {"first_name": "Az\niza"}) == [
        (("first_name",), "Value error, must be a single line of text")
    ]
    assert _errors(UpdateProfileRequest, {"last_name": "Ka\x00rimova"})[0] == (
        ("last_name",),
        "Value error, must be a single line of text",
    )
    # 64 code points, not bytes.
    assert UpdateProfileRequest.model_validate({"first_name": "Ш" * 64}).first_name == "Ш" * 64


def test_profile_request_birth_date() -> None:
    today = tashkent_today()
    parsed = UpdateProfileRequest.model_validate({"birth_date": "1990-05-17"})
    assert parsed.birth_date == date(1990, 5, 17)
    assert UpdateProfileRequest.model_validate({"birth_date": None}).birth_date is None
    assert UpdateProfileRequest.model_validate({"birth_date": "1900-01-01"}).birth_date
    assert UpdateProfileRequest.model_validate({"birth_date": today.isoformat()}).birth_date
    future = (today + timedelta(days=2)).isoformat()
    for bad, message in (
        ("1899-12-31", "between"),
        (future, "between"),
        ("1990-02-30", "YYYY-MM-DD"),
        ("17.05.1990", "YYYY-MM-DD"),
        (19900517, "YYYY-MM-DD"),
    ):
        errors = _errors(UpdateProfileRequest, {"birth_date": bad})
        assert errors[0][0] == ("birth_date",)
        assert message in errors[0][1]


def test_profile_request_phone() -> None:
    assert UpdateProfileRequest.model_validate({"phone": "90 123 45 67"}).phone == "+998901234567"
    assert UpdateProfileRequest.model_validate({"phone": None}).phone is None
    assert _errors(UpdateProfileRequest, {"phone": "+7 912 345 67 89"})[0][0] == ("phone",)
    assert _errors(UpdateProfileRequest, {"phone": "9" * 33})[0] == (
        ("phone",),
        "String should have at most 32 characters",
    )


ADDRESS = {"lat": 41.3110812, "lon": 69.2405624, "street": " Amir Temur ", "house": "1"}


def test_saved_address_request_reuses_the_delivery_address_rules() -> None:
    parsed = SavedAddressRequest.model_validate({**ADDRESS, "label": "  Uy ", "apartment": " "})
    assert (parsed.lat, parsed.lon, parsed.street) == (41.311081, 69.240562, "Amir Temur")
    assert (parsed.label, parsed.apartment) == ("Uy", None)
    assert "is_default" not in parsed.model_fields_set
    assert SavedAddressRequest.model_validate({**ADDRESS, "label": " "}).label is None
    assert _errors(SavedAddressRequest, {**ADDRESS, "label": "x" * 33})[0][0] == ("label",)
    assert _errors(SavedAddressRequest, {**ADDRESS, "label": "a\tb"})[0][1] == (
        "Value error, must be a single line of text"
    )
    assert _errors(SavedAddressRequest, {**ADDRESS, "is_default": None}) == [
        (("is_default",), "Input should be a valid boolean")
    ]
    assert _errors(SavedAddressRequest, {**ADDRESS, "district": "x"}) == [
        (("district",), "Extra inputs are not permitted")
    ]
    assert _errors(SavedAddressRequest, {**ADDRESS, "lat": 91})[0][0] == ("lat",)
    assert _errors(SavedAddressRequest, {**ADDRESS, "lon": "Infinity"})[0][0] == ("lon",)
    assert _errors(SavedAddressRequest, {**ADDRESS, "street": "A"})[0][0] == ("street",)
    assert _errors(SavedAddressRequest, {**ADDRESS, "floor": "123456789"})[0][0] == ("floor",)
    assert _errors(SavedAddressRequest, {**ADDRESS, "landmark": "x" * 201})[0][0] == ("landmark",)


# --- routes ---------------------------------------------------------------------------------------


class FakeAddressRepository:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.records: dict[uuid.UUID, SavedAddressRecord] = {}
        self.full = False

    def _make(self, data: AddressInput, *, is_default: bool) -> SavedAddressRecord:
        return SavedAddressRecord(
            id=uuid.uuid4(),
            label=data.label,
            lat=data.lat,
            lon=data.lon,
            street=data.street,
            house=data.house,
            apartment=data.apartment,
            entrance=data.entrance,
            floor=data.floor,
            landmark=data.landmark,
            is_default=is_default,
            created_at=NOW,
            updated_at=NOW,
        )

    async def list_for_user(self, user_id: uuid.UUID) -> list[SavedAddressRecord]:
        self.calls.append(("list", {"user_id": user_id}))
        return list(self.records.values())

    async def create(
        self, user_id: uuid.UUID, data: AddressInput, *, is_default: bool | None
    ) -> SavedAddressRecord:
        self.calls.append(("create", {"user_id": user_id, "data": data, "is_default": is_default}))
        if self.full:
            raise AddressLimitReachedError
        record = self._make(data, is_default=bool(is_default) or not self.records)
        self.records[record.id] = record
        return record

    async def replace(
        self,
        user_id: uuid.UUID,
        address_id: uuid.UUID,
        data: AddressInput,
        *,
        is_default: bool | None,
    ) -> SavedAddressRecord | None:
        self.calls.append(
            ("replace", {"user_id": user_id, "address_id": address_id, "is_default": is_default})
        )
        current = self.records.get(address_id)
        if current is None:
            return None
        updated = replace(
            self._make(data, is_default=current.is_default if is_default is None else is_default),
            id=address_id,
        )
        self.records[address_id] = updated
        return updated

    async def delete(self, user_id: uuid.UUID, address_id: uuid.UUID) -> bool:
        self.calls.append(("delete", {"user_id": user_id, "address_id": address_id}))
        return self.records.pop(address_id, None) is not None


@pytest.fixture
def addresses() -> FakeAddressRepository:
    return FakeAddressRepository()


@pytest.fixture
def signed_in(app: FastAPI, users: FakeUserRepository, addresses: FakeAddressRepository) -> None:
    async def allow() -> None:
        return None

    async def current() -> Any:
        return users.users[ACTOR]

    app.dependency_overrides[auth_deps.get_current_user] = current
    app.dependency_overrides[auth_deps.require_csrf] = allow
    app.dependency_overrides[me_routes.PREFERENCES_WRITE_LIMIT] = allow
    app.dependency_overrides[me_routes.get_address_repository] = lambda: addresses


@pytest.fixture(autouse=True)
async def seeded(users: FakeUserRepository) -> None:
    await users.upsert_from_telegram(TelegramProfile(ACTOR, "Aziza", "K", "aziza", "uz"))


async def test_profile_routes_need_a_session(client: httpx.AsyncClient) -> None:
    assert (await client.patch(ME, json={"first_name": "A"})).status_code == 401
    assert (await client.get(ADDRESSES)).status_code == 401
    assert (await client.post(ADDRESSES, json=ADDRESS)).status_code == 401
    assert (await client.delete(f"{ADDRESSES}/{uuid.uuid4()}")).status_code == 401


@pytest.mark.usefixtures("signed_in")
async def test_patch_me_changes_only_the_keys_sent(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    response = await client.patch(ME, json={"birth_date": "1990-05-17"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    user = response.json()["user"]
    assert (user["first_name"], user["last_name"], user["birth_date"]) == (
        "Aziza",
        "K",
        "1990-05-17",
    )
    changes = users.profile_updates[-1]
    assert changes.birth_date == date(1990, 5, 17)
    assert changes.first_name is UNSET
    assert changes.last_name is UNSET
    assert changes.phone is UNSET


@pytest.mark.usefixtures("signed_in")
async def test_patch_me_name_edit_survives_telegram_sign_in(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    response = await client.patch(ME, json={"first_name": " Munira ", "last_name": ""})
    assert response.status_code == 200, response.text
    assert (response.json()["user"]["first_name"], response.json()["user"]["last_name"]) == (
        "Munira",
        None,
    )
    again = await users.upsert_from_telegram(TelegramProfile(ACTOR, "Aziza", "K", "new_nick", "uz"))
    assert (again.first_name, again.last_name, again.username) == ("Munira", None, "new_nick")


@pytest.mark.usefixtures("signed_in")
async def test_patch_me_typed_phone_is_unverified_and_hinted(
    client: httpx.AsyncClient, users: FakeUserRepository
) -> None:
    response = await client.patch(ME, json={"phone": "90 123 45 67"})
    assert response.status_code == 200, response.text
    user = response.json()["user"]
    assert user["phone_verified"] is False
    assert user["phone_hint"] == "+998 •• ••• 45 67"
    assert "phone" not in user
    assert "90123" not in response.text
    assert users.profile_updates[-1].phone == "+998901234567"

    cleared = (await client.patch(ME, json={"phone": None})).json()["user"]
    assert (cleared["phone_hint"], cleared["phone_verified"]) == (None, False)


@pytest.mark.usefixtures("signed_in")
@pytest.mark.parametrize(
    ("body", "loc"),
    [
        ({}, ["body"]),
        ({"first_name": None}, ["body", "first_name"]),
        ({"phone": "12"}, ["body", "phone"]),
        ({"birth_date": "1899-12-31"}, ["body", "birth_date"]),
        ({"nickname": "x"}, ["body", "nickname"]),
    ],
)
async def test_patch_me_validation(
    client: httpx.AsyncClient, users: FakeUserRepository, body: dict[str, Any], loc: list[str]
) -> None:
    response = await client.patch(ME, json=body)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "validation_error"
    assert response.json()["error"]["details"][0]["loc"] == loc
    assert users.profile_updates == []


@pytest.mark.usefixtures("signed_in")
async def test_address_crud_routes(
    client: httpx.AsyncClient, addresses: FakeAddressRepository, users: FakeUserRepository
) -> None:
    created = await client.post(ADDRESSES, json={**ADDRESS, "label": "Uy"})
    assert created.status_code == 201, created.text
    assert created.headers["cache-control"] == "no-store"
    body = created.json()
    assert body["is_default"] is True
    assert (body["lat"], body["lon"], body["street"], body["label"]) == (
        41.311081,
        69.240562,
        "Amir Temur",
        "Uy",
    )
    assert addresses.calls[-1][1]["is_default"] is None
    assert set(body) == {
        "id",
        "label",
        "lat",
        "lon",
        "street",
        "house",
        "apartment",
        "entrance",
        "floor",
        "landmark",
        "is_default",
        "created_at",
        "updated_at",
    }

    listed = await client.get(ADDRESSES)
    assert listed.status_code == 200
    assert listed.headers["cache-control"] == "no-store"
    assert [item["id"] for item in listed.json()["items"]] == [body["id"]]

    replaced = await client.put(f"{ADDRESSES}/{body['id']}", json={**ADDRESS, "is_default": False})
    assert replaced.status_code == 200, replaced.text
    assert replaced.json()["is_default"] is False
    assert addresses.calls[-1] == (
        "replace",
        {
            "user_id": users.users[ACTOR].id,
            "address_id": uuid.UUID(body["id"]),
            "is_default": False,
        },
    )

    deleted = await client.delete(f"{ADDRESSES}/{body['id']}")
    assert deleted.status_code == 204
    assert deleted.content == b""


@pytest.mark.usefixtures("signed_in")
async def test_address_errors(client: httpx.AsyncClient, addresses: FakeAddressRepository) -> None:
    missing = uuid.uuid4()
    for response in (
        await client.put(f"{ADDRESSES}/{missing}", json=ADDRESS),
        await client.delete(f"{ADDRESSES}/{missing}"),
    ):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "address_not_found"

    addresses.full = True
    limited = await client.post(ADDRESSES, json=ADDRESS)
    assert limited.status_code == 409
    assert limited.json()["error"]["code"] == "address_limit_reached"
    assert MAX_SAVED_ADDRESSES == 10

    bad_id = await client.delete(f"{ADDRESSES}/not-a-uuid")
    assert bad_id.status_code == 422
    invalid = await client.post(ADDRESSES, json={**ADDRESS, "lat": None})
    assert invalid.status_code == 422
    assert invalid.json()["error"]["details"][0]["loc"] == ["body", "lat"]
