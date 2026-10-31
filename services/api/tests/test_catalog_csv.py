"""The catalog CSV format (``app/domain/catalog_csv.py``): parsing, validation, planning, export.

Pure functions only; the database side is in ``tests/test_admin_csv_integration.py``.
"""

import csv
import io
import uuid
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from app.domain.catalog_csv import (
    BOM,
    COLUMNS,
    EXPORT_COLUMNS,
    MAX_ROWS,
    CatalogSnapshot,
    CsvFileError,
    CsvRow,
    ExistingProduct,
    ExportRow,
    derive_slug,
    escape_cell,
    parse_catalog_csv,
    plan_import,
    referenced_slugs,
    render_csv,
    render_template,
)
from app.models.enums import Unit

CATEGORY_ID = uuid.uuid4()
UPDATED_AT = datetime(2026, 10, 31, 7, 15, 30, 123456, tzinfo=UTC)
UPDATED_AT_CELL = "2026-10-31T07:15:30.123456+00:00"


def row(**overrides: str) -> dict[str, str]:
    values = {
        "sku": "DEMO-0001",
        "slug": "demo-olma",
        "category_slug": "mevalar",
        "name_uz": "Demo olma",
        "name_ru": "Демо яблоко",
        "description_uz": "",
        "description_ru": "",
        "unit": "kg",
        "price_uzs": "12000",
        "old_price_uzs": "",
        "stock_quantity": "",
        "is_active": "true",
        "sort_order": "0",
        "image_url": "",
    }
    values.update(overrides)
    return values


def to_csv(
    rows: Sequence[Mapping[str, str]],
    *,
    header: list[str] | None = None,
    bom: bool = True,
    newline: str = "\r\n",
) -> bytes:
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator=newline)
    columns = header or list(COLUMNS)
    writer.writerow(columns)
    for values in rows:
        writer.writerow([values.get(column, "") for column in columns])
    return ((BOM if bom else "") + buffer.getvalue()).encode("utf-8")


def single_error(raw: bytes) -> tuple[str | None, str]:
    parsed = parse_catalog_csv(raw)
    assert parsed.rows == ()
    assert len(parsed.errors) == 1, parsed.errors
    error = parsed.errors[0]
    assert error.row == 1
    return error.column, error.code


def file_error(raw: bytes) -> CsvFileError:
    with pytest.raises(CsvFileError) as caught:
        parse_catalog_csv(raw)
    return caught.value


# --- happy path, encodings, line endings ---------------------------------------------------------


def test_parses_a_valid_row() -> None:
    parsed = parse_catalog_csv(
        to_csv(
            [
                row(
                    description_uz="Birinchi qator\nIkkinchi\tqator",
                    old_price_uzs="15000",
                    stock_quantity="7",
                    is_active="FALSE",
                    sort_order="-5",
                    image_url="https://cdn.example.com/olma.webp",
                    unit="KG",
                )
            ]
        )
    )
    assert parsed.errors == ()
    assert parsed.total_rows == 1
    assert parsed.rows == (
        CsvRow(
            row=1,
            sku="DEMO-0001",
            slug="demo-olma",
            category_slug="mevalar",
            name_uz="Demo olma",
            name_ru="Демо яблоко",
            description_uz="Birinchi qator\nIkkinchi\tqator",
            description_ru=None,
            unit=Unit.KG,
            price_uzs=12_000,
            old_price_uzs=15_000,
            stock_quantity=7,
            is_active=False,
            sort_order=-5,
            image_url="https://cdn.example.com/olma.webp",
        ),
    )


@pytest.mark.parametrize("bom", [True, False])
@pytest.mark.parametrize("newline", ["\r\n", "\n"])
def test_bom_is_optional_and_any_line_ending_works(bom: bool, newline: str) -> None:
    parsed = parse_catalog_csv(
        to_csv([row(), row(sku="DEMO-0002", slug="demo-nok")], bom=bom, newline=newline)
    )
    assert parsed.errors == ()
    assert [parsed_row.sku for parsed_row in parsed.rows] == ["DEMO-0001", "DEMO-0002"]


