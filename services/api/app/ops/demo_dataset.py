"""The one canonical synthetic demo dataset: categories, products and delivery zones.

Used by the local dev seed (``app.dev.seed``, every row) and by the operator-run production demo
import (``app.ops.demo_catalog``, every row that is not ``dev_only``). A realistic mock Tashkent
grocery catalog in Uzbek (Latin, with U+2018 apostrophes) and Russian, plausible but made-up so'm
prices, yet everything is synthetic: the markers are the ``DEMO-NNNN`` SKUs and ``demo-`` slugs,
brand names are invented (``SYNTHETIC_BRANDS``, never a real trademark) and there are no barcodes.
Photos (real Unsplash/Pexels stock photos served by the storefront) are mapped by slug in
``app.ops.demo_images``.

``dev_only`` rows exist to exercise edge cases in development and tests (an inactive category
with an active child, a product hidden by its inactive category chain, an inactive zone); the
production demo import leaves them out. Delivery zones are named ``Demo``/``Демо`` so nobody
mistakes them for real delivery rules.
"""

# Uzbek Latin is written with U+2018/U+2019 apostrophes (as in the storefront); ruff flags them.
# ruff: noqa: RUF001, RUF003

from dataclasses import dataclass
from datetime import time

from app.domain.delivery import DistrictCode
from app.models.enums import Unit


@dataclass(frozen=True, slots=True)
class SeedCategory:
    slug: str
    name_uz: str
    name_ru: str
    sort_order: int
    parent_slug: str | None = None
    is_active: bool = True
    # Edge-case fixture for development/tests only; the production demo import skips it.
    dev_only: bool = False


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
    dev_only: bool = False


# The only brand names the demo data uses: invented, so no real trademark appears in the demo data.
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
    SeedCategory(
        "demo-arxiv",
        "Arxiv (nofaol)",
        "Архив (неактивно)",
        99,
        is_active=False,
        dev_only=True,
    ),
    SeedCategory(
        "demo-arxiv-ichki",
        "Arxiv ichki",
        "Архив вложенный",
        10,
        parent_slug="demo-arxiv",
        dev_only=True,
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
        dev_only=True,
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
    dev_only: bool = False


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
        dev_only=True,
    ),
)


def production_categories() -> tuple[SeedCategory, ...]:
    """The categories the production demo import writes (parents before children)."""
    return tuple(category for category in DEMO_CATEGORIES if not category.dev_only)


def production_products() -> tuple[SeedProduct, ...]:
    return tuple(product for product in DEMO_PRODUCTS if not product.dev_only)


def production_zones() -> tuple[SeedZone, ...]:
    return tuple(zone for zone in DEMO_ZONES if not zone.dev_only)
