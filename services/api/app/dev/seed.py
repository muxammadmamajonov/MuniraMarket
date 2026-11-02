"""Synthetic catalog data for local development and tests: ``python -m app.dev.seed``.

Refuses to run unless ``APP_ENV`` is ``development`` or ``test``. A realistic mock Tashkent grocery
catalog (9 top-level categories, about 45 products in uz and ru, plausible so'm prices) so the demo
looks like a real store, yet everything is made up: the synthetic markers are the ``DEMO-NNNN``
SKUs, the ``demo-`` slugs, invented brand names (``SYNTHETIC_BRANDS``, never a real trademark) and
no image URLs (the web app shows a placeholder; images will live in R2). It is safe to run
repeatedly: rows are upserted by slug and an unchanged row is not touched, so a second run changes
nothing. A demo product an admin has archived is left alone (not reactivated, not updated).

The data deliberately includes the edge cases the catalog and cart must handle: products with an
old price, untracked stock, low stock, out-of-stock products, a very long product name, an inactive
product, an inactive category, and an active category nested under an inactive one (which must
stay hidden).

Delivery zones (``Demo``/``Демо`` names, round fees, Asia/Tashkent hours) cover Tashkent's
districts: a zone with a free-delivery threshold, one with a higher minimum order, one where
delivery is never free, and an inactive zone whose districts are therefore not served.

Delivery slots exist for ``demo-chekka`` only (``SLOT_ZONE_SLUG``): two windows a day for the next
``SLOT_DAYS`` local days from the day the seed runs, with the cutoff two hours before each start.
A zone with slots requires one at checkout, so the zone the storefront E2E checkout uses
(``demo-markaziy``, district ``yunusobod``) deliberately has none and keeps the slot-less flow;
choose a ``demo-chekka`` district (e.g. ``chilonzor``) to try slots. Slots are upserted by
``(zone, date, start)``: a re-run on the same day writes nothing, a run on a later day adds the
new days, and ``reserved_count`` is never touched (capacity never drops below it).
"""

# Uzbek Latin is written with U+2018/U+2019 apostrophes (as in the storefront); ruff flags them.
# ruff: noqa: RUF001, RUF003

import asyncio
import logging
import sys
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.db.session import create_engine, create_session_factory
from app.domain.delivery import DistrictCode, tashkent_date, tashkent_instant
from app.models.catalog import Category, Product
from app.models.delivery import DeliverySlot, DeliveryZone, DeliveryZoneDistrict
from app.models.enums import Unit

logger = logging.getLogger("app.dev.seed")

ALLOWED_ENVIRONMENTS = ("development", "test")


class SeedRefusedError(Exception):
    """Raised when the seed is started outside a development/test environment."""


def ensure_safe_environment(app_env: str) -> None:
    if app_env not in ALLOWED_ENVIRONMENTS:
        raise SeedRefusedError(
            f"refusing to seed demo data when APP_ENV={app_env!r} "
            f"(allowed: {', '.join(ALLOWED_ENVIRONMENTS)})"
        )


@dataclass(frozen=True, slots=True)
class SeedCategory:
    slug: str
    name_uz: str
    name_ru: str
    sort_order: int
    parent_slug: str | None = None
    is_active: bool = True


@dataclass(frozen=True, slots=True)
class SeedProduct:
    sku: str
    slug: str
    category_slug: str
    name_uz: str
    name_ru: str
    description_uz: str
    description_ru: str
    unit: Unit
    price_uzs: int
    old_price_uzs: int | None = None
    # None = stock is not tracked.
    stock_quantity: int | None = None
    brand: str | None = None
    is_active: bool = True


# The only brand names the seed uses: invented, so no real trademark appears in the demo data.
SYNTHETIC_BRANDS: tuple[str, ...] = (
    "Bog‘dan",
    "Toza Dala",
    "Yangi Kun",
    "Oltin Bug‘doy",
    "Sof Chashma",
)