def test_crlf_inside_a_quoted_description_becomes_a_newline() -> None:
    parsed = parse_catalog_csv(to_csv([row(description_ru="яблоко\r\n яблоко")]))
    assert parsed.rows[0].description_ru == "яблоко\n яблоко"


def test_columns_may_come_in_any_order_and_blank_lines_are_skipped() -> None:
    header = list(reversed(COLUMNS))
    raw = to_csv([row()], header=header) + b"\r\n\r\n"
    parsed = parse_catalog_csv(raw)
    assert parsed.errors == ()
    assert parsed.total_rows == 1


def test_header_names_are_trimmed() -> None:
    header = ",".join(f" {column} " for column in COLUMNS)
    body = to_csv([row()], bom=False).split(b"\r\n", 1)[1]
    parsed = parse_catalog_csv(header.encode() + b"\r\n" + body)
    assert parsed.errors == ()
    assert parsed.total_rows == 1


# --- file-level errors ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw",
    [
        "sku,name\nDEMO,Olma\n".encode("cp1251") + "Яблоко".encode("cp1251"),
        b"\xff\xfe" + "sku".encode("utf-16-le"),
        b"sku,slug\n\xc3\x28",
    ],
)
def test_not_utf8_is_csv_invalid_encoding(raw: bytes) -> None:
    assert file_error(raw).code == "csv_invalid_encoding"


def test_nul_bytes_are_refused() -> None:
    raw = to_csv([row(name_uz="Demo\x00olma")])
    assert file_error(raw).code == "csv_invalid_encoding"


def test_missing_unknown_and_duplicate_columns_are_listed() -> None:
    header = [column for column in COLUMNS if column != "price_uzs"] + ["brand", "sku"]
    error = file_error(to_csv([], header=header))
    assert error.code == "csv_invalid_header"
    assert set(error.details) == {
        ("missing", "price_uzs"),
        ("unknown", "brand"),
        ("duplicate", "sku"),
    }


@pytest.mark.parametrize("raw", [b"", BOM.encode(), b"\r\n\r\n"])
def test_empty_file_is_an_invalid_header(raw: bytes) -> None:
    error = file_error(raw)
    assert error.code == "csv_invalid_header"
    assert ("missing", "sku") in error.details


@pytest.mark.parametrize(
    "line",
    [
        'DEMO-1,"demo,1',  # unterminated quote
        'DEMO-1,"de"mo,x',  # text after a closing quote
    ],
)
def test_strict_quoting_errors_are_csv_malformed(line: str) -> None:
    raw = (",".join(COLUMNS) + "\r\n" + line + "\r\n").encode()
    assert file_error(raw).code == "csv_malformed"


def test_wrong_number_of_fields_is_csv_malformed() -> None:
    raw = (",".join(COLUMNS) + "\r\nDEMO-1,demo-1\r\n").encode()
    error = file_error(raw)
    assert error.code == "csv_malformed"
    assert "Row 1" in error.message


def test_2000_rows_are_fine_2001_are_too_many() -> None:
    rows = [row(sku=f"DEMO-{i:05d}", slug=f"demo-{i}") for i in range(MAX_ROWS)]
    assert parse_catalog_csv(to_csv(rows)).total_rows == MAX_ROWS
    rows.append(row(sku="DEMO-LAST", slug="demo-last"))
    assert file_error(to_csv(rows)).code == "csv_too_many_rows"


