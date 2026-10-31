"""Catalog CSV import/export: pure parsing, validation, planning and rendering (no database).

Format (template, export and import share it):

- UTF-8, written with a byte-order mark and CRLF line endings; on import the BOM is optional.
- Exactly the columns in :data:`COLUMNS` (export and template use this order; an import may
  order them differently, but every column must be present exactly once and nothing else).
- RFC 4180 quoting (``"`` doubled inside quoted fields), parsed with the ``csv`` module in
  strict mode, so a stray quote is an error instead of a silently merged field.

Spreadsheet formula injection: a text cell beginning with ``= + - @ \\t \\r`` would be evaluated
by Excel/LibreOffice when an exported file is opened. Export prefixes such cells (and cells that
already begin with ``'``) with ``'``; import strips exactly one such ``'`` again, so export ->
import round-trips unchanged. An *unescaped* imported text cell beginning with ``= + @ \\t \\r``
is refused (``formula_not_allowed``); a leading ``-`` is ordinary text (``-20% chegirma``).

Importing is "validate everything, then write everything or nothing": :func:`parse_catalog_csv`
checks each row on its own, :func:`plan_import` checks the rows against the current catalog (a
:class:`CatalogSnapshot` the repository loads under row locks) and decides, per SKU, whether it
is a create, an update or unchanged. Only a plan without errors is applied.
"""

import csv
import io
import re
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final, Literal, cast

from app.domain.image_url import InvalidImageUrlError, validate_image_url
from app.models.enums import Unit

COLUMNS: Final = (
    "sku",
    "slug",
    "category_slug",
    "name_uz",
    "name_ru",
    "description_uz",
    "description_ru",
    "unit",
    "price_uzs",
    "old_price_uzs",
    "stock_quantity",
    "is_active",
    "sort_order",
    "image_url",
)
Column = Literal[
    "sku",
    "slug",
    "category_slug",
    "name_uz",
    "name_ru",
    "description_uz",
    "description_ru",
    "unit",
    "price_uzs",
    "old_price_uzs",
    "stock_quantity",
    "is_active",
    "sort_order",
    "image_url",
]

MAX_ROWS: Final = 2000
MAX_ERRORS: Final = 200
MAX_NAME_LENGTH: Final = 255
MAX_DESCRIPTION_LENGTH: Final = 5000
MAX_SLUG_LENGTH: Final = 128
MAX_PRICE_UZS: Final = 10**12
MAX_STOCK: Final = 1_000_000
MIN_SORT_ORDER: Final = -100_000
MAX_SORT_ORDER: Final = 100_000
# Longest unknown header name echoed back in an error.
_MAX_ECHO: Final = 64

BOM: Final = "﻿"
SKU_PATTERN: Final = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
SLUG_PATTERN: Final = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_MONEY = re.compile(r"^[0-9]{1,13}$")
_STOCK = re.compile(r"^[0-9]{1,7}$")
_SORT = re.compile(r"^-?[0-9]{1,6}$")
_TRUE = frozenset({"true", "1"})
_FALSE = frozenset({"false", "0"})

# Characters that start a spreadsheet formula. ``-`` is escaped on export but is plain text on
# import; ``'`` is escaped on export so a value that really starts with ``'`` survives.
EXPORT_ESCAPE_TRIGGERS: Final = frozenset("=+-@\t\r'")
IMPORT_FORMULA_START: Final = frozenset("=+@\t\r")
# Control characters: names allow none; descriptions allow ``\n`` and ``\t``.
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_CONTROL_MULTILINE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
# UTF-8 text decoded as Latin-1 / Windows-1252 (Cyrillic "Привет" read that way starts with
# U+00D0 U+0178): a lead character (U+00C2/C3/D0/D1) followed by a character that a UTF-8
# continuation byte becomes, or the U+00E2 U+20AC pair of garbled punctuation. Uzbek (Latin or
# Cyrillic) and Russian text never contains these pairs.
_MOJIBAKE = re.compile(
    r"[\u00c2\u00c3\u00d0\u00d1]"
    r"[\u0080-\u00bf\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc"
    r"\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]"
    r"|\u00e2\u20ac"
)

RowErrorCode = Literal[
    "required",
    "invalid_sku",
    "duplicate_sku",
    "invalid_slug",
    "slug_taken",
    "category_not_found",
    "invalid_money",
    "invalid_old_price",
    "invalid_stock",
    "invalid_unit",
    "invalid_bool",
    "invalid_sort_order",
    "invalid_text",
    "formula_not_allowed",
    "invalid_image_url",
    "product_archived",
]
FileErrorCode = Literal[
    "csv_invalid_encoding", "csv_invalid_header", "csv_malformed", "csv_too_many_rows"
]


