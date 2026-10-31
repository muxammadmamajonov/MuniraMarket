import type { Locale } from '@muniramarket/contracts';

/** Navigation, words used on many screens, form validation and API error copy. */

export interface NavDict {
  label: string;
  quickLabel: string;
  skipToContent: string;
  menu: string;
  menuTitle: string;
  closeMenu: string;
  accountTitle: string;
  groups: { catalog: string; delivery: string; system: string };
  items: {
    dashboard: string;
    orders: string;
    products: string;
    categories: string;
    import: string;
    zones: string;
    slots: string;
    users: string;
    audit: string;
  };
}

export interface CommonDict {
  save: string;
  saving: string;
  cancel: string;
  close: string;
  edit: string;
  delete: string;
  create: string;
  search: string;
  apply: string;
  resetFilters: string;
  all: string;
  active: string;
  inactive: string;
  yes: string;
  no: string;
  optional: string;
  loading: string;
  retry: string;
  back: string;
  none: string;
  noValue: string;
  rowActions: string;
  pagination: { label: string; previous: string; next: string; pageOf: string };
  total: string;
  saved: string;
  updating: string;
}

export interface PermissionDict {
  title: string;
  message: string;
  home: string;
}

export type FieldKey =
  | 'sku'
  | 'slug'
  | 'name_uz'
  | 'name_ru'
  | 'description_uz'
  | 'description_ru'
  | 'category_id'
  | 'parent_id'
  | 'unit'
  | 'price_uzs'
  | 'old_price_uzs'
  | 'stock_quantity'
  | 'sort_order'
  | 'image_url'
  | 'delivery_fee_uzs'
  | 'free_delivery_threshold_uzs'
  | 'min_order_uzs'
  | 'opens_at'
  | 'closes_at'
  | 'districts'
  | 'zone_id'
  | 'slot_date'
  | 'starts_at'
  | 'ends_at'
  | 'capacity'
  | 'cutoff_at';

export interface ValidationDict {
  required: string;
  invalid: string;
  summary: string;
  /** Rule shown under a field that the API rejected (or that fails the same rule client-side). */
  fields: Record<FieldKey, string>;
}

/** Codes the back-office screens translate; anything else falls back to a generic message. */
export type AdminErrorCode =
  | 'slug_taken'
  | 'sku_taken'
  | 'category_cycle'
  | 'category_not_empty'
  | 'product_archived'
  | 'category_not_found'
  | 'product_not_found'
  | 'user_not_found'
  | 'last_admin'
  | 'cannot_block_self'
  | 'zone_not_found'
  | 'zone_in_use'
  | 'district_taken'
  | 'slot_not_found'
  | 'slot_exists'
  | 'slot_in_use'
  | 'capacity_below_reserved'
  | 'csv_invalid_encoding'
  | 'csv_invalid_header'
  | 'csv_malformed'
  | 'csv_too_many_rows'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'validation_error'
  | 'conflict'
  | 'not_found'
  | 'csrf_failed';

export interface ApiErrorsDict {
  codes: Record<AdminErrorCode, string>;
  /** `{seconds}` is replaced when the API sent `Retry-After`. */
  rateLimitedWait: string;
  writeFailed: string;
}

const nav: Record<Locale, NavDict> = {
  uz: {
    label: 'Asosiy navigatsiya',
    quickLabel: 'Tezkor navigatsiya',
    skipToContent: 'Asosiy kontentga o‘tish',
    menu: 'Menyu',
    menuTitle: 'Menyu',
    closeMenu: 'Menyuni yopish',
    accountTitle: 'Hisob',
    groups: { catalog: 'Katalog', delivery: 'Yetkazib berish', system: 'Tizim' },
    items: {
      dashboard: 'Bosh sahifa',
      orders: 'Buyurtmalar',
      products: 'Mahsulotlar',
      categories: 'Kategoriyalar',
      import: 'Import va eksport',
      zones: 'Hududlar',
      slots: 'Vaqt oraliqlari',
      users: 'Foydalanuvchilar',
      audit: 'Audit jurnali',
    },
  },
  ru: {
    label: 'Основная навигация',
    quickLabel: 'Быстрая навигация',
    skipToContent: 'Перейти к содержимому',
    menu: 'Меню',
    menuTitle: 'Меню',
    closeMenu: 'Закрыть меню',
    accountTitle: 'Аккаунт',
    groups: { catalog: 'Каталог', delivery: 'Доставка', system: 'Система' },
    items: {
      dashboard: 'Главная',
      orders: 'Заказы',
      products: 'Товары',
      categories: 'Категории',
      import: 'Импорт и экспорт',
      zones: 'Зоны',
      slots: 'Слоты',
      users: 'Пользователи',
      audit: 'Журнал аудита',
    },
  },
};