# Parents come before their children.
DEMO_CATEGORIES: tuple[SeedCategory, ...] = (
    SeedCategory("demo-mevalar-sabzavotlar", "Mevalar va sabzavotlar", "Фрукты и овощи", 10),
    SeedCategory("demo-mevalar", "Mevalar", "Фрукты", 10, parent_slug="demo-mevalar-sabzavotlar"),
    SeedCategory(
        "demo-sabzavotlar", "Sabzavotlar", "Овощи", 20, parent_slug="demo-mevalar-sabzavotlar"
    ),
    SeedCategory("demo-non", "Non va pishiriqlar", "Хлеб и выпечка", 20),
    SeedCategory("demo-sut", "Sut mahsulotlari va tuxum", "Молочные продукты и яйца", 30),
    SeedCategory("demo-gosht", "Go‘sht va parranda", "Мясо и птица", 40),
    SeedCategory("demo-bakaleya", "Guruch, un va donlar", "Крупы, мука и бакалея", 50),
    SeedCategory("demo-yog-ziravor", "Yog‘ va ziravorlar", "Масло и специи", 60),
    SeedCategory("demo-ichimliklar", "Ichimliklar", "Напитки", 70),
    SeedCategory("demo-sharbatlar", "Sharbatlar", "Соки", 10, parent_slug="demo-ichimliklar"),
    SeedCategory("demo-choy-shirinlik", "Choy, qahva va shirinliklar", "Чай, кофе и сладости", 80),
    SeedCategory("demo-uy-rozgor", "Uy-ro‘zg‘or mahsulotlari", "Товары для дома", 90),
    # An inactive category hides its whole subtree, including the active child below.
    SeedCategory("demo-arxiv", "Arxiv (nofaol)", "Архив (неактивно)", 99, is_active=False),
    SeedCategory(
        "demo-arxiv-ichki", "Arxiv ichki", "Архив вложенный", 10, parent_slug="demo-arxiv"
    ),
)

