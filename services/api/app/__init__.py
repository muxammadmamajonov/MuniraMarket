"""MuniraMarket Core API."""

from importlib import metadata

try:
    __version__ = metadata.version("muniramarket-core-api")
except metadata.PackageNotFoundError:  # pragma: no cover - running from a bare checkout
    __version__ = "0.0.0"
