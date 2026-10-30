import base64
import hashlib
import hmac
import json
from urllib.parse import urlencode

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.telegram.identity import (
    TELEGRAM_PUBLIC_KEYS,
    Ed25519InitDataVerifier,
    HmacInitDataVerifier,
    InvalidInitData,
)
from tests.conftest import NOW, TEST_BOT_ID, FakeClock

MAX_AGE = 86400
FAKE_BOT_TOKEN = "1234567:FAKE-bot-token-for-tests-only"

PRIVATE_KEY = Ed25519PrivateKey.generate()
PUBLIC_KEY_HEX = (
    PRIVATE_KEY.public_key()
    .public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    .hex()
)


def _user_json(**overrides: object) -> str:
    user: dict[str, object] = {
        "id": 123456789,
        "first_name": "Aziza",
        "last_name": "Karimova",
        "username": "aziza_k",
        "language_code": "ru",
    }
    user.update(overrides)
    return json.dumps(user, separators=(",", ":"), ensure_ascii=False)


def _base_fields(at: float = NOW - 100, **overrides: str) -> dict[str, str]:
    fields = {
        "auth_date": str(int(at)),
        "query_id": "AAH-fake-query-id",
        "user": _user_json(),
    }
    fields.update(overrides)
    return fields


def _ed25519_data_check_string(fields: dict[str, str], bot_id: int = TEST_BOT_ID) -> str:
    body = "\n".join(
        f"{key}={value}"
        for key, value in sorted(fields.items())
        if key not in {"hash", "signature"}
    )
    return f"{bot_id}:WebAppData\n{body}"


def sign_ed25519(fields: dict[str, str], *, bot_id: int = TEST_BOT_ID) -> str:
    signature = PRIVATE_KEY.sign(_ed25519_data_check_string(fields, bot_id).encode())
    unpadded = base64.urlsafe_b64encode(signature).rstrip(b"=").decode()
    return urlencode({**fields, "hash": "0" * 64, "signature": unpadded})


def sign_hmac(fields: dict[str, str], *, token: str = FAKE_BOT_TOKEN) -> str:
    secret_key = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    check = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()) if k != "hash")
    digest = hmac.new(secret_key, check.encode(), hashlib.sha256).hexdigest()
    return urlencode({**fields, "hash": digest})


@pytest.fixture
def ed_verifier(clock: FakeClock) -> Ed25519InitDataVerifier:
    return Ed25519InitDataVerifier(
        bot_id=TEST_BOT_ID, public_key_hex=PUBLIC_KEY_HEX, max_age_seconds=MAX_AGE, clock=clock
    )


@pytest.fixture
def hmac_verifier(clock: FakeClock) -> HmacInitDataVerifier:
    return HmacInitDataVerifier(bot_token=FAKE_BOT_TOKEN, max_age_seconds=MAX_AGE, clock=clock)


def _reason(excinfo: pytest.ExceptionInfo[InvalidInitData]) -> str:
    return excinfo.value.reason


# --- Ed25519 -------------------------------------------------------------------------------


def test_ed25519_valid_signature(ed_verifier: Ed25519InitDataVerifier) -> None:
    identity = ed_verifier.verify(sign_ed25519(_base_fields()))
    assert identity.telegram_user_id == 123456789
    assert identity.first_name == "Aziza"
    assert identity.last_name == "Karimova"
    assert identity.username == "aziza_k"
    assert identity.language_code == "ru"
    assert identity.auth_date == int(NOW - 100)


def test_ed25519_unicode_names_roundtrip(ed_verifier: Ed25519InitDataVerifier) -> None:
    fields = _base_fields(user=_user_json(first_name="Мунира", last_name="O'rinboyeva"))
    assert ed_verifier.verify(sign_ed25519(fields)).first_name == "Мунира"


def test_ed25519_signature_without_padding_is_accepted(
    ed_verifier: Ed25519InitDataVerifier,
) -> None:
    # 64 raw bytes encode to 86 base64url characters plus "==" padding, which Telegram omits.
    init_data = sign_ed25519(_base_fields())
    assert "%3D" not in init_data
    ed_verifier.verify(init_data)


def test_ed25519_tampered_field(ed_verifier: Ed25519InitDataVerifier) -> None:
    init_data = sign_ed25519(_base_fields())
    tampered = init_data.replace("AAH-fake-query-id", "AAH-other-query-id")
    with pytest.raises(InvalidInitData) as excinfo:
        ed_verifier.verify(tampered)
    assert _reason(excinfo) == "signature_mismatch"


def test_ed25519_tampered_user_id(ed_verifier: Ed25519InitDataVerifier) -> None:
    fields = _base_fields()
    init_data = sign_ed25519(fields)
    forged = init_data.replace("123456789", "987654321")
    assert forged != init_data
    with pytest.raises(InvalidInitData):
        ed_verifier.verify(forged)