# SKUs of the first products stay stable; new ones continue the numbering.
DEMO_PRODUCTS: tuple[SeedProduct, ...] = (
    # --- Mevalar
    SeedProduct(
        "DEMO-0001",
        "demo-olma",
        "demo-mevalar",
        "Qizil olma",
        "Яблоки красные",
        "Mahalliy qizil olma, shirin-nordon. Narxi 1 kg uchun.",
        "Красные яблоки местного урожая, сладко-кислые. Цена за 1 кг.",
        Unit.KG,
        15_000,
        old_price_uzs=18_000,
        stock_quantity=120,
    ),
    SeedProduct(
        "DEMO-0002",
        "demo-banan",
        "demo-mevalar",
        "Banan",
        "Бананы",
        "Pishgan sariq banan. Narxi 1 kg uchun.",
        "Спелые жёлтые бананы. Цена за 1 кг.",
        Unit.KG,
        22_000,
    ),
    SeedProduct(
        "DEMO-0003",
        "demo-uzum",
        "demo-mevalar",
        "Husayni uzumi",
        "Виноград Хусайни",
        "Uzun shirin uzum, mavsumiy. Narxi 1 kg uchun.",
        "Сладкий удлинённый виноград, сезонный. Цена за 1 кг.",
        Unit.KG,
        35_000,
        stock_quantity=40,
    ),
    SeedProduct(
        "DEMO-0015",
        "demo-limon",
        "demo-mevalar",
        "Limon",
        "Лимоны",
        "Choy va taomlar uchun limon. Narxi 1 kg uchun.",
        "Лимоны для чая и блюд. Цена за 1 кг.",
        Unit.KG,
        38_000,
        stock_quantity=25,
    ),
    SeedProduct(
        "DEMO-0016",
        "demo-anor",
        "demo-mevalar",
        "Anor",
        "Гранаты",
        "Kattaligi o‘rtacha anor. Narxi 1 kg uchun.",
        "Гранаты среднего размера. Цена за 1 кг.",
        Unit.KG,
        30_000,
        stock_quantity=2,
    ),
    # Inactive product in an active category.
    SeedProduct(
        "DEMO-0013",
        "demo-eski-mahsulot",
        "demo-mevalar",
        "Olxo‘ri (mavsum tugagan)",
        "Слива (сезон закончился)",
        "Mavsum tugagani uchun sotuvdan olingan.",
        "Снято с продажи: сезон закончился.",
        Unit.PIECE,
        7_000,
        stock_quantity=5,
        is_active=False,
    ),
    # --- Sabzavotlar
    SeedProduct(
        "DEMO-0004",
        "demo-pomidor",
        "demo-sabzavotlar",
        "Pomidor",
        "Помидоры",
        "Yangi uzilgan pomidor. Narxi 1 kg uchun.",
        "Свежие помидоры. Цена за 1 кг.",
        Unit.KG,
        12_000,
        old_price_uzs=14_000,
        stock_quantity=80,
    ),
    SeedProduct(
        "DEMO-0005",
        "demo-bodring",
        "demo-sabzavotlar",
        "Bodring",
        "Огурцы",
        "Salat uchun bodring. Narxi 1 kg uchun.",
        "Огурцы для салата. Цена за 1 кг.",
        Unit.KG,
        10_000,
    ),
    SeedProduct(
        "DEMO-0006",
        "demo-sabzi",
        "demo-sabzavotlar",
        "Sabzi",
        "Морковь",
        "Palov va salat uchun sariq sabzi. Narxi 1 kg uchun.",
        "Жёлтая морковь для плова и салатов. Цена за 1 кг.",
        Unit.KG,
        8_000,
        stock_quantity=200,
    ),
    SeedProduct(
        "DEMO-0017",
        "demo-kartoshka",
        "demo-sabzavotlar",
        "Kartoshka",
        "Картофель",
        "Yuvilgan kartoshka. Narxi 1 kg uchun.",
        "Мытый картофель. Цена за 1 кг.",
        Unit.KG,
        7_000,
        stock_quantity=300,
    ),
    SeedProduct(
        "DEMO-0018",
        "demo-piyoz",
        "demo-sabzavotlar",
        "Sariq piyoz",
        "Лук репчатый",
        "Oddiy sariq piyoz. Narxi 1 kg uchun.",
        "Обычный репчатый лук. Цена за 1 кг.",
        Unit.KG,
        5_000,
    ),
    SeedProduct(
        "DEMO-0019",
        "demo-bolgar-qalampiri",
        "demo-sabzavotlar",
        "Bolgar qalampiri",
        "Болгарский перец",
        "Rangli bolgar qalampiri. Narxi 1 kg uchun.",
        "Разноцветный болгарский перец. Цена за 1 кг.",
        Unit.KG,
        26_000,
        stock_quantity=3,
    ),
    # --- Non va pishiriqlar
    SeedProduct(
        "DEMO-0020",
        "demo-patir",
        "demo-non",
        "Tandir patir",
        "Патыр из тандыра",
        "Tandirda yopilgan patir non, bittasi.",
        "Лепёшка патыр, испечённая в тандыре, 1 шт.",
        Unit.PIECE,
        5_000,
        stock_quantity=30,
    ),
    SeedProduct(
        "DEMO-0021",
        "demo-lavash",
        "demo-non",
        "Lavash (3 dona)",
        "Лаваш (3 шт.)",
        "Yupqa lavash, 3 dona qadoqda.",
        "Тонкий лаваш, упаковка 3 шт.",
        Unit.PIECE,
        9_000,
        stock_quantity=20,
        brand="Yangi Kun",
    ),
    SeedProduct(
        "DEMO-0022",
        "demo-qora-non",
        "demo-non",
        "Qora non, kesilgan",
        "Чёрный хлеб нарезной",
        "Kesilgan qora non, taxminan 400 g.",
        "Нарезной чёрный хлеб, около 400 г.",
        Unit.PIECE,
        8_000,
        stock_quantity=12,
        brand="Yangi Kun",
    ),
    SeedProduct(
        "DEMO-0023",
        "demo-samsa",
        "demo-non",
        "Go‘shtli samsa",
        "Самса с мясом",
        "Tandirda pishirilgan go‘shtli samsa, bittasi.",
        "Самса с мясом, испечённая в тандыре, 1 шт.",
        Unit.PIECE,
        7_000,
        stock_quantity=2,
    ),
    # --- Sut mahsulotlari va tuxum
    SeedProduct(
        "DEMO-0010",
        "demo-sut",
        "demo-sut",
        "Sut 3,2%",
        "Молоко 3,2%",
        "Pasterizatsiya qilingan sut, yog‘liligi 3,2%. Narxi 1 litr uchun.",
        "Пастеризованное молоко, жирность 3,2%. Цена за 1 литр.",
        Unit.L,
        14_000,
        stock_quantity=30,
        brand="Toza Dala",
    ),
    SeedProduct(
        "DEMO-0011",
        "demo-qatiq",
        "demo-sut",
        "Qatiq, 500 g",
        "Катык, 500 г",
        "Tabiiy qatiq, 500 g idishda.",
        "Натуральный катык, стакан 500 г.",
        Unit.PIECE,
        9_000,
        stock_quantity=25,
        brand="Toza Dala",
    ),
    SeedProduct(
        "DEMO-0012",
        "demo-pishloq",
        "demo-sut",
        "Qattiq pishloq, 300 g",
        "Сыр твёрдый, 300 г",
        "Qattiq pishloq, 300 g bo‘lagi.",
        "Твёрдый сыр, кусок 300 г.",
        Unit.PIECE,
        45_000,
        old_price_uzs=50_000,
        stock_quantity=15,
        brand="Yangi Kun",
    ),
    SeedProduct(
        "DEMO-0024",
        "demo-tuxum",
        "demo-sut",
        "Tovuq tuxumi (10 dona)",
        "Яйца куриные (10 шт.)",
        "Birinchi toifadagi tovuq tuxumi, 10 dona.",
        "Куриные яйца первой категории, 10 шт.",
        Unit.PIECE,
        20_000,
        stock_quantity=60,
        brand="Toza Dala",
    ),
    SeedProduct(
        "DEMO-0025",
        "demo-saryog",
        "demo-sut",
        "Sariyog‘ 82%, 180 g",
        "Масло сливочное 82%, 180 г",
        "Sariyog‘, yog‘liligi 82%, 180 g.",
        "Сливочное масло, жирность 82%, 180 г.",
        Unit.PIECE,
        28_000,
        old_price_uzs=32_000,
        stock_quantity=22,
        brand="Bog‘dan",
    ),
    # Edge case: a very long (but plausible) product name in both languages.
    SeedProduct(
        "DEMO-0026",
        "demo-brinza",
        "demo-sut",
        "Brinza pishlog‘i, sho‘r suvda saqlangan, yumshoq, past yog‘li, 400 g",
        "Брынза мягкая в рассоле, пониженной жирности, вакуумная упаковка, 400 г",
        "Yumshoq brinza pishlog‘i sho‘r suvda, past yog‘li. Ochilgach muzlatgichda saqlang.",
        "Мягкая брынза в рассоле, пониженной жирности. После вскрытия хранить в холодильнике.",
        Unit.PIECE,
        38_000,
        stock_quantity=10,
        brand="Bog‘dan",
    ),
    # --- Go‘sht va parranda
    SeedProduct(
        "DEMO-0027",
        "demo-mol-gosht",
        "demo-gosht",
        "Mol go‘shti, suyaksiz",
        "Говядина без кости",
        "Sovutilgan mol go‘shti, suyaksiz. Narxi 1 kg uchun.",
        "Охлаждённая говядина без кости. Цена за 1 кг.",
        Unit.KG,
        110_000,
        stock_quantity=18,
    ),
    SeedProduct(
        "DEMO-0028",
        "demo-qoy-gosht",
        "demo-gosht",
        "Qo‘y go‘shti, suyakli",
        "Баранина на кости",
        "Sovutilgan qo‘y go‘shti, suyakli. Narxi 1 kg uchun.",
        "Охлаждённая баранина на кости. Цена за 1 кг.",
        Unit.KG,
        120_000,
        stock_quantity=3,
    ),
    SeedProduct(
        "DEMO-0029",
        "demo-tovuq",
        "demo-gosht",
        "Tovuq go‘shti, butun",
        "Курица целая",
        "Sovutilgan butun tovuq. Narxi 1 kg uchun.",
        "Охлаждённая курица целиком. Цена за 1 кг.",
        Unit.KG,
        38_000,
        old_price_uzs=42_000,
        stock_quantity=40,
    ),
    # Out of stock (tracked, zero left).
    SeedProduct(
        "DEMO-0030",
        "demo-tovuq-filesi",
        "demo-gosht",
        "Tovuq filesi",
        "Филе куриное",
        "Sovutilgan tovuq filesi. Narxi 1 kg uchun.",
        "Охлаждённое куриное филе. Цена за 1 кг.",
        Unit.KG,
        52_000,
        stock_quantity=0,
    ),
    SeedProduct(
        "DEMO-0031",
        "demo-kiyma",
        "demo-gosht",
        "Mol go‘shti qiymasi",
        "Фарш говяжий",
        "Yangi tortilgan mol go‘shti qiymasi. Narxi 1 kg uchun.",
        "Свежий говяжий фарш. Цена за 1 кг.",
        Unit.KG,
        90_000,
        stock_quantity=12,
    ),
    # --- Guruch, un va donlar
    SeedProduct(
        "DEMO-0032",
        "demo-guruch",
        "demo-bakaleya",
        "Lazer guruchi",
        "Рис лазер",
        "Palov uchun lazer guruchi. Narxi 1 kg uchun.",
        "Рис лазер для плова. Цена за 1 кг.",
        Unit.KG,
        17_000,
        stock_quantity=150,
    ),
    SeedProduct(
        "DEMO-0033",
        "demo-un",
        "demo-bakaleya",
        "Bug‘doy uni, 2 kg",
        "Мука пшеничная, 2 кг",
        "Oliy navli bug‘doy uni, 2 kg qopda.",
        "Пшеничная мука высшего сорта, пакет 2 кг.",
        Unit.PIECE,
        24_000,
        stock_quantity=45,
        brand="Oltin Bug‘doy",
    ),
    SeedProduct(
        "DEMO-0034",
        "demo-makaron",
        "demo-bakaleya",
        "Spagetti makaron, 400 g",
        "Макароны спагетти, 400 г",
        "Qattiq navli bug‘doydan spagetti, 400 g.",
        "Спагетти из твёрдых сортов пшеницы, 400 г.",
        Unit.PIECE,
        9_000,
        brand="Oltin Bug‘doy",
    ),
    SeedProduct(
        "DEMO-0035",
        "demo-grechka",
        "demo-bakaleya",
        "Grechka, 800 g",
        "Гречка, 800 г",
        "Tozalangan grechka yormasi, 800 g.",
        "Очищенная гречневая крупа, 800 г.",
        Unit.PIECE,
        18_000,
        old_price_uzs=21_000,
        stock_quantity=35,
        brand="Bog‘dan",
    ),
    SeedProduct(
        "DEMO-0036",
        "demo-shakar",
        "demo-bakaleya",
        "Shakar",
        "Сахар-песок",
        "Oq shakar qumi. Narxi 1 kg uchun.",
        "Белый сахар-песок. Цена за 1 кг.",
        Unit.KG,
        14_000,
        stock_quantity=100,
    ),
    # --- Yog‘ va ziravorlar
    SeedProduct(
        "DEMO-0037",
        "demo-kungaboqar-yogi",
        "demo-yog-ziravor",
        "Kungaboqar yog‘i, 1 l",
        "Масло подсолнечное, 1 л",
        "Tozalangan kungaboqar yog‘i, 1 litrli shisha.",
        "Рафинированное подсолнечное масло, бутылка 1 л.",
        Unit.PIECE,
        24_000,
        stock_quantity=50,
        brand="Bog‘dan",
    ),
    SeedProduct(
        "DEMO-0038",
        "demo-tuz",
        "demo-yog-ziravor",
        "Yodlangan tuz, 1 kg",
        "Соль йодированная, 1 кг",
        "Yodlangan osh tuzi, 1 kg qadoq.",
        "Йодированная поваренная соль, пачка 1 кг.",
        Unit.PIECE,
        4_000,
    ),
    SeedProduct(
        "DEMO-0039",
        "demo-zira",
        "demo-yog-ziravor",
        "Zira, 50 g",
        "Зира, 50 г",
        "Butun zira, 50 g qadoqda.",
        "Зира цельная, упаковка 50 г.",
        Unit.PIECE,
        8_000,
        stock_quantity=2,
        brand="Toza Dala",
    ),
    # --- Ichimliklar
    SeedProduct(
        "DEMO-0009",
        "demo-ichimlik-suvi",
        "demo-ichimliklar",
        "Ichimlik suvi",
        "Питьевая вода",
        "Gazsiz ichimlik suvi. Narxi 1 litr uchun.",
        "Питьевая вода без газа. Цена за 1 литр.",
        Unit.L,
        5_000,
        brand="Sof Chashma",
    ),
    SeedProduct(
        "DEMO-0040",
        "demo-gazli-suv",
        "demo-ichimliklar",
        "Limonli gazli ichimlik, 1,5 l",
        "Газированный напиток лимонный, 1,5 л",
        "Limon ta’mli gazli ichimlik, 1,5 litrli shisha.",
        "Газированный напиток со вкусом лимона, бутылка 1,5 л.",
        Unit.PIECE,
        9_000,
        stock_quantity=50,
        brand="Sof Chashma",
    ),
    SeedProduct(
        "DEMO-0007",
        "demo-olma-sharbati",
        "demo-sharbatlar",
        "Olma sharbati",
        "Яблочный сок",
        "Olmadan tayyorlangan sharbat. Narxi 1 litr uchun.",
        "Сок из яблок. Цена за 1 литр.",
        Unit.L,
        18_000,
        stock_quantity=60,
        brand="Yangi Kun",
    ),
    # Out of stock (tracked, zero left).
    SeedProduct(
        "DEMO-0008",
        "demo-shaftoli-sharbati",
        "demo-sharbatlar",
        "Shaftoli sharbati",
        "Персиковый сок",
        "Shaftolidan tayyorlangan sharbat. Narxi 1 litr uchun.",
        "Сок из персиков. Цена за 1 литр.",
        Unit.L,
        20_000,
        old_price_uzs=24_000,
        stock_quantity=0,
        brand="Yangi Kun",
    ),
    SeedProduct(
        "DEMO-0041",
        "demo-anor-sharbati",
        "demo-sharbatlar",
        "Anor sharbati",
        "Гранатовый сок",
        "Anordan siqilgan sharbat. Narxi 1 litr uchun.",
        "Сок из граната. Цена за 1 литр.",
        Unit.L,
        28_000,
        stock_quantity=20,
        brand="Yangi Kun",
    ),
    # --- Choy, qahva va shirinliklar
    SeedProduct(
        "DEMO-0042",
        "demo-qora-choy",
        "demo-choy-shirinlik",
        "Qora choy, 100 g",
        "Чай чёрный, 100 г",
        "Yirik bargli qora choy, 100 g.",
        "Чёрный крупнолистовой чай, 100 г.",
        Unit.PIECE,
        15_000,
        stock_quantity=60,
        brand="Toza Dala",
    ),
    SeedProduct(
        "DEMO-0043",
        "demo-yashil-choy",
        "demo-choy-shirinlik",
        "Yashil choy, 100 g",
        "Чай зелёный, 100 г",
        "Yashil bargli choy, 100 g.",
        "Зелёный листовой чай, 100 г.",
        Unit.PIECE,
        16_000,
        old_price_uzs=18_000,
        stock_quantity=35,
        brand="Toza Dala",
    ),
    SeedProduct(
        "DEMO-0044",
        "demo-qahva",
        "demo-choy-shirinlik",
        "Eruvchan qahva, 100 g",
        "Кофе растворимый, 100 г",
        "Eruvchan qahva, 100 g bankada.",
        "Растворимый кофе, банка 100 г.",
        Unit.PIECE,
        38_000,
    ),
    SeedProduct(
        "DEMO-0045",
        "demo-asal",
        "demo-choy-shirinlik",
        "Tog‘ asali, 500 g",
        "Горный мёд, 500 г",
        "Tog‘ asali, 500 g shisha idishda.",
        "Горный мёд, стеклянная банка 500 г.",
        Unit.PIECE,
        85_000,
        stock_quantity=3,
    ),
    # Out of stock (tracked, zero left).
    SeedProduct(
        "DEMO-0046",
        "demo-shokolad",
        "demo-choy-shirinlik",
        "Sutli shokolad, 90 g",
        "Молочный шоколад, 90 г",
        "Sutli shokolad plitkasi, 90 g.",
        "Плитка молочного шоколада, 90 г.",
        Unit.PIECE,
        12_000,
        stock_quantity=0,
        brand="Bog‘dan",
    ),
    # --- Uy-ro‘zg‘or mahsulotlari
    SeedProduct(
        "DEMO-0047",
        "demo-kir-kukuni",
        "demo-uy-rozgor",
        "Kir yuvish kukuni, 3 kg",
        "Стиральный порошок, 3 кг",
        "Avtomat mashina uchun kir yuvish kukuni, 3 kg.",
        "Стиральный порошок для автоматических машин, 3 кг.",
        Unit.PIECE,
        55_000,
        stock_quantity=15,
        brand="Sof Chashma",
    ),
    SeedProduct(
        "DEMO-0048",
        "demo-qogoz-sochiq",
        "demo-uy-rozgor",
        "Qog‘oz sochiq (2 rulon)",
        "Бумажные полотенца (2 рулона)",
        "Oshxona uchun qog‘oz sochiq, 2 rulon.",
        "Бумажные кухонные полотенца, 2 рулона.",
        Unit.PIECE,
        12_000,
    ),
    SeedProduct(
        "DEMO-0049",
        "demo-tualet-qogozi",
        "demo-uy-rozgor",
        "Tualet qog‘ozi (8 rulon)",
        "Туалетная бумага (8 рулонов)",
        "Ikki qavatli tualet qog‘ozi, 8 rulon.",
        "Двухслойная туалетная бумага, 8 рулонов.",
        Unit.PIECE,
        28_000,
        old_price_uzs=32_000,
        stock_quantity=30,
    ),
    # Active product whose category chain contains an inactive category.
    SeedProduct(
        "DEMO-0014",
        "demo-arxiv-mahsulot",
        "demo-arxiv-ichki",
        "Arxivdagi mahsulot",
        "Товар из архива",
        "Nofaol toifadagi mahsulot: do‘konda ko‘rinmasligi kerak.",
        "Товар в неактивной категории: в магазине не должен отображаться.",
        Unit.PIECE,
        6_000,
        stock_quantity=9,
    ),
)