# --- per-row errors -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "column", "code"),
    [
        ({"sku": ""}, "sku", "required"),
        ({"sku": "-DEMO"}, "sku", "invalid_sku"),
        ({"sku": "DEMO 1"}, "sku", "invalid_sku"),
        ({"sku": "D" * 65}, "sku", "invalid_sku"),
        ({"slug": "Demo-Olma"}, "slug", "invalid_slug"),
        ({"slug": "demo--olma"}, "slug", "invalid_slug"),
        ({"slug": "a" * 129}, "slug", "invalid_slug"),
        ({"category_slug": ""}, "category_slug", "required"),
        ({"category_slug": "Mevalar!"}, "category_slug", "invalid_slug"),
        ({"name_uz": ""}, "name_uz", "required"),
        ({"name_ru": "   "}, "name_ru", "required"),
        ({"name_uz": "x" * 256}, "name_uz", "invalid_text"),
        ({"name_uz": "Ikki\nqator"}, "name_uz", "invalid_text"),
        ({"name_uz": "Demo\x07"}, "name_uz", "invalid_text"),
        ({"description_uz": "x" * 5001}, "description_uz", "invalid_text"),
        ({"description_uz": "bad\x1bescape"}, "description_uz", "invalid_text"),
        ({"name_ru": "Ð¯Ð±Ð»Ð¾ÐºÐ¾"}, "name_ru", "invalid_text"),
        ({"name_uz": "Ã¼zum"}, "name_uz", "invalid_text"),
        ({"description_ru": "Itâ€™s"}, "description_ru", "invalid_text"),
        ({"name_ru": "Ябл�ко"}, "name_ru", "invalid_text"),
        ({"name_uz": "Olma\u202egnp.exe"}, "name_uz", "invalid_text"),
        ({"name_ru": "Ol\u200bma"}, "name_ru", "invalid_text"),
        ({"name_uz": "\ufeffOlma"}, "name_uz", "invalid_text"),
        ({"name_uz": "Olma\u2066x\u2069"}, "name_uz", "invalid_text"),
        ({"name_uz": "Olma\u2028nok"}, "name_uz", "invalid_text"),
        ({"name_uz": "Olma\u3164"}, "name_uz", "invalid_text"),
        ({"description_uz": "Shirin\n\u202eolma"}, "description_uz", "invalid_text"),
        ({"description_ru": "Shirin\u00adolma"}, "description_ru", "invalid_text"),
        ({"unit": ""}, "unit", "required"),
        ({"unit": "box"}, "unit", "invalid_unit"),
        ({"price_uzs": ""}, "price_uzs", "required"),
        ({"price_uzs": "12000.50"}, "price_uzs", "invalid_money"),
        ({"price_uzs": "12 000"}, "price_uzs", "invalid_money"),
        ({"price_uzs": "-1"}, "price_uzs", "invalid_money"),
        ({"price_uzs": "+1"}, "price_uzs", "invalid_money"),
        ({"price_uzs": "1000000000001"}, "price_uzs", "invalid_money"),
        ({"price_uzs": "١٢"}, "price_uzs", "invalid_money"),
        ({"old_price_uzs": "1e5"}, "old_price_uzs", "invalid_money"),
        ({"old_price_uzs": "12000"}, "old_price_uzs", "invalid_old_price"),
        ({"old_price_uzs": "100"}, "old_price_uzs", "invalid_old_price"),
        ({"stock_quantity": "-1"}, "stock_quantity", "invalid_stock"),
        ({"stock_quantity": "1000001"}, "stock_quantity", "invalid_stock"),
        ({"stock_quantity": "2.5"}, "stock_quantity", "invalid_stock"),
        ({"is_active": ""}, "is_active", "required"),
        ({"is_active": "yes"}, "is_active", "invalid_bool"),
        ({"sort_order": "100001"}, "sort_order", "invalid_sort_order"),
        ({"sort_order": "1.5"}, "sort_order", "invalid_sort_order"),
        ({"image_url": "http://cdn.example.com/a.png"}, "image_url", "invalid_image_url"),
        ({"image_url": "https://127.0.0.1/a.png"}, "image_url", "invalid_image_url"),
        ({"image_url": "https://localhost/a.png"}, "image_url", "invalid_image_url"),
        ({"image_url": "https://user:pw@cdn.example.com/a"}, "image_url", "invalid_image_url"),
        ({"image_url": "javascript:alert(1)"}, "image_url", "invalid_image_url"),
    ],
)
def test_row_errors(overrides: dict[str, str], column: str, code: str) -> None:
    assert single_error(to_csv([row(**overrides)])) == (column, code)


@pytest.mark.parametrize(
    "value",
    [
        '=HYPERLINK("https://evil.example","click")',
        "+cmd|' /C calc'!A0",
        "@SUM(1+1)",
        "\t=1",
        "\r=1",
        " =1+2",
    ],
)
@pytest.mark.parametrize("column", ["name_uz", "name_ru", "description_uz", "description_ru"])
def test_formula_injection_is_refused(value: str, column: str) -> None:
    assert single_error(to_csv([row(**{column: value})])) == (column, "formula_not_allowed")