# --- errors ---------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CsvRowError:
    """``row`` is the 1-based data row (the header is row 0)."""

    row: int
    column: Column | None
    code: RowErrorCode
    message: str


class CsvFileError(Exception):
    """The file as a whole is unusable; nothing is validated row by row."""

    def __init__(
        self, code: FileErrorCode, message: str, details: Sequence[tuple[str, str]] = ()
    ) -> None:
        super().__init__(message)
        self.code: FileErrorCode = code
        self.message = message
        # ``(location, message)`` pairs, e.g. ``("missing", "price_uzs")``.
        self.details = tuple(details)


class _CellError(Exception):
    def __init__(self, code: RowErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: RowErrorCode = code
        self.message = message


# --- parsed rows ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CsvRow:
    row: int
    sku: str
    # ``None``: keep the existing product's slug, or derive one from the SKU for a new product.
    slug: str | None
    category_slug: str
    name_uz: str
    name_ru: str
    description_uz: str | None
    description_ru: str | None
    unit: Unit
    price_uzs: int
    old_price_uzs: int | None
    stock_quantity: int | None
    is_active: bool
    sort_order: int
    image_url: str | None


@dataclass(frozen=True, slots=True)
class ParsedCsv:
    rows: tuple[CsvRow, ...]
    errors: tuple[CsvRowError, ...]
    total_rows: int


class _StrictDialect(csv.Dialect):
    delimiter = ","
    quotechar = '"'
    escapechar = None
    doublequote = True
    skipinitialspace = False
    lineterminator = "\r\n"
    quoting = csv.QUOTE_MINIMAL
    strict = True


def decode_csv(raw: bytes) -> str:
    """UTF-8 text without the BOM. Refuses other encodings and NUL bytes."""
    if b"\x00" in raw:
        raise CsvFileError("csv_invalid_encoding", "The file contains NUL bytes")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise CsvFileError(
            "csv_invalid_encoding", "The file is not UTF-8 (save it as 'CSV UTF-8')"
        ) from None
    return text.removeprefix(BOM)


def _echo(name: str) -> str:
    """A header name safe to show back: printable and short."""
    cleaned = "".join(ch if ch.isprintable() else "?" for ch in name)
    return cleaned if len(cleaned) <= _MAX_ECHO else cleaned[: _MAX_ECHO - 1] + "…"


def _check_header(header: Sequence[str]) -> dict[str, int]:
    names = [name.strip() for name in header]
    details: list[tuple[str, str]] = []
    seen: set[str] = set()
    for name in names:
        if name in seen:
            details.append(("duplicate", _echo(name)))
        seen.add(name)
    details += [("missing", column) for column in COLUMNS if column not in seen]
    details += [("unknown", _echo(name)) for name in names if name not in COLUMNS]
    if details:
        raise CsvFileError(
            "csv_invalid_header",
            "The header must be exactly: " + ",".join(COLUMNS),
            details,
        )
    return {name: index for index, name in enumerate(names)}


def _records(text: str) -> Iterable[list[str]]:
    reader = csv.reader(io.StringIO(text, newline=""), dialect=_StrictDialect)
    try:
        yield from reader
    except csv.Error:
        raise CsvFileError("csv_malformed", f"Malformed CSV near line {reader.line_num}") from None


def parse_catalog_csv(raw: bytes) -> ParsedCsv:
    """Decode, check the header and validate every data row on its own.

    Raises :class:`CsvFileError` for file-level problems. Row problems are returned (all of
    them; the caller caps how many it shows) and such rows are left out of ``rows``.
    """
    records = iter(_records(decode_csv(raw)))
    header = next((record for record in records if record), None)
    if header is None:
        raise CsvFileError(
            "csv_invalid_header",
            "The file is empty; the header must be: " + ",".join(COLUMNS),
            [("missing", column) for column in COLUMNS],
        )
    positions = _check_header(header)
    rows: list[CsvRow] = []
    errors: list[CsvRowError] = []
    seen_skus: set[str] = set()
    total = 0
    for record in records:
        if not record or record == [""]:
            continue  # blank line
        total += 1
        if total > MAX_ROWS:
            raise CsvFileError("csv_too_many_rows", f"At most {MAX_ROWS} product rows per file")
        if len(record) != len(COLUMNS):
            raise CsvFileError(
                "csv_malformed",
                f"Row {total} has {len(record)} fields, expected {len(COLUMNS)}",
            )
        cells = {column: record[positions[column]] for column in COLUMNS}
        parsed, row_errors = _parse_row(total, cells)
        raw_sku = cells["sku"].strip()
        if raw_sku and raw_sku in seen_skus:
            row_errors.append(
                CsvRowError(total, "sku", "duplicate_sku", "SKU appears more than once")
            )
            parsed = None
        seen_skus.add(raw_sku)
        errors += row_errors
        if parsed is not None:
            rows.append(parsed)
    return ParsedCsv(rows=tuple(rows), errors=tuple(errors), total_rows=total)


# --- cell parsers ---------------------------------------------------------------------------------


def _text(raw: str, *, multiline: bool, max_length: int) -> str:
    """Un-escape one exported ``'``, refuse formulas and unusable text, trim."""
    escaped = raw[:1] == "'" and raw[1:2] in EXPORT_ESCAPE_TRIGGERS
    if not escaped and raw[:1] in IMPORT_FORMULA_START:
        raise _CellError(
            "formula_not_allowed",
            "Text must not start with = + @ or a tab/return (prefix it with ' to keep it)",
        )
    value = raw[1:] if escaped else raw
    if multiline:
        value = value.replace("\r\n", "\n")
    control = _CONTROL_MULTILINE if multiline else _CONTROL
    if control.search(value):
        raise _CellError("invalid_text", "Contains control characters")
    if "\ufffd" in value:
        raise _CellError("invalid_text", "Contains U+FFFD (the file was not saved as UTF-8)")
    if _MOJIBAKE.search(value):
        raise _CellError("invalid_text", "Looks garbled (the file was not saved as UTF-8)")
    value = value.strip()
    if len(value) > max_length:
        raise _CellError("invalid_text", f"At most {max_length} characters")
    # " =1" would become "=1" once trimmed. An escaped cell is text by the user's choice.
    if not escaped and value[:1] in IMPORT_FORMULA_START:
        raise _CellError("formula_not_allowed", "Text must not start with = + @")
    return value


def _name(raw: str) -> str:
    value = _text(raw, multiline=False, max_length=MAX_NAME_LENGTH)
    if not value:
        raise _CellError("required", "Required")
    return value


def _description(raw: str) -> str | None:
    return _text(raw, multiline=True, max_length=MAX_DESCRIPTION_LENGTH) or None


def _sku(raw: str) -> str:
    value = raw.strip()
    if not value:
        raise _CellError("required", "Required")
    if not SKU_PATTERN.fullmatch(value):
        raise _CellError("invalid_sku", "1-64 of A-Z a-z 0-9 . _ - starting with a letter/digit")
    return value


def _slug(raw: str, *, required: bool = False) -> str | None:
    value = raw.strip()
    if not value:
        if required:
            raise _CellError("required", "Required")
        return None
    if len(value) > MAX_SLUG_LENGTH or not SLUG_PATTERN.fullmatch(value):
        raise _CellError("invalid_slug", "Lower-case words of a-z 0-9 joined by -")
    return value


def _money(raw: str, *, required: bool) -> int | None:
    value = raw.strip()
    if not value:
        if required:
            raise _CellError("required", "Required")
        return None
    if not _MONEY.fullmatch(value) or int(value) > MAX_PRICE_UZS:
        raise _CellError("invalid_money", "Whole UZS: digits only, at most 10^12")
    return int(value)


def _stock(raw: str) -> int | None:
    value = raw.strip()
    if not value:
        return None
    if not _STOCK.fullmatch(value) or int(value) > MAX_STOCK:
        raise _CellError("invalid_stock", f"Empty (not tracked) or 0..{MAX_STOCK}")
    return int(value)


def _unit(raw: str) -> Unit:
    value = raw.strip()
    if not value:
        raise _CellError("required", "Required")
    try:
        return Unit(value.lower())
    except ValueError:
        raise _CellError(
            "invalid_unit", "One of: " + ", ".join(unit.value for unit in Unit)
        ) from None


def _bool(raw: str) -> bool:
    value = raw.strip().lower()
    if not value:
        raise _CellError("required", "Required")
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    raise _CellError("invalid_bool", "true, false, 1 or 0")


def _sort_order(raw: str) -> int:
    value = raw.strip()
    if not value:
        return 0
    if not _SORT.fullmatch(value) or not MIN_SORT_ORDER <= int(value) <= MAX_SORT_ORDER:
        raise _CellError("invalid_sort_order", f"Whole number {MIN_SORT_ORDER}..{MAX_SORT_ORDER}")
    return int(value)


def _image_url(raw: str) -> str | None:
    value = raw.strip()
    if not value:
        return None
    try:
        return validate_image_url(value)
    except InvalidImageUrlError as exc:
        raise _CellError("invalid_image_url", f"Image URL {exc}") from None


_PARSERS: Final[Mapping[Column, Callable[[str], object]]] = {
    "sku": _sku,
    "slug": _slug,
    "category_slug": lambda raw: _slug(raw, required=True),
    "name_uz": _name,
    "name_ru": _name,
    "description_uz": _description,
    "description_ru": _description,
    "unit": _unit,
    "price_uzs": lambda raw: _money(raw, required=True),
    "old_price_uzs": lambda raw: _money(raw, required=False),
    "stock_quantity": _stock,
    "is_active": _bool,
    "sort_order": _sort_order,
    "image_url": _image_url,
}


def _parse_row(row: int, cells: Mapping[str, str]) -> tuple[CsvRow | None, list[CsvRowError]]:
    errors: list[CsvRowError] = []
    values: dict[str, object] = {}
    for column, parse in _PARSERS.items():
        try:
            values[column] = parse(cells[column])
        except _CellError as exc:
            errors.append(CsvRowError(row, column, exc.code, exc.message))
    if errors:
        return None, errors
    price = cast("int", values["price_uzs"])
    old_price = cast("int | None", values["old_price_uzs"])
    if old_price is not None and old_price <= price:
        return None, [
            CsvRowError(row, "old_price_uzs", "invalid_old_price", "Must be above price_uzs")
        ]
    return (
        CsvRow(
            row=row,
            sku=cast("str", values["sku"]),
            slug=cast("str | None", values["slug"]),
            category_slug=cast("str", values["category_slug"]),
            name_uz=cast("str", values["name_uz"]),
            name_ru=cast("str", values["name_ru"]),
            description_uz=cast("str | None", values["description_uz"]),
            description_ru=cast("str | None", values["description_ru"]),
            unit=cast("Unit", values["unit"]),
            price_uzs=price,
            old_price_uzs=old_price,
            stock_quantity=cast("int | None", values["stock_quantity"]),
            is_active=cast("bool", values["is_active"]),
            sort_order=cast("int", values["sort_order"]),
            image_url=cast("str | None", values["image_url"]),
        ),
        [],
    )


# --- planning against the current catalog ---------------------------------------------------------

# Product fields an import sets (``slug`` only when given or derived).
PRODUCT_FIELDS: Final = (
    "slug",
    "category_id",
    "name_uz",
    "name_ru",
    "description_uz",
    "description_ru",
    "unit",
    "price_uzs",
    "old_price_uzs",
    "stock_quantity",
    "is_active",
    "sort_order",
    "image_url",
)


@dataclass(frozen=True, slots=True)
class ExistingProduct:
    id: uuid.UUID
    sku: str
    archived: bool
    # Current values of every field in ``PRODUCT_FIELDS``.
    values: Mapping[str, object]


@dataclass(frozen=True, slots=True)
class CatalogSnapshot:
    products_by_sku: Mapping[str, ExistingProduct]
    # Owner SKU of every slug the file uses (including archived products: slugs stay taken).
    slug_owners: Mapping[str, str]
    category_ids: Mapping[str, uuid.UUID]


ChangeKind = Literal["create", "update", "unchanged"]


@dataclass(frozen=True, slots=True)
class PlannedChange:
    kind: ChangeKind
    row: int
    sku: str
    product_id: uuid.UUID | None
    # Target values for ``PRODUCT_FIELDS`` (create: all of them).
    values: Mapping[str, object]
    # ``{field: (before, after)}``; for a create, ``before`` is ``None``.
    changes: Mapping[str, tuple[object, object]]


@dataclass(frozen=True, slots=True)
class ImportPlan:
    changes: tuple[PlannedChange, ...]
    errors: tuple[CsvRowError, ...] = field(default=())

    def count(self, kind: ChangeKind) -> int:
        return sum(1 for change in self.changes if change.kind == kind)


def derive_slug(sku: str) -> str | None:
    """``DEMO_0001.a`` -> ``demo-0001-a``; ``None`` if nothing usable remains."""
    slug = re.sub(r"[^a-z0-9]+", "-", sku.lower()).strip("-")
    return slug if slug and SLUG_PATTERN.fullmatch(slug) else None


def referenced_slugs(rows: Iterable[CsvRow]) -> set[str]:
    """Every product slug the file may assign (given or derived), for the snapshot query."""
    slugs: set[str] = set()
    for row in rows:
        candidate = row.slug or derive_slug(row.sku)
        if candidate is not None:
            slugs.add(candidate)
    return slugs


def plan_import(rows: Sequence[CsvRow], snapshot: CatalogSnapshot) -> ImportPlan:
    """Check the rows against the catalog and classify each SKU. Pure: writes nothing."""
    errors: list[CsvRowError] = []
    changes: list[PlannedChange] = []
    claimed: dict[str, str] = {}  # slug -> SKU claiming it within this file
    for row in rows:
        existing = snapshot.products_by_sku.get(row.sku)
        row_errors: list[CsvRowError] = []
        if existing is not None and existing.archived:
            row_errors.append(
                CsvRowError(row.row, "sku", "product_archived", "Restore the product first")
            )
        category_id = snapshot.category_ids.get(row.category_slug)
        if category_id is None:
            row_errors.append(
                CsvRowError(row.row, "category_slug", "category_not_found", "Unknown category")
            )

        slug = row.slug
        if slug is None and existing is None:
            slug = derive_slug(row.sku)
            if slug is None:
                row_errors.append(
                    CsvRowError(row.row, "slug", "invalid_slug", "Cannot derive a slug; set one")
                )
        if slug is not None:
            owner = snapshot.slug_owners.get(slug)
            if (owner is not None and owner != row.sku) or claimed.get(slug, row.sku) != row.sku:
                row_errors.append(
                    CsvRowError(row.row, "slug", "slug_taken", "Slug is used by another product")
                )
            else:
                claimed[slug] = row.sku
        if row_errors:
            errors += row_errors
            continue

        target: dict[str, object] = {
            "category_id": category_id,
            "name_uz": row.name_uz,
            "name_ru": row.name_ru,
            "description_uz": row.description_uz,
            "description_ru": row.description_ru,
            "unit": row.unit,
            "price_uzs": row.price_uzs,
            "old_price_uzs": row.old_price_uzs,
            "stock_quantity": row.stock_quantity,
            "is_active": row.is_active,
            "sort_order": row.sort_order,
            "image_url": row.image_url,
        }
        if slug is not None:
            target["slug"] = slug
        if existing is None:
            changes.append(
                PlannedChange(
                    kind="create",
                    row=row.row,
                    sku=row.sku,
                    product_id=None,
                    values=target,
                    changes={name: (None, value) for name, value in target.items()},
                )
            )
            continue
        diff = {
            name: (existing.values.get(name), value)
            for name, value in target.items()
            if existing.values.get(name) != value
        }
        changes.append(
            PlannedChange(
                kind="update" if diff else "unchanged",
                row=row.row,
                sku=row.sku,
                product_id=existing.id,
                values=target,
                changes=diff,
            )
        )
    return ImportPlan(changes=tuple(changes), errors=tuple(errors))


# --- export ---------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ExportRow:
    sku: str
    slug: str
    category_slug: str
    name_uz: str
    name_ru: str
    description_uz: str | None
    description_ru: str | None
    unit: Unit
    price_uzs: int
    old_price_uzs: int | None
    stock_quantity: int | None
    is_active: bool
    sort_order: int
    image_url: str | None


def escape_cell(value: str) -> str:
    """Neutralise a text cell a spreadsheet would treat as a formula (see the module docs)."""
    return "'" + value if value[:1] in EXPORT_ESCAPE_TRIGGERS else value


def _cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Unit):
        return value.value
    if isinstance(value, int):
        return str(value)
    return escape_cell(str(value))


def render_csv(rows: Iterable[ExportRow]) -> bytes:
    """UTF-8 with BOM, CRLF, header first. Every text cell is formula-escaped."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, dialect=_StrictDialect)
    writer.writerow(COLUMNS)
    for row in rows:
        writer.writerow([_cell(getattr(row, column)) for column in COLUMNS])
    return (BOM + buffer.getvalue()).encode("utf-8")


def render_template() -> bytes:
    """The header only (an example row would be imported if left in by mistake)."""
    return render_csv(())