@dataclass(frozen=True, slots=True)
class SeedZone:
    slug: str
    name_uz: str
    name_ru: str
    delivery_fee_uzs: int
    free_delivery_threshold_uzs: int | None
    min_order_uzs: int
    opens_at: time
    closes_at: time
    sort_order: int
    districts: tuple[DistrictCode, ...]
    is_active: bool = True


# Every district appears in exactly one zone (``delivery_zone_districts`` enforces it).
DEMO_ZONES: tuple[SeedZone, ...] = (
    SeedZone(
        "demo-markaziy",
        "Demo markaziy zona",
        "Демо центральная зона",
        delivery_fee_uzs=15_000,
        free_delivery_threshold_uzs=300_000,
        min_order_uzs=50_000,
        opens_at=time(9, 0),
        closes_at=time(21, 0),
        sort_order=10,
        districts=("mirobod", "yakkasaroy", "shayxontohur", "yunusobod", "mirzo_ulugbek"),
    ),
    SeedZone(
        "demo-chekka",
        "Demo chekka zona",
        "Демо окраинная зона",
        delivery_fee_uzs=25_000,
        free_delivery_threshold_uzs=500_000,
        min_order_uzs=100_000,
        opens_at=time(9, 0),
        closes_at=time(20, 0),
        sort_order=20,
        districts=("chilonzor", "olmazor", "uchtepa", "yashnobod"),
    ),
    SeedZone(
        "demo-janubiy",
        "Demo janubiy zona",
        "Демо южная зона",
        delivery_fee_uzs=30_000,
        free_delivery_threshold_uzs=None,
        min_order_uzs=150_000,
        opens_at=time(10, 0),
        closes_at=time(19, 0),
        sort_order=30,
        districts=("sergeli",),
    ),
    SeedZone(
        "demo-yopiq",
        "Demo yopiq zona",
        "Демо закрытая зона",
        delivery_fee_uzs=40_000,
        free_delivery_threshold_uzs=None,
        min_order_uzs=200_000,
        opens_at=time(10, 0),
        closes_at=time(18, 0),
        sort_order=40,
        districts=("bektemir", "yangihayot"),
        is_active=False,
    ),
)