@pytest.mark.parametrize(
    ("cell", "stored"),
    [
        ("'=SUM(1)", "=SUM(1)"),
        ("'+998", "+998"),
        ("'@home", "@home"),
        ("'-2+3", "-2+3"),
        ("''quoted", "'quoted"),
        ("-20% chegirma", "-20% chegirma"),
        ("'plain", "'plain"),
    ],
)
def test_escaped_cells_are_unescaped_once(cell: str, stored: str) -> None:
    parsed = parse_catalog_csv(to_csv([row(name_uz=cell)]))
    assert parsed.errors == ()
    assert parsed.rows[0].name_uz == stored


def test_duplicate_skus_in_one_file() -> None:
    parsed = parse_catalog_csv(to_csv([row(), row(slug="other"), row(slug="third")]))
    assert [(error.row, error.code) for error in parsed.errors] == [
        (2, "duplicate_sku"),
        (3, "duplicate_sku"),
    ]
    assert [parsed_row.row for parsed_row in parsed.rows] == [1]


def test_every_bad_cell_of_a_row_is_reported() -> None:
    parsed = parse_catalog_csv(to_csv([row(price_uzs="x", unit="box", is_active="maybe")]))
    assert {(error.column, error.code) for error in parsed.errors} == {
        ("price_uzs", "invalid_money"),
        ("unit", "invalid_unit"),
        ("is_active", "invalid_bool"),
    }


def test_descriptions_keep_newlines_and_ordinary_unicode() -> None:
    parsed = parse_catalog_csv(
        to_csv([row(name_uz="O'zbek olma — 1 kg 🍎", description_uz="Birinchi\nikkinchi\tqator")])
    )
    assert parsed.errors == ()
    assert parsed.rows[0].name_uz == "O'zbek olma — 1 kg 🍎"
    assert parsed.rows[0].description_uz == "Birinchi\nikkinchi\tqator"


def test_updated_at_is_optional_and_parsed() -> None:
    without = parse_catalog_csv(to_csv([row()]))
    assert without.rows[0].updated_at is None
    header = list(EXPORT_COLUMNS)
    empty = parse_catalog_csv(to_csv([row(updated_at="")], header=header))
    assert empty.rows[0].updated_at is None
    given = parse_catalog_csv(to_csv([row(updated_at=UPDATED_AT_CELL)], header=header))
    assert given.rows[0].updated_at == UPDATED_AT
    # Any column order, like the other columns.
    reordered = parse_catalog_csv(
        to_csv([row(updated_at=UPDATED_AT_CELL)], header=list(reversed(header)))
    )
    assert reordered.rows[0].updated_at == UPDATED_AT


@pytest.mark.parametrize("cell", ["yesterday", "2026-10-31", "2026-10-31T07:15:30", "=NOW()"])
def test_invalid_updated_at(cell: str) -> None:
    raw = to_csv([row(updated_at=cell)], header=list(EXPORT_COLUMNS))
    assert single_error(raw) == ("updated_at", "invalid_updated_at")


def test_updated_at_twice_is_an_invalid_header() -> None:
    error = file_error(to_csv([row()], header=[*EXPORT_COLUMNS, "updated_at"]))
    assert error.code == "csv_invalid_header"
    assert ("duplicate", "updated_at") in error.details


def test_empty_optional_cells() -> None:
    parsed = parse_catalog_csv(to_csv([row(slug="", sort_order="")]))
    [parsed_row] = parsed.rows
    assert parsed_row.slug is None
    assert parsed_row.sort_order == 0
    assert parsed_row.stock_quantity is None
    assert parsed_row.old_price_uzs is None
    assert parsed_row.image_url is None


# --- planning ------------------------------------------------------------------------------------


def parsed_rows(*rows: dict[str, str]) -> tuple[CsvRow, ...]:
    parsed = parse_catalog_csv(to_csv(list(rows)))
    assert parsed.errors == ()
    return parsed.rows