const common: Record<Locale, CommonDict> = {
  uz: {
    save: 'Saqlash',
    saving: 'Saqlanmoqda…',
    cancel: 'Bekor qilish',
    close: 'Yopish',
    edit: 'Tahrirlash',
    delete: 'O‘chirish',
    create: 'Yaratish',
    search: 'Qidirish',
    apply: 'Qo‘llash',
    resetFilters: 'Filtrlarni tozalash',
    all: 'Hammasi',
    active: 'Faol',
    inactive: 'Nofaol',
    yes: 'Ha',
    no: 'Yo‘q',
    optional: 'ixtiyoriy',
    loading: 'Yuklanmoqda…',
    retry: 'Qayta urinish',
    back: 'Orqaga',
    none: 'Yo‘q',
    noValue: '—',
    rowActions: 'Amallar',
    pagination: {
      label: 'Sahifalar',
      previous: 'Oldingi',
      next: 'Keyingi',
      pageOf: '{page}-sahifa / {total}',
    },
    total: 'Jami: {count}',
    saved: 'Saqlandi.',
    updating: 'Yangilanmoqda…',
  },
  ru: {
    save: 'Сохранить',
    saving: 'Сохранение…',
    cancel: 'Отмена',
    close: 'Закрыть',
    edit: 'Изменить',
    delete: 'Удалить',
    create: 'Создать',
    search: 'Поиск',
    apply: 'Применить',
    resetFilters: 'Сбросить фильтры',
    all: 'Все',
    active: 'Активен',
    inactive: 'Неактивен',
    yes: 'Да',
    no: 'Нет',
    optional: 'необязательно',
    loading: 'Загрузка…',
    retry: 'Повторить',
    back: 'Назад',
    none: 'Нет',
    noValue: '—',
    rowActions: 'Действия',
    pagination: {
      label: 'Страницы',
      previous: 'Назад',
      next: 'Далее',
      pageOf: 'Страница {page} из {total}',
    },
    total: 'Всего: {count}',
    saved: 'Сохранено.',
    updating: 'Обновление…',
  },
};

const permission: Record<Locale, PermissionDict> = {
  uz: {
    title: 'Huquq yetarli emas',
    message:
      'Bu bo‘lim faqat administratorlar uchun. Kerak bo‘lsa, administratorga murojaat qiling.',
    home: 'Bosh sahifaga qaytish',
  },
  ru: {
    title: 'Недостаточно прав',
    message:
      'Этот раздел доступен только администраторам. При необходимости обратитесь к администратору.',
    home: 'На главную',
  },
};