# Delivery slots: only this zone has them (see the module docstring for why).
SLOT_ZONE_SLUG = "demo-chekka"
SLOT_DAYS = 7
SLOT_CAPACITY = 20
SLOT_CUTOFF_BEFORE_START = timedelta(hours=2)
# (starts_at, ends_at), local Asia/Tashkent time, within the zone's 09:00-20:00 hours.
SLOT_WINDOWS: tuple[tuple[time, time], ...] = (
    (time(10, 0), time(13, 0)),
    (time(15, 0), time(18, 0)),
)
SLOT_COLUMNS = ("ends_at", "capacity", "cutoff_at", "is_active")

ZONE_COLUMNS = (
    "name_uz",
    "name_ru",
    "delivery_fee_uzs",
    "free_delivery_threshold_uzs",
    "min_order_uzs",
    "opens_at",
    "closes_at",
    "sort_order",
    "is_active",
)

CATEGORY_COLUMNS = ("parent_id", "name_uz", "name_ru", "image_url", "sort_order", "is_active")
PRODUCT_COLUMNS = (
    "category_id",
    "sku",
    "name_uz",
    "name_ru",
    "description_uz",
    "description_ru",
    "brand",
    "unit",
    "price_uzs",
    "old_price_uzs",
    "stock_quantity",
    "image_url",
    "is_active",
)


