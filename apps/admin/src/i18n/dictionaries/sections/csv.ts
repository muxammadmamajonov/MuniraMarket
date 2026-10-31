import type { Locale } from '@muniramarket/contracts';

/** Per-row CSV error codes (the API's `CsvRowErrorOut.code`, plus `stale_row`). Unknown codes fall back to `unknown`. */
export type CsvRowCode =
  | 'required'
  | 'invalid_sku'
  | 'duplicate_sku'
  | 'invalid_slug'
  | 'slug_taken'
  | 'category_not_found'
  | 'invalid_money'
  | 'invalid_old_price'
  | 'invalid_stock'
  | 'invalid_unit'
  | 'invalid_bool'
  | 'invalid_sort_order'
  | 'invalid_text'
  | 'formula_not_allowed'
  | 'invalid_image_url'
  | 'product_archived'
  | 'stale_row';

export interface CsvDict {
  title: string;
  intro: string;
  columnsHint: string;
  template: { title: string; description: string; button: string };
  export: { title: string; description: string; button: string };
  downloading: string;
  downloadFailed: string;
  upload: {
    title: string;
    fileLabel: string;
    hint: string;
    chosen: string;
    notCsv: string;
    tooLarge: string;
    empty: string;
    readFailed: string;
  };
  check: string;
  checking: string;
  apply: string;
  applying: string;
  applyHint: string;
  fileChanged: string;
  dryRunClean: string;
  appliedOk: string;
  notApplied: string;
  summary: {
    title: string;
    total: string;
    creates: string;
    updates: string;
    unchanged: string;
  };
  errors: {
    title: string;
    table: string;
    truncated: string;
    row: string;
    headerRow: string;
    column: string;
    problem: string;
    codes: Record<CsvRowCode, string>;
    unknown: string;
  };
}