def test_ed25519_signed_for_other_bot(ed_verifier: Ed25519InitDataVerifier) -> None:
    with pytest.raises(InvalidInitData):
        ed_verifier.verify(sign_ed25519(_base_fields(), bot_id=TEST_BOT_ID + 1))


def test_ed25519_signature_from_other_key(clock: FakeClock) -> None:
    other = Ed25519InitDataVerifier(
        bot_id=TEST_BOT_ID,
        public_key_hex=TELEGRAM_PUBLIC_KEYS["test"],
        max_age_seconds=MAX_AGE,
        clock=clock,
    )
    with pytest.raises(InvalidInitData):
        other.verify(sign_ed25519(_base_fields()))


def test_ed25519_hash_field_is_ignored(ed_verifier: Ed25519InitDataVerifier) -> None:
    fields = _base_fields()
    signature = sign_ed25519(fields)
    assert ed_verifier.verify(signature.replace("0" * 64, "f" * 64)).telegram_user_id == 123456789


@pytest.mark.parametrize(
    "signature",
    ["", "!!!not-base64!!!", "AAAA", "a" * 87, "A" * 86, "AB==", "AA AA"],
)
def test_ed25519_bad_signature_encoding(
    ed_verifier: Ed25519InitDataVerifier, signature: str
) -> None:
    init_data = urlencode({**_base_fields(), "signature": signature})
    with pytest.raises(InvalidInitData):
        ed_verifier.verify(init_data)


def test_ed25519_missing_signature(ed_verifier: Ed25519InitDataVerifier) -> None:
    with pytest.raises(InvalidInitData) as excinfo:
        ed_verifier.verify(urlencode({**_base_fields(), "hash": "0" * 64}))
    assert _reason(excinfo) == "signature_malformed"


def test_ed25519_expired(ed_verifier: Ed25519InitDataVerifier) -> None:
    with pytest.raises(InvalidInitData) as excinfo:
        ed_verifier.verify(sign_ed25519(_base_fields(at=NOW - MAX_AGE - 1)))
    assert _reason(excinfo) == "expired"


def test_ed25519_age_boundary_is_inclusive(ed_verifier: Ed25519InitDataVerifier) -> None:
    ed_verifier.verify(sign_ed25519(_base_fields(at=NOW - MAX_AGE)))


def test_ed25519_future_auth_date(ed_verifier: Ed25519InitDataVerifier) -> None:
    ed_verifier.verify(sign_ed25519(_base_fields(at=NOW + 60)))
    with pytest.raises(InvalidInitData) as excinfo:
        ed_verifier.verify(sign_ed25519(_base_fields(at=NOW + 61)))
    assert _reason(excinfo) == "auth_date_in_future"


@pytest.mark.parametrize("auth_date", ["", "abc", "-5", "1.5", " 1767225500", "١٧٦٧٢٢٥٥٠٠"])
def test_ed25519_bad_auth_date(ed_verifier: Ed25519InitDataVerifier, auth_date: str) -> None:
    with pytest.raises(InvalidInitData):
        ed_verifier.verify(sign_ed25519(_base_fields(auth_date=auth_date)))


def test_ed25519_missing_auth_date(ed_verifier: Ed25519InitDataVerifier) -> None:
    fields = _base_fields()
    del fields["auth_date"]
    with pytest.raises(InvalidInitData):
        ed_verifier.verify(sign_ed25519(fields))


def test_ed25519_missing_user(ed_verifier: Ed25519InitDataVerifier) -> None:
    fields = _base_fields()
    del fields["user"]
    with pytest.raises(InvalidInitData) as excinfo:
        ed_verifier.verify(sign_ed25519(fields))
    assert _reason(excinfo) == "user_missing"


@pytest.mark.parametrize(
    "user",
    [
        "not json",
        "[]",
        "null",
        '"x"',
        json.dumps({"first_name": "A"}),
        json.dumps({"id": "123", "first_name": "A"}),
        json.dumps({"id": 1.5, "first_name": "A"}),
        json.dumps({"id": True, "first_name": "A"}),
        json.dumps({"id": 0, "first_name": "A"}),
        json.dumps({"id": -4, "first_name": "A"}),
        json.dumps({"id": 5}),
        json.dumps({"id": 5, "first_name": "  "}),
        json.dumps({"id": 5, "first_name": "A", "username": 7}),
    ],
)
def test_ed25519_bad_user_payload(ed_verifier: Ed25519InitDataVerifier, user: str) -> None:
    with pytest.raises(InvalidInitData):
        ed_verifier.verify(sign_ed25519(_base_fields(user=user)))