@dataclass(frozen=True, slots=True)
class SeedResult:
    categories_written: int
    products_written: int
    zones_written: int = 0
    slots_written: int = 0


def _differs(
    model: type[Category]
    | type[Product]
    | type[DeliveryZone]
    | type[DeliveryZoneDistrict]
    | type[DeliverySlot],
    excluded: object,
    columns: Iterable[str],
) -> ColumnElement[bool]:
    """True when any listed column of the stored row differs from the incoming one."""
    return or_(
        *(getattr(model, column).is_distinct_from(getattr(excluded, column)) for column in columns)
    )


async def _seed_categories(session: AsyncSession) -> tuple[dict[str, uuid.UUID], int]:
    ids: dict[str, uuid.UUID] = {}
    written = 0
    for category in DEMO_CATEGORIES:
        values = {
            "slug": category.slug,
            "parent_id": ids[category.parent_slug] if category.parent_slug else None,
            "name_uz": category.name_uz,
            "name_ru": category.name_ru,
            "image_url": None,
            "sort_order": category.sort_order,
            "is_active": category.is_active,
        }
        statement = insert(Category).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[Category.slug],
            set_={column: getattr(statement.excluded, column) for column in CATEGORY_COLUMNS},
            where=_differs(Category, statement.excluded, CATEGORY_COLUMNS),
        )
        result = await session.execute(statement)
        written += result.rowcount  # type: ignore[attr-defined]
        ids[category.slug] = (
            await session.execute(select(Category.id).where(Category.slug == category.slug))
        ).scalar_one()
    return ids, written


