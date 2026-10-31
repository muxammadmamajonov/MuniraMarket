"""Product/category image URLs: syntactic validation only.

Real uploads (object storage) come with the deployment phase. Until then an admin may paste an
``https`` URL of an already-hosted image, or leave it empty (the UI shows a placeholder). The
server **never fetches** the URL (no SSRF surface); it only refuses URLs that are not plain public
``https`` links, so a browser rendering them cannot be pointed at internal hosts or be handed
credentials, scripts or ``data:`` payloads.
"""

import ipaddress
import re
from typing import Final
from urllib.parse import urlsplit

MAX_IMAGE_URL_LENGTH: Final = 2048
_HOST_LABEL = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_FORBIDDEN_SUFFIXES: Final = (".local", ".localhost", ".internal", ".lan", ".home", ".corp")


class InvalidImageUrlError(ValueError):
    pass


def validate_image_url(raw: str) -> str:
    """Return the URL unchanged if it is acceptable, else raise ``InvalidImageUrlError``."""
    if len(raw) > MAX_IMAGE_URL_LENGTH:
        raise InvalidImageUrlError("too long")
    if any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in raw):
        raise InvalidImageUrlError("contains whitespace or control characters")
    if not raw.isascii():
        raise InvalidImageUrlError("must be ASCII (percent-encode other characters)")
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        raise InvalidImageUrlError("malformed URL") from None
    if parts.scheme != "https":
        raise InvalidImageUrlError("must use https")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise InvalidImageUrlError("must not contain credentials")
    if port not in (None, 443):
        raise InvalidImageUrlError("must use the default https port")
    _check_host((parts.hostname or "").rstrip("."))
    return raw


def _check_host(host: str) -> None:
    if not host:
        raise InvalidImageUrlError("missing host")
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        pass
    else:
        raise InvalidImageUrlError("must use a host name, not an IP address")
    labels = host.split(".")
    if len(labels) < 2 or not all(_HOST_LABEL.match(label) for label in labels):
        raise InvalidImageUrlError("invalid host name")
    if labels[-1].isdigit():
        raise InvalidImageUrlError("invalid host name")
    if host == "localhost" or host.endswith(_FORBIDDEN_SUFFIXES):
        raise InvalidImageUrlError("must be a public host")