def test_ed25519_duplicate_keys_are_rejected(ed_verifier: Ed25519InitDataVerifier) -> None:
    init_data = sign_ed25519(_base_fields())
    with pytest.raises(InvalidInitData) as excinfo:
        ed_verifier.verify(init_data + "&query_id=another")
    assert _reason(excinfo) == "duplicate_key"


@pytest.mark.parametrize("init_data", ["", "garbage", "a=1&&b=2", "=value", "novalue&x=1"])
def test_ed25519_malformed_query_strings(
    ed_verifier: Ed25519InitDataVerifier, init_data: str
) -> None:
    with pytest.raises(InvalidInitData):
        ed_verifier.verify(init_data)


def test_ed25519_optional_user_fields(ed_verifier: Ed25519InitDataVerifier) -> None:
    user = json.dumps({"id": 77, "first_name": "Solo"})
    identity = ed_verifier.verify(sign_ed25519(_base_fields(user=user)))
    assert (identity.last_name, identity.username, identity.language_code) == (None, None, None)


def test_published_public_keys_are_valid_ed25519_keys(clock: FakeClock) -> None:
    for key in TELEGRAM_PUBLIC_KEYS.values():
        Ed25519InitDataVerifier(bot_id=1, public_key_hex=key, max_age_seconds=MAX_AGE, clock=clock)
    assert TELEGRAM_PUBLIC_KEYS["production"] != TELEGRAM_PUBLIC_KEYS["test"]


# --- HMAC ----------------------------------------------------------------------------------


def test_hmac_valid(hmac_verifier: HmacInitDataVerifier) -> None:
    identity = hmac_verifier.verify(sign_hmac(_base_fields()))
    assert identity.telegram_user_id == 123456789
    assert identity.first_name == "Aziza"


def test_hmac_includes_signature_field_in_check_string(
    hmac_verifier: HmacInitDataVerifier,
) -> None:
    fields = _base_fields(signature="c2lnbmF0dXJl")
    hmac_verifier.verify(sign_hmac(fields))
    # Dropping `signature` after signing must break the hash.
    init_data = sign_hmac(fields)
    without_signature = "&".join(
        part for part in init_data.split("&") if not part.startswith("signature=")
    )
    with pytest.raises(InvalidInitData):
        hmac_verifier.verify(without_signature)


def test_hmac_wrong_token(clock: FakeClock) -> None:
    verifier = HmacInitDataVerifier(
        bot_token="9999:another-fake-token", max_age_seconds=MAX_AGE, clock=clock
    )
    with pytest.raises(InvalidInitData) as excinfo:
        verifier.verify(sign_hmac(_base_fields()))
    assert _reason(excinfo) == "hash_mismatch"


def test_hmac_tampered_field(hmac_verifier: HmacInitDataVerifier) -> None:
    init_data = sign_hmac(_base_fields())
    with pytest.raises(InvalidInitData):
        hmac_verifier.verify(init_data.replace("AAH-fake-query-id", "AAH-evil-query-id"))


def test_hmac_missing_or_bad_hash(hmac_verifier: HmacInitDataVerifier) -> None:
    with pytest.raises(InvalidInitData) as excinfo:
        hmac_verifier.verify(urlencode(_base_fields()))
    assert _reason(excinfo) == "hash_missing"
    with pytest.raises(InvalidInitData):
        hmac_verifier.verify(urlencode({**_base_fields(), "hash": "zz" * 32}))
    with pytest.raises(InvalidInitData):
        hmac_verifier.verify(urlencode({**_base_fields(), "hash": "é" * 32}))


def test_hmac_expired_and_future(hmac_verifier: HmacInitDataVerifier) -> None:
    with pytest.raises(InvalidInitData) as expired:
        hmac_verifier.verify(sign_hmac(_base_fields(at=NOW - MAX_AGE - 5)))
    assert _reason(expired) == "expired"
    with pytest.raises(InvalidInitData) as future:
        hmac_verifier.verify(sign_hmac(_base_fields(at=NOW + 3600)))
    assert _reason(future) == "auth_date_in_future"


def test_hmac_missing_user(hmac_verifier: HmacInitDataVerifier) -> None:
    fields = _base_fields()
    del fields["user"]
    with pytest.raises(InvalidInitData) as excinfo:
        hmac_verifier.verify(sign_hmac(fields))
    assert _reason(excinfo) == "user_missing"


def test_hmac_duplicate_keys(hmac_verifier: HmacInitDataVerifier) -> None:
    with pytest.raises(InvalidInitData) as excinfo:
        hmac_verifier.verify(sign_hmac(_base_fields()) + "&auth_date=1")
    assert _reason(excinfo) == "duplicate_key"