async def _seed_products(session: AsyncSession, category_ids: dict[str, uuid.UUID]) -> int:
    written = 0
    for product in DEMO_PRODUCTS:
        values = {
            "slug": product.slug,
            "category_id": category_ids[product.category_slug],
            "sku": product.sku,
            "name_uz": product.name_uz,
            "name_ru": product.name_ru,
            "description_uz": product.description_uz,
            "description_ru": product.description_ru,
            "brand": product.brand,
            "unit": product.unit,
            "price_uzs": product.price_uzs,
            "old_price_uzs": product.old_price_uzs,
            "stock_quantity": product.stock_quantity,
            "image_url": None,
            "is_active": product.is_active,
        }
        statement = insert(Product).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[Product.slug],
            set_={column: getattr(statement.excluded, column) for column in PRODUCT_COLUMNS},
            # An admin archived it: leave it archived (and inactive, as the CHECK requires).
            where=Product.archived_at.is_(None)
            & _differs(Product, statement.excluded, PRODUCT_COLUMNS),
        )
        written += (await session.execute(statement)).rowcount  # type: ignore[attr-defined]
    return written


async def _seed_zones(session: AsyncSession) -> int:
    """Upsert zones by slug and districts by district; returns zone rows written."""
    written = 0
    for zone in DEMO_ZONES:
        values = {column: getattr(zone, column) for column in ZONE_COLUMNS}
        statement = insert(DeliveryZone).values(slug=zone.slug, **values)
        statement = statement.on_conflict_do_update(
            index_elements=[DeliveryZone.slug],
            set_={column: getattr(statement.excluded, column) for column in ZONE_COLUMNS},
            where=_differs(DeliveryZone, statement.excluded, ZONE_COLUMNS),
        )
        written += (await session.execute(statement)).rowcount  # type: ignore[attr-defined]
        zone_id = (
            await session.execute(select(DeliveryZone.id).where(DeliveryZone.slug == zone.slug))
        ).scalar_one()
        for district in zone.districts:
            link = insert(DeliveryZoneDistrict).values(district=district, zone_id=zone_id)
            await session.execute(
                link.on_conflict_do_update(
                    index_elements=[DeliveryZoneDistrict.district],
                    set_={"zone_id": link.excluded.zone_id},
                    where=_differs(DeliveryZoneDistrict, link.excluded, ("zone_id",)),
                )
            )
    return written


