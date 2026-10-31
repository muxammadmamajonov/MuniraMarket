import type { Locale } from '@muniramarket/contracts';

export type ProductStatusChoice = 'default' | 'active' | 'inactive' | 'archived' | 'all';

export interface ProductsDict {
  title: string;
  newProduct: string;
  searchLabel: string;
  searchPlaceholder: string;
  statusFilterLabel: string;
  statusChoices: Record<ProductStatusChoice, string>;
  categoryFilterLabel: string;
  allCategories: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  table: string;
  columns: {
    name: string;
    sku: string;
    category: string;
    price: string;
    stock: string;
    status: string;
  };
  stockUntracked: string;
  oldPrice: string;
  badge: { active: string; inactive: string; archived: string };
  form: {
    titleNew: string;
    titleEdit: string;
    back: string;
    notFoundTitle: string;
    notFoundMessage: string;
    loading: string;
    languageUz: string;
    languageRu: string;
    sections: { identity: string; pricing: string; image: string };
    fields: {
      sku: string;
      slug: string;
      slugHint: string;
      nameUz: string;
      nameRu: string;
      descriptionUz: string;
      descriptionRu: string;
      category: string;
      categoryPlaceholder: string;
      unit: string;
      price: string;
      oldPrice: string;
      oldPriceHint: string;
      stock: string;
      stockHint: string;
      sortOrder: string;
      sortOrderHint: string;
      imageUrl: string;
      imageHint: string;
      isActive: string;
      isActiveHint: string;
    };
    preview: string;
    previewAlt: string;
    previewUnavailable: string;
    previewDisabled: string;
    submitNew: string;
    submitEdit: string;
    created: string;
    saved: string;
    noChanges: string;
    archivedBanner: string;
    archive: { button: string; title: string; description: string; confirm: string };
    restore: { button: string; hint: string; done: string };
    noCategories: string;
  };
}