const validation: Record<Locale, ValidationDict> = {
  uz: {
    required: 'Majburiy maydon.',
    invalid: 'Qiymat noto‘g‘ri.',
    summary: 'Xatolarni tuzatib, qayta urinib ko‘ring.',
    fields: {
      sku: 'Lotin harflari, raqamlar va . _ - belgilari, 64 tagacha (masalan, MILK-1L).',
      slug: 'Kichik lotin harflari, raqamlar va defis, masalan: sut-mahsulotlari.',
      name_uz: '1 dan 255 tagacha belgi, bitta qatorda.',
      name_ru: '1 dan 255 tagacha belgi, bitta qatorda.',
      description_uz: '5000 belgigacha.',
      description_ru: '5000 belgigacha.',
      category_id: 'Kategoriyani tanlang.',
      parent_id: 'Bunday kategoriya yo‘q yoki u tsikl hosil qiladi.',
      unit: 'O‘lchov birligini tanlang.',
      price_uzs: '0 dan 1 000 000 000 000 gacha butun son.',
      old_price_uzs: 'Joriy narxdan katta butun son yoki bo‘sh qoldiring.',
      stock_quantity: '0 dan 1 000 000 gacha butun son yoki bo‘sh (hisobsiz).',
      sort_order: '−100 000 dan 100 000 gacha butun son.',
      image_url: 'Faqat https:// manzil, 2048 belgigacha, IP va localhost bo‘lmasin.',
      delivery_fee_uzs: '0 dan 1 000 000 000 000 gacha butun son.',
      free_delivery_threshold_uzs: 'Butun son yoki bo‘sh (hech qachon bepul emas).',
      min_order_uzs: '0 dan 1 000 000 000 000 gacha butun son.',
      opens_at: 'SS:DD formatida, masalan 09:00.',
      closes_at: 'SS:DD formatida; ochilish vaqtidan keyin bo‘lishi kerak.',
      districts: 'Kamida bitta tumanni tanlang.',
      zone_id: 'Hududni tanlang.',
      slot_date: 'To‘g‘ri sanani kiriting.',
      starts_at: 'SS:DD formatida, masalan 14:00.',
      ends_at: 'SS:DD formatida; boshlanish vaqtidan keyin bo‘lishi kerak.',
      capacity: '0 dan 10 000 gacha butun son.',
      cutoff_at:
        'Buyurtma qabul qilishni to‘xtatish vaqti oraliq boshlanishidan oldin bo‘lishi kerak.',
    },
  },
  ru: {
    required: 'Обязательное поле.',
    invalid: 'Недопустимое значение.',
    summary: 'Исправьте ошибки и повторите.',
    fields: {
      sku: 'Латинские буквы, цифры и символы . _ -, до 64 знаков (например, MILK-1L).',
      slug: 'Строчные латинские буквы, цифры и дефис, например: molochnye-produkty.',
      name_uz: 'От 1 до 255 символов, в одну строку.',
      name_ru: 'От 1 до 255 символов, в одну строку.',
      description_uz: 'До 5000 символов.',
      description_ru: 'До 5000 символов.',
      category_id: 'Выберите категорию.',
      parent_id: 'Такой категории нет, или получится цикл.',
      unit: 'Выберите единицу измерения.',
      price_uzs: 'Целое число от 0 до 1 000 000 000 000.',
      old_price_uzs: 'Целое число больше текущей цены или оставьте пустым.',
      stock_quantity: 'Целое число от 0 до 1 000 000 или пусто (без учёта остатков).',
      sort_order: 'Целое число от −100 000 до 100 000.',
      image_url: 'Только адрес https://, до 2048 символов, без IP-адреса и localhost.',
      delivery_fee_uzs: 'Целое число от 0 до 1 000 000 000 000.',
      free_delivery_threshold_uzs: 'Целое число или пусто (бесплатной доставки нет).',
      min_order_uzs: 'Целое число от 0 до 1 000 000 000 000.',
      opens_at: 'Формат ЧЧ:ММ, например 09:00.',
      closes_at: 'Формат ЧЧ:ММ; позже времени открытия.',
      districts: 'Выберите хотя бы один район.',
      zone_id: 'Выберите зону.',
      slot_date: 'Введите корректную дату.',
      starts_at: 'Формат ЧЧ:ММ, например 14:00.',
      ends_at: 'Формат ЧЧ:ММ; позже времени начала.',
      capacity: 'Целое число от 0 до 10 000.',
      cutoff_at: 'Приём заказов должен закрываться до начала слота.',
    },
  },
};

