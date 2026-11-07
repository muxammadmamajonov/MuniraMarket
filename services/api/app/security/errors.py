"""Errors shared by the security stores."""


class StoreUnavailableError(Exception):
    """The backing store (PostgreSQL) failed. Callers fail closed with 503."""