def existing(
    sku: str = "DEMO-0001",
    *,
    archived: bool = False,
    updated_at: datetime = UPDATED_AT,
    **values: Any,
) -> ExistingProduct:
    current: dict[str, object] = {
        "slug": "demo-olma",
        "category_id": CATEGORY_ID,
        "name_uz": "Demo olma",
        "name_ru": "Демо яблоко",
        "description_uz": None,
        "description_ru": None,
        "unit": Unit.KG,
        "price_uzs": 12_000,
        "old_price_uzs": None,
        "stock_quantity": None,
        "is_active": True,
        "sort_order": 0,
        "image_url": None,
    }
    current.update(values)
    return ExistingProduct(
        id=uuid.uuid4(), sku=sku, archived=archived, values=current, updated_at=updated_at
    )


def snapshot(*products: ExistingProduct) -> CatalogSnapshot:
    return CatalogSnapshot(
        products_by_sku={product.sku: product for product in products},
        slug_owners={str(product.values["slug"]): product.sku for product in products},
        category_ids={"mevalar": CATEGORY_ID},
    )


def test_plan_classifies_creates_updates_and_unchanged() -> None:
    rows = parsed_rows(
        row(),
        row(sku="DEMO-0002", slug="demo-nok", price_uzs="9000"),
        row(sku="DEMO-0003", slug=""),
    )
    current = existing()
    changed = existing("DEMO-0002", slug="demo-nok", price_uzs=8_000, stock_quantity=4)
    plan = plan_import(rows, snapshot(current, changed))
    assert plan.errors == ()
    assert [(change.sku, change.kind) for change in plan.changes] == [
        ("DEMO-0001", "unchanged"),
        ("DEMO-0002", "update"),
        ("DEMO-0003", "create"),
    ]
    update = plan.changes[1]
    assert update.product_id == changed.id
    assert update.changes == {"price_uzs": (8_000, 9_000), "stock_quantity": (4, None)}
    create = plan.changes[2]
    assert create.values["slug"] == "demo-0003"
    assert create.changes["price_uzs"] == (None, 12_000)
    assert (plan.count("create"), plan.count("update"), plan.count("unchanged")) == (1, 1, 1)


def test_empty_slug_keeps_the_existing_one() -> None:
    plan = plan_import(parsed_rows(row(slug="")), snapshot(existing()))
    assert plan.changes[0].kind == "unchanged"
    assert "slug" not in plan.changes[0].values


@pytest.mark.parametrize(
    ("rows", "products", "expected"),
    [
        ([row(category_slug="nonexistent")], (), [(1, "category_slug", "category_not_found")]),
        ([row()], (existing(archived=True),), [(1, "sku", "product_archived")]),
        ([row(sku="DEMO-NEW")], (existing(),), [(1, "slug", "slug_taken")]),
        (
            [row(sku="DEMO-A", slug="same"), row(sku="DEMO-B", slug="same")],
            (),
            [(2, "slug", "slug_taken")],
        ),
        (
            [row(sku="DEMO-A", slug=""), row(sku="DEMO-B", slug="demo-a")],
            (),
            [(2, "slug", "slug_taken")],
        ),
    ],
)
def test_plan_errors(
    rows: list[dict[str, str]],
    products: tuple[ExistingProduct, ...],
    expected: list[tuple[int, str, str]],
) -> None:
    plan = plan_import(parsed_rows(*rows), snapshot(*products))
    assert [(error.row, error.column, error.code) for error in plan.errors] == expected


def stamped(*rows: dict[str, str]) -> tuple[CsvRow, ...]:
    parsed = parse_catalog_csv(to_csv(list(rows), header=list(EXPORT_COLUMNS)))
    assert parsed.errors == ()
    return parsed.rows


def test_a_row_exported_before_the_product_changed_is_stale() -> None:
    # Exported at stock 10; an order took one since (the product's updated_at moved on).
    rows = stamped(row(stock_quantity="10", updated_at=UPDATED_AT_CELL))
    changed = existing(stock_quantity=9, updated_at=UPDATED_AT + timedelta(microseconds=1))
    plan = plan_import(rows, snapshot(changed))
    assert [(error.row, error.column, error.code) for error in plan.errors] == [
        (1, "updated_at", "stale_row")
    ]
    assert plan.errors[0].message == (
        "The product changed after this file was exported; export again"
    )
    assert plan.changes == ()