export const productsDict: Record<Locale, ProductsDict> = {
  uz: {
    title: 'Mahsulotlar',
    newProduct: 'Yangi mahsulot',
    searchLabel: 'Mahsulotlarni qidirish',
    searchPlaceholder: 'Nomi, artikul yoki slug',
    statusFilterLabel: 'Holat bo‘yicha filtr',
    statusChoices: {
      default: 'Faol va nofaol',
      active: 'Faol',
      inactive: 'Nofaol',
      archived: 'Arxivlangan',
      all: 'Hammasi',
    },
    categoryFilterLabel: 'Kategoriya',
    allCategories: 'Barcha kategoriyalar',
    loading: 'Mahsulotlar yuklanmoqda…',
    empty: 'Hozircha mahsulotlar yo‘q.',
    emptyFiltered: 'Filtrga mos mahsulot topilmadi.',
    table: 'Mahsulotlar ro‘yxati',
    columns: {
      name: 'Nomi',
      sku: 'Artikul',
      category: 'Kategoriya',
      price: 'Narxi',
      stock: 'Qoldiq',
      status: 'Holat',
    },
    stockUntracked: 'Hisobsiz',
    oldPrice: 'Eski narx: {price}',
    badge: { active: 'Faol', inactive: 'Nofaol', archived: 'Arxivda' },
    form: {
      titleNew: 'Yangi mahsulot',
      titleEdit: 'Mahsulotni tahrirlash',
      back: 'Mahsulotlarga qaytish',
      notFoundTitle: 'Mahsulot topilmadi',
      notFoundMessage: 'Bunday mahsulot yo‘q.',
      loading: 'Mahsulot yuklanmoqda…',
      languageUz: 'O‘zbekcha',
      languageRu: 'Русский',
      sections: { identity: 'Asosiy ma’lumotlar', pricing: 'Narx va qoldiq', image: 'Rasm' },
      fields: {
        sku: 'Artikul (SKU)',
        slug: 'Slug',
        slugHint: 'Artikuldan avtomatik taklif qilinadi; o‘zgartirsangiz, shunday qoladi.',
        nameUz: 'Nomi (o‘zbekcha)',
        nameRu: 'Nomi (ruscha)',
        descriptionUz: 'Tavsif (o‘zbekcha)',
        descriptionRu: 'Tavsif (ruscha)',
        category: 'Kategoriya',
        categoryPlaceholder: 'Kategoriyani tanlang',
        unit: 'O‘lchov birligi',
        price: 'Narxi (so‘m)',
        oldPrice: 'Eski narx (so‘m)',
        oldPriceHint: 'Chegirmani ko‘rsatish uchun: joriy narxdan katta bo‘lishi kerak.',
        stock: 'Qoldiq',
        stockHint: 'Bo‘sh qoldirilsa, qoldiq hisobga olinmaydi (cheksiz).',
        sortOrder: 'Saralash tartibi',
        sortOrderHint: 'Kichik raqam yuqorida turadi.',
        imageUrl: 'Rasm manzili',
        imageHint:
          'Faqat https:// bilan boshlanadigan manzil. Server rasmni yuklamaydi, faqat manzilni saqlaydi.',
        isActive: 'Do‘konda ko‘rsatilsin',
        isActiveHint: 'O‘chirilsa, mahsulot xaridorlarga ko‘rinmaydi.',
      },
      preview: 'Ko‘rinishi',
      previewAlt: 'Mahsulot rasmi',
      previewUnavailable:
        'Rasm ko‘rsatilmadi: manzil noto‘g‘ri bo‘lishi yoki rasm bu panelda ochilmasligi mumkin.',
      previewDisabled:
        'Rasm ko‘rinishi rasm saqlash yoqilgandan keyin paydo bo‘ladi. Manzil baribir saqlanadi.',
      submitNew: 'Mahsulotni yaratish',
      submitEdit: 'Saqlash',
      created: 'Mahsulot yaratildi.',
      saved: 'Mahsulot saqlandi.',
      noChanges: 'O‘zgarishlar yo‘q.',
      archivedBanner: 'Mahsulot arxivda. Tahrirlash uchun avval uni tiklang.',
      archive: {
        button: 'Arxivlash',
        title: 'Mahsulotni arxivlash',
        description:
          'Mahsulot do‘kondan yashiriladi va nofaol bo‘ladi. Bu o‘chirish emas: buyurtmalar tarixi saqlanadi va mahsulotni istalgan vaqt tiklash mumkin.',
        confirm: 'Arxivlash',
      },
      restore: {
        button: 'Tiklash',
        hint: 'Tiklangan mahsulot nofaol bo‘ladi: tekshirib, keyin faollashtiring.',
        done: 'Mahsulot tiklandi (nofaol).',
      },
      noCategories: 'Avval kamida bitta kategoriya yarating.',
    },
  },
  ru: {
    title: 'Товары',
    newProduct: 'Новый товар',
    searchLabel: 'Поиск товаров',
    searchPlaceholder: 'Название, артикул или slug',
    statusFilterLabel: 'Фильтр по статусу',
    statusChoices: {
      default: 'Активные и неактивные',
      active: 'Активные',
      inactive: 'Неактивные',
      archived: 'В архиве',
      all: 'Все',
    },
    categoryFilterLabel: 'Категория',
    allCategories: 'Все категории',
    loading: 'Загрузка товаров…',
    empty: 'Товаров пока нет.',
    emptyFiltered: 'По фильтрам ничего не найдено.',
    table: 'Список товаров',
    columns: {
      name: 'Название',
      sku: 'Артикул',
      category: 'Категория',
      price: 'Цена',
      stock: 'Остаток',
      status: 'Статус',
    },
    stockUntracked: 'Без учёта',
    oldPrice: 'Старая цена: {price}',
    badge: { active: 'Активен', inactive: 'Неактивен', archived: 'В архиве' },
    form: {
      titleNew: 'Новый товар',
      titleEdit: 'Редактирование товара',
      back: 'К списку товаров',
      notFoundTitle: 'Товар не найден',
      notFoundMessage: 'Такого товара нет.',
      loading: 'Загрузка товара…',
      languageUz: 'O‘zbekcha',
      languageRu: 'Русский',
      sections: { identity: 'Основное', pricing: 'Цена и остаток', image: 'Изображение' },
      fields: {
        sku: 'Артикул (SKU)',
        slug: 'Slug',
        slugHint: 'Подставляется из артикула; если изменить вручную, останется как есть.',
        nameUz: 'Название (узбекский)',
        nameRu: 'Название (русский)',
        descriptionUz: 'Описание (узбекский)',
        descriptionRu: 'Описание (русский)',
        category: 'Категория',
        categoryPlaceholder: 'Выберите категорию',
        unit: 'Единица измерения',
        price: 'Цена (сум)',
        oldPrice: 'Старая цена (сум)',
        oldPriceHint: 'Чтобы показать скидку: должна быть больше текущей цены.',
        stock: 'Остаток',
        stockHint: 'Если оставить пустым, остаток не учитывается (без ограничений).',
        sortOrder: 'Порядок сортировки',
        sortOrderHint: 'Меньшее число — выше в списке.',
        imageUrl: 'Адрес изображения',
        imageHint:
          'Только адрес, начинающийся с https://. Сервер не загружает изображение, а лишь хранит адрес.',
        isActive: 'Показывать в магазине',
        isActiveHint: 'Если выключить, покупатели не увидят товар.',
      },
      preview: 'Предпросмотр',
      previewAlt: 'Изображение товара',
      previewUnavailable:
        'Изображение не показано: адрес может быть неверным или картинка не открывается в этой панели.',
      previewDisabled:
        'Предпросмотр появится после включения хранилища изображений. Адрес всё равно сохранится.',
      submitNew: 'Создать товар',
      submitEdit: 'Сохранить',
      created: 'Товар создан.',
      saved: 'Товар сохранён.',
      noChanges: 'Изменений нет.',
      archivedBanner: 'Товар в архиве. Чтобы редактировать, сначала восстановите его.',
      archive: {
        button: 'В архив',
        title: 'Архивировать товар',
        description:
          'Товар скроется из магазина и станет неактивным. Это не удаление: история заказов сохранится, а товар можно восстановить в любой момент.',
        confirm: 'Архивировать',
      },
      restore: {
        button: 'Восстановить',
        hint: 'Восстановленный товар будет неактивным: проверьте его и затем включите.',
        done: 'Товар восстановлен (неактивен).',
      },
      noCategories: 'Сначала создайте хотя бы одну категорию.',
    },
  },
};