export const csvDict: Record<Locale, CsvDict> = {
  uz: {
    title: 'Katalog importi va eksporti',
    intro:
      'Mahsulotlarni CSV fayl orqali ommaviy yangilang. Avval faylni tekshiring (hech narsa saqlanmaydi), xatolar bo‘lmasa — qo‘llang.',
    columnsHint:
      'Mavjud artikul bo‘yicha mahsulot yangilanadi, yangi artikul bo‘yicha yaratiladi. Xato bo‘lsa, hech narsa saqlanmaydi.',
    template: {
      title: 'Shablon',
      description: 'To‘g‘ri sarlavhali bo‘sh CSV fayl.',
      button: 'Shablonni yuklab olish',
    },
    export: {
      title: 'Eksport',
      description:
        'Arxivlanmagan barcha mahsulotlar, artikul bo‘yicha tartiblangan. Tahrirlab, qayta import qilish mumkin.',
      button: 'Mahsulotlarni yuklab olish',
    },
    downloading: 'Yuklab olinmoqda…',
    downloadFailed: 'Faylni yuklab olib bo‘lmadi. Qayta urinib ko‘ring.',
    upload: {
      title: 'Import',
      fileLabel: 'CSV fayl',
      hint: 'Faqat .csv, UTF-8, 1 MB gacha, 2000 qatorgacha.',
      chosen: 'Tanlangan fayl: {name} ({size})',
      notCsv: 'Faqat .csv kengaytmali fayl yuklash mumkin.',
      tooLarge: 'Fayl 1 MB dan katta. Uni qismlarga bo‘ling.',
      empty: 'Fayl bo‘sh.',
      readFailed: 'Faylni o‘qib bo‘lmadi. Boshqa fayl tanlang.',
    },
    check: 'Tekshirish (sinov)',
    checking: 'Tekshirilmoqda…',
    apply: 'Qo‘llash',
    applying: 'Qo‘llanmoqda…',
    applyHint: '«Qo‘llash» faqat shu fayl xatosiz tekshirilgandan keyin yoqiladi.',
    fileChanged: 'Fayl o‘zgargan: «Qo‘llash» uchun uni qayta tekshiring.',
    dryRunClean: 'Xatolar topilmadi. Endi o‘zgarishlarni qo‘llash mumkin.',
    appliedOk: 'Import bajarildi: o‘zgarishlar saqlandi.',
    notApplied: 'Hech narsa saqlanmadi: faylda xatolar bor.',
    summary: {
      title: 'Natija',
      total: 'Qatorlar',
      creates: 'Yangi',
      updates: 'Yangilanadi',
      unchanged: 'O‘zgarmagan',
    },
    errors: {
      title: 'Faylda xatolar bor',
      table: 'Faylning xatolari',
      truncated: 'Faqat birinchi 200 ta xato ko‘rsatilgan. Ularni tuzatib, qayta tekshiring.',
      row: 'Qator',
      headerRow: 'Sarlavha',
      column: 'Ustun',
      problem: 'Xato',
      codes: {
        required: 'Majburiy maydon bo‘sh.',
        invalid_sku: 'Artikul noto‘g‘ri (lotin harflari, raqamlar, . _ -, 64 tagacha).',
        duplicate_sku: 'Bu artikul faylda takrorlangan.',
        invalid_slug: 'Slug noto‘g‘ri (kichik lotin harflari, raqamlar va defis).',
        slug_taken: 'Bu slug boshqa mahsulotda yoki faylda band.',
        category_not_found: 'Bunday slug’li kategoriya topilmadi.',
        invalid_money: 'Narx noto‘g‘ri: faqat raqamlar, 13 xonagacha, kasr va probelsiz.',
        invalid_old_price: 'Eski narx joriy narxdan katta butun son bo‘lishi kerak.',
        invalid_stock: 'Qoldiq noto‘g‘ri: bo‘sh (hisobsiz) yoki 7 xonagacha butun son.',
        invalid_unit: 'O‘lchov birligi noto‘g‘ri (piece, kg, g, l, ml).',
        invalid_bool: 'Qiymat true/false yoki 1/0 bo‘lishi kerak.',
        invalid_sort_order: 'Saralash tartibi −100 000 dan 100 000 gacha butun son bo‘lishi kerak.',
        invalid_text: 'Matn noto‘g‘ri: boshqaruv belgilari, buzilgan harflar yoki juda uzun.',
        formula_not_allowed: 'Matn =, +, @ bilan boshlanmasin (jadval formulasi deb o‘qiladi).',
        invalid_image_url: 'Rasm manzili noto‘g‘ri: faqat https:// bilan boshlanishi kerak.',
        product_archived: 'Mahsulot arxivda. Avval uni tiklang.',
        stale_row:
          'Mahsulot eksportdan keyin o‘zgargan. Mahsulotlarni qayta eksport qiling va yangi fayl bilan ishlang.',
      },
      unknown: 'Noma’lum xato.',
    },
  },
  ru: {
    title: 'Импорт и экспорт каталога',
    intro:
      'Массово обновляйте товары через CSV. Сначала проверьте файл (ничего не сохраняется), а если ошибок нет — примените.',
    columnsHint:
      'Товар с существующим артикулом обновляется, с новым — создаётся. При любой ошибке ничего не сохраняется.',
    template: {
      title: 'Шаблон',
      description: 'Пустой CSV с правильным заголовком.',
      button: 'Скачать шаблон',
    },
    export: {
      title: 'Экспорт',
      description:
        'Все товары, кроме архивных, по артикулу. Можно отредактировать и загрузить обратно.',
      button: 'Скачать товары',
    },
    downloading: 'Скачивание…',
    downloadFailed: 'Не удалось скачать файл. Повторите попытку.',
    upload: {
      title: 'Импорт',
      fileLabel: 'CSV-файл',
      hint: 'Только .csv, UTF-8, до 1 МБ и до 2000 строк.',
      chosen: 'Выбран файл: {name} ({size})',
      notCsv: 'Можно загрузить только файл с расширением .csv.',
      tooLarge: 'Файл больше 1 МБ. Разделите его на части.',
      empty: 'Файл пустой.',
      readFailed: 'Не удалось прочитать файл. Выберите другой.',
    },
    check: 'Проверить (пробный запуск)',
    checking: 'Проверка…',
    apply: 'Применить',
    applying: 'Применение…',
    applyHint: 'Кнопка «Применить» станет доступной после проверки этого файла без ошибок.',
    fileChanged: 'Файл изменился: чтобы применить, проверьте его заново.',
    dryRunClean: 'Ошибок нет. Теперь можно применить изменения.',
    appliedOk: 'Импорт выполнен: изменения сохранены.',
    notApplied: 'Ничего не сохранено: в файле есть ошибки.',
    summary: {
      title: 'Результат',
      total: 'Строк',
      creates: 'Новых',
      updates: 'Обновится',
      unchanged: 'Без изменений',
    },
    errors: {
      title: 'В файле есть ошибки',
      table: 'Ошибки файла',
      truncated: 'Показаны только первые 200 ошибок. Исправьте их и проверьте файл заново.',
      row: 'Строка',
      headerRow: 'Заголовок',
      column: 'Столбец',
      problem: 'Ошибка',
      codes: {
        required: 'Обязательное поле пустое.',
        invalid_sku: 'Неверный артикул (латиница, цифры, . _ -, до 64 знаков).',
        duplicate_sku: 'Этот артикул повторяется в файле.',
        invalid_slug: 'Неверный slug (строчная латиница, цифры и дефис).',
        slug_taken: 'Этот slug занят другим товаром или повторяется в файле.',
        category_not_found: 'Категория с таким slug не найдена.',
        invalid_money: 'Неверная цена: только цифры, до 13 знаков, без дробей и пробелов.',
        invalid_old_price: 'Старая цена должна быть целым числом больше текущей.',
        invalid_stock: 'Неверный остаток: пусто (без учёта) или целое до 7 знаков.',
        invalid_unit: 'Неверная единица измерения (piece, kg, g, l, ml).',
        invalid_bool: 'Значение должно быть true/false или 1/0.',
        invalid_sort_order: 'Порядок сортировки — целое число от −100 000 до 100 000.',
        invalid_text: 'Неверный текст: управляющие символы, «кракозябры» или слишком длинный.',
        formula_not_allowed:
          'Текст не должен начинаться с =, +, @ (таблица прочтёт его как формулу).',
        invalid_image_url: 'Неверный адрес изображения: нужен адрес, начинающийся с https://.',
        product_archived: 'Товар в архиве. Сначала восстановите его.',
        stale_row:
          'Товар изменился после экспорта. Экспортируйте товары заново и работайте с новым файлом.',
      },
      unknown: 'Неизвестная ошибка.',
    },
  },
};