def test_a_current_updated_at_imports_normally() -> None:
    rows = stamped(row(stock_quantity="10", updated_at=UPDATED_AT_CELL))
    # The same instant in another offset is the same instant.
    same = existing(stock_quantity=9, updated_at=UPDATED_AT.astimezone(tz=None))
    plan = plan_import(rows, snapshot(same))
    assert plan.errors == ()
    assert plan.changes[0].changes == {"stock_quantity": (9, 10)}


def test_an_empty_updated_at_overwrites_on_purpose() -> None:
    rows = stamped(row(stock_quantity="10", updated_at=""), row(sku="DEMO-NEW", slug="demo-new"))
    changed = existing(stock_quantity=9, updated_at=UPDATED_AT + timedelta(days=1))
    plan = plan_import(rows, snapshot(changed))
    assert plan.errors == ()
    assert [change.kind for change in plan.changes] == ["update", "create"]


def test_updated_at_for_an_unknown_sku_is_stale() -> None:
    plan = plan_import(stamped(row(sku="DEMO-GONE", updated_at=UPDATED_AT_CELL)), snapshot())
    assert [(error.column, error.code) for error in plan.errors] == [("updated_at", "stale_row")]


def test_derive_slug() -> None:
    assert derive_slug("DEMO_0001.a") == "demo-0001-a"
    assert derive_slug("x--Y") == "x-y"
    assert derive_slug("...") is None


def test_referenced_slugs() -> None:
    assert referenced_slugs(parsed_rows(row(), row(sku="DEMO-9", slug=""))) == {
        "demo-olma",
        "demo-9",
    }


# --- export --------------------------------------------------------------------------------------


def export_row(**overrides: Any) -> ExportRow:
    values: dict[str, Any] = {
        "sku": "DEMO-0001",
        "slug": "demo-olma",
        "category_slug": "mevalar",
        "name_uz": "Demo olma",
        "name_ru": "Демо яблоко",
        "description_uz": None,
        "description_ru": "яблоко\n яблоко",
        "unit": Unit.KG,
        "price_uzs": 12_000,
        "old_price_uzs": 15_000,
        "stock_quantity": 0,
        "is_active": False,
        "sort_order": -3,
        "image_url": "https://cdn.example.com/a.png",
        "updated_at": UPDATED_AT,
    }
    values.update(overrides)
    return ExportRow(**values)


def test_export_format() -> None:
    raw = render_csv([export_row()])
    assert raw.startswith(BOM.encode())
    text = raw.decode("utf-8").removeprefix(BOM)
    assert text.startswith(",".join(f'"{column}"' for column in EXPORT_COLUMNS) + "\r\n")
    assert EXPORT_COLUMNS[-1] == "updated_at"
    assert text.endswith("\r\n")
    assert (
        '"DEMO-0001","demo-olma","mevalar","Demo olma","Демо яблоко","","яблоко\n яблоко","kg",'
        '"12000","15000","0","false","-3","https://cdn.example.com/a.png",'
        '"2026-10-31T07:15:30.123456+00:00"\r\n'
    ) in text


def test_updated_at_is_utc_with_microseconds() -> None:
    whole_second = datetime(2026, 10, 31, 12, 0, tzinfo=UTC).astimezone(tz=None)
    raw = render_csv([export_row(updated_at=whole_second)])
    assert raw.decode("utf-8").endswith('"2026-10-31T12:00:00.000000+00:00"\r\n')
    assert parse_catalog_csv(raw).rows[0].updated_at == whole_second


def test_template_is_the_header_only() -> None:
    header = ",".join(f'"{column}"' for column in EXPORT_COLUMNS)
    assert render_template() == (BOM + header + "\r\n").encode()
    assert parse_catalog_csv(render_template()).total_rows == 0


def split_outside_quotes(line: str, separator: str) -> list[str]:
    """How a spreadsheet splits a line on ``separator``: never inside a quoted stretch (a ``""``
    pair toggles twice, so it stays inside)."""
    pieces: list[str] = []
    current: list[str] = []
    quoted = False
    for character in line:
        if character == '"':
            quoted = not quoted
        if character == separator and not quoted:
            pieces.append("".join(current))
            current = []
        else:
            current.append(character)
    return [*pieces, "".join(current)]


