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
# A label a WHATWG URL parser reads as an IPv4 number part: decimal, or ``0x`` hex (``0x`` alone
# is 0). Octal (leading ``0``) is decimal-looking and caught by the same pattern.
_NUMERIC_LABEL = re.compile(r"^(0[xX][0-9a-fA-F]*|[0-9]+)$")
_HEX_LABEL = re.compile(r"^0[xX][0-9a-fA-F]*$")
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
    _check_host(parts.hostname or "")
    return raw


def _check_host(hostname: str) -> None:
    # One trailing dot (a fully qualified name) is dropped, as a URL parser does; any other
    # empty label is invalid below.
    host = hostname.removesuffix(".")
    if not host:
        raise InvalidImageUrlError("missing host")
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        pass
    else:
        raise InvalidImageUrlError("must use a host name, not an IP address")
    labels = host.split(".")
    # WHATWG "ends in a number": a browser parses such a host as IPv4 (``127.0.0.0x1``,
    # ``0x7f.1``, ``2130706433``), so it is an IP address in disguise. A hex label anywhere is
    # refused too (``0x7f.example.com`` is no real host name).
    if _NUMERIC_LABEL.match(labels[-1]) or any(_HEX_LABEL.match(label) for label in labels):
        raise InvalidImageUrlError("must use a host name, not an IP address")
    if len(labels) < 2 or not all(_HOST_LABEL.match(label) for label in labels):
        raise InvalidImageUrlError("invalid host name")
    if host == "localhost" or host.endswith(_FORBIDDEN_SUFFIXES):
        raise InvalidImageUrlError("must be a public host")