def demo_slot_days(today: date) -> list[date]:
    return [today + timedelta(days=offset) for offset in range(SLOT_DAYS)]


async def _seed_slots(session: AsyncSession, today: date) -> int:
    """Upsert the demo slots by ``(zone, date, start)``; returns slot rows written."""
    zone_id = (
        await session.execute(select(DeliveryZone.id).where(DeliveryZone.slug == SLOT_ZONE_SLUG))
    ).scalar_one()
    written = 0
    for day in demo_slot_days(today):
        for starts_at, ends_at in SLOT_WINDOWS:
            statement = insert(DeliverySlot).values(
                zone_id=zone_id,
                slot_date=day,
                starts_at=starts_at,
                ends_at=ends_at,
                capacity=SLOT_CAPACITY,
                cutoff_at=tashkent_instant(day, starts_at) - SLOT_CUTOFF_BEFORE_START,
                is_active=True,
            )
            excluded = statement.excluded
            statement = statement.on_conflict_do_update(
                index_elements=[
                    DeliverySlot.zone_id,
                    DeliverySlot.slot_date,
                    DeliverySlot.starts_at,
                ],
                set_={
                    "ends_at": excluded.ends_at,
                    # Never below what customers already booked (the CHECK would refuse it).
                    "capacity": func.greatest(excluded.capacity, DeliverySlot.reserved_count),
                    "cutoff_at": excluded.cutoff_at,
                    "is_active": excluded.is_active,
                },
                where=_differs(DeliverySlot, excluded, SLOT_COLUMNS),
            )
            written += (await session.execute(statement)).rowcount  # type: ignore[attr-defined]
    return written


async def seed(
    session_factory: async_sessionmaker[AsyncSession], *, today: date | None = None
) -> SeedResult:
    """Upsert the demo catalog, delivery zones and slots in one transaction.

    ``today`` (the local Asia/Tashkent date the slots start from) defaults to the current one.
    """
    day = today if today is not None else tashkent_date(datetime.now(UTC))
    async with session_factory() as session:
        category_ids, categories_written = await _seed_categories(session)
        products_written = await _seed_products(session, category_ids)
        zones_written = await _seed_zones(session)
        slots_written = await _seed_slots(session, day)
        await session.commit()
    return SeedResult(
        categories_written=categories_written,
        products_written=products_written,
        zones_written=zones_written,
        slots_written=slots_written,
    )


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    settings = get_settings()
    try:
        ensure_safe_environment(settings.app_env)
    except SeedRefusedError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2

    engine = create_engine(settings)
    try:
        result = await seed(create_session_factory(engine))
    finally:
        await engine.dispose()
    logger.info(
        "demo data seeded: %d categories, %d products, %d delivery zones and %d delivery slots "
        "written (%d/%d/%d/%d unchanged)",
        result.categories_written,
        result.products_written,
        result.zones_written,
        result.slots_written,
        len(DEMO_CATEGORIES) - result.categories_written,
        len(DEMO_PRODUCTS) - result.products_written,
        len(DEMO_ZONES) - result.zones_written,
        SLOT_DAYS * len(SLOT_WINDOWS) - result.slots_written,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