const apiErrors: Record<Locale, ApiErrorsDict> = {
  uz: {
    rateLimitedWait: 'Juda ko‘p so‘rov. {seconds} soniyadan keyin qayta urinib ko‘ring.',
    writeFailed: 'Saqlab bo‘lmadi. Qayta urinib ko‘ring.',
    codes: {
      slug_taken: 'Bu slug band. Boshqasini tanlang.',
      sku_taken: 'Bu artikul (SKU) band. Boshqasini kiriting.',
      category_cycle: 'Kategoriya o‘zining ichiga yoki o‘z avlodi ichiga joylanmaydi.',
      category_not_empty:
        'Kategoriyada mahsulotlar yoki ichki kategoriyalar bor. Avval ularni boshqa joyga o‘tkazing.',
      product_archived: 'Mahsulot arxivda. Tahrirlashdan oldin uni tiklang.',
      category_not_found: 'Kategoriya topilmadi. Sahifani yangilang.',
      product_not_found: 'Mahsulot topilmadi. U o‘chirilgan bo‘lishi mumkin.',
      user_not_found: 'Foydalanuvchi topilmadi.',
      last_admin: 'Bu oxirgi faol administrator. Avval boshqa administrator tayinlang.',
      cannot_block_self: 'O‘zingizni bloklab bo‘lmaydi.',
      zone_not_found: 'Hudud topilmadi. Sahifani yangilang.',
      zone_in_use:
        'Hududga buyurtmalar yoki vaqt oraliqlari bog‘langan, o‘chirib bo‘lmaydi. O‘rniga nofaol qiling.',
      district_taken: '«{district}» tumani boshqa hududga biriktirilgan.',
      slot_not_found: 'Vaqt oralig‘i topilmadi. Sahifani yangilang.',
      slot_exists: 'Bu hudud uchun shu sana va boshlanish vaqtida oraliq allaqachon bor.',
      slot_in_use:
        'Oraliqda band qilingan buyurtmalar bor: sana va vaqtni o‘zgartirib yoki o‘chirib bo‘lmaydi.',
      capacity_below_reserved: 'Sig‘im band qilingan joylar sonidan kam bo‘lmasligi kerak.',
      csv_invalid_encoding: 'Fayl UTF-8 kodlashida bo‘lishi kerak.',
      csv_invalid_header: 'CSV sarlavhasi shablonga mos kelmaydi. Shablonni yuklab oling.',
      csv_malformed: 'CSV fayl buzilgan (tirnoqlar yoki ustunlar soni noto‘g‘ri).',
      csv_too_many_rows: 'Faylda 2000 tadan ortiq qator bor. Uni qismlarga bo‘ling.',
      payload_too_large: 'Fayl juda katta (1 MB dan oshmasin).',
      unsupported_media_type: 'Fayl turi qo‘llab-quvvatlanmaydi.',
      validation_error: 'Ma’lumotlar noto‘g‘ri. Maydonlarni tekshiring.',
      conflict: 'Ma’lumot boshqa tomonidan o‘zgartirilgan. Sahifani yangilang.',
      not_found: 'Topilmadi. Sahifani yangilang.',
      csrf_failed: 'Sessiya yangilandi. Amalni qaytadan bajaring.',
    },
  },
  ru: {
    rateLimitedWait: 'Слишком много запросов. Повторите через {seconds} с.',
    writeFailed: 'Не удалось сохранить. Повторите попытку.',
    codes: {
      slug_taken: 'Этот slug занят. Выберите другой.',
      sku_taken: 'Этот артикул (SKU) уже используется. Введите другой.',
      category_cycle: 'Категорию нельзя вложить в саму себя или в своего потомка.',
      category_not_empty: 'В категории есть товары или вложенные категории. Сначала перенесите их.',
      product_archived: 'Товар в архиве. Сначала восстановите его.',
      category_not_found: 'Категория не найдена. Обновите страницу.',
      product_not_found: 'Товар не найден. Возможно, он удалён.',
      user_not_found: 'Пользователь не найден.',
      last_admin: 'Это последний активный администратор. Сначала назначьте другого.',
      cannot_block_self: 'Нельзя заблокировать самого себя.',
      zone_not_found: 'Зона не найдена. Обновите страницу.',
      zone_in_use: 'К зоне привязаны заказы или слоты, удалить её нельзя. Сделайте её неактивной.',
      district_taken: 'Район «{district}» уже входит в другую зону.',
      slot_not_found: 'Слот не найден. Обновите страницу.',
      slot_exists: 'Для этой зоны на эту дату и время начала слот уже есть.',
      slot_in_use:
        'В слоте есть забронированные заказы: менять дату и время или удалять его нельзя.',
      capacity_below_reserved: 'Вместимость не может быть меньше числа забронированных мест.',
      csv_invalid_encoding: 'Файл должен быть в кодировке UTF-8.',
      csv_invalid_header: 'Заголовок CSV не совпадает с шаблоном. Скачайте шаблон.',
      csv_malformed: 'CSV повреждён (кавычки или число столбцов).',
      csv_too_many_rows: 'В файле больше 2000 строк. Разделите его на части.',
      payload_too_large: 'Файл слишком большой (не более 1 МБ).',
      unsupported_media_type: 'Тип файла не поддерживается.',
      validation_error: 'Данные некорректны. Проверьте поля.',
      conflict: 'Данные уже изменены кем-то другим. Обновите страницу.',
      not_found: 'Не найдено. Обновите страницу.',
      csrf_failed: 'Сессия обновлена. Повторите действие.',
    },
  },
};

export const sharedDict = { nav, common, permission, validation, apiErrors };