@pytest.mark.parametrize(
    "value",
    ["Olma;=1+1", "Olma,=1+1", "Olma\t=1+1", "Olma;@SUM(1)", 'Olma;"=1";+1', "a;b,c\td"],
)
def test_separators_inside_a_value_never_start_a_cell(value: str) -> None:
    """ru/uz spreadsheets split on ``;`` (or tab): every cell is quoted, so nothing after a
    separator inside a value can become a cell of its own (let alone a formula)."""
    name = value if "\t" not in value else "Demo olma"  # names are a single line, no tabs
    raw = render_csv([export_row(name_ru=name, description_uz=value)])
    data = raw.decode("utf-8").removeprefix(BOM).split("\r\n")[1]
    for separator in (";", "\t", ","):
        cells = split_outside_quotes(data, separator)
        if separator == ",":
            assert len(cells) == len(EXPORT_COLUMNS)
            assert all(cell[:1] == '"' and cell[-1:] == '"' for cell in cells)
        else:
            assert cells == [data]  # the separator never appears outside quotes
    # Without quoting every cell, the same value would have split into a formula cell.
    unquoted = io.StringIO(newline="")
    csv.writer(unquoted, lineterminator="\r\n").writerow(["DEMO-0001", "Olma;=1+1"])
    assert split_outside_quotes(unquoted.getvalue(), ";")[1].startswith("=1+1")
    # And it imports back unchanged.
    parsed = parse_catalog_csv(raw)
    assert parsed.errors == ()
    assert (parsed.rows[0].name_ru, parsed.rows[0].description_uz) == (name, value)


def test_a_fully_quoted_file_imports() -> None:
    header = ",".join(f'"{column}"' for column in COLUMNS)
    cells = [f'"{row()[column]}"' for column in COLUMNS]
    parsed = parse_catalog_csv((BOM + header + "\r\n" + ",".join(cells) + "\r\n").encode())
    assert parsed.errors == ()
    assert parsed.rows[0].sku == "DEMO-0001"
    assert parsed.rows[0].old_price_uzs is None
    assert parsed.rows[0].updated_at is None


@pytest.mark.parametrize(
    ("value", "escaped"),
    [
        ('=HYPERLINK("https://evil.example","x")', '\'=HYPERLINK("https://evil.example","x")'),
        ("+cmd", "'+cmd"),
        ("-2+3", "'-2+3"),
        ("@SUM(1)", "'@SUM(1)"),
        ("\t=1", "'\t=1"),
        ("'quoted", "''quoted"),
        ("Demo", "Demo"),
        ("", ""),
    ],
)
def test_escape_cell(value: str, escaped: str) -> None:
    assert escape_cell(value) == escaped


@pytest.mark.parametrize(
    "name",
    [
        '=HYPERLINK("https://evil.example","click")',
        "+cmd",
        "@SUM(1+1)",
        "-2+3",
        "'quoted",
        "'=already",
        'Oddiy nom, vergul va "qo\'shtirnoq"',
    ],
)
def test_export_then_import_round_trips(name: str) -> None:
    raw = render_csv([export_row(name_uz=name, description_uz=name, description_ru=None)])
    text = raw.decode("utf-8")
    # No cell of the exported file starts like a formula.
    for record in csv.reader(io.StringIO(text.removeprefix(BOM), newline="")):
        for cell in record:
            assert cell[:1] not in {"=", "+", "-", "@", "\t", "\r"} or cell.lstrip("-").isdigit()
    parsed = parse_catalog_csv(raw)
    assert parsed.errors == ()
    [parsed_row] = parsed.rows
    assert parsed_row.name_uz == name
    assert parsed_row.description_uz == name
    assert parsed_row.updated_at == UPDATED_AT
    plan = plan_import(
        parsed.rows,
        CatalogSnapshot(
            products_by_sku={
                "DEMO-0001": existing(
                    name_uz=name,
                    description_uz=name,
                    old_price_uzs=15_000,
                    stock_quantity=0,
                    is_active=False,
                    sort_order=-3,
                    image_url="https://cdn.example.com/a.png",
                )
            },
            slug_owners={"demo-olma": "DEMO-0001"},
            category_ids={"mevalar": CATEGORY_ID},
        ),
    )
    assert [change.kind for change in plan.changes] == ["unchanged"]
