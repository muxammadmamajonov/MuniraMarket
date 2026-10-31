import type { Locale } from '@muniramarket/contracts';

export interface CategoriesDict {
  title: string;
  newCategory: string;
  loading: string;
  empty: string;
  list: string;
  productCount: string;
  childCount: string;
  toggleLabel: string;
  edit: string;
  remove: string;
  created: string;
  saved: string;
  deleted: string;
  dialog: {
    titleNew: string;
    titleEdit: string;
    slug: string;
    nameUz: string;
    nameRu: string;
    parent: string;
    noParent: string;
    sortOrder: string;
    isActive: string;
    imageUrl: string;
    imageHint: string;
    submitNew: string;
    submitEdit: string;
  };
  delete: { title: string; description: string; confirm: string };
}

export const categoriesDict: Record<Locale, CategoriesDict> = {
  uz: {
    title: 'Kategoriyalar',
    newCategory: 'Yangi kategoriya',
    loading: 'Kategoriyalar yuklanmoqda…',
    empty: 'Hozircha kategoriyalar yo‘q. Birinchisini yarating.',
    list: 'Kategoriyalar daraxti',
    productCount: 'Mahsulotlar: {count}',
    childCount: 'Ichki kategoriyalar: {count}',
    toggleLabel: '{name}: faollik',
    edit: 'Tahrirlash',
    remove: 'O‘chirish',
    created: 'Kategoriya yaratildi.',
    saved: 'Kategoriya saqlandi.',
    deleted: 'Kategoriya o‘chirildi.',
    dialog: {
      titleNew: 'Yangi kategoriya',
      titleEdit: 'Kategoriyani tahrirlash',
      slug: 'Slug',
      nameUz: 'Nomi (o‘zbekcha)',
      nameRu: 'Nomi (ruscha)',
      parent: 'Ota-kategoriya',
      noParent: 'Yuqori daraja (ota-kategoriyasiz)',
      sortOrder: 'Saralash tartibi',
      isActive: 'Do‘konda ko‘rsatilsin',
      imageUrl: 'Rasm manzili',
      imageHint: 'Faqat https:// bilan boshlanadigan manzil.',
      submitNew: 'Yaratish',
      submitEdit: 'Saqlash',
    },
    delete: {
      title: 'Kategoriyani o‘chirish',
      description:
        '«{name}» kategoriyasi o‘chiriladi. Bu amalni qaytarib bo‘lmaydi. Ichida mahsulot yoki ichki kategoriya bo‘lsa, o‘chirilmaydi.',
      confirm: 'O‘chirish',
    },
  },
  ru: {
    title: 'Категории',
    newCategory: 'Новая категория',
    loading: 'Загрузка категорий…',
    empty: 'Категорий пока нет. Создайте первую.',
    list: 'Дерево категорий',
    productCount: 'Товаров: {count}',
    childCount: 'Вложенных: {count}',
    toggleLabel: '{name}: активность',
    edit: 'Изменить',
    remove: 'Удалить',
    created: 'Категория создана.',
    saved: 'Категория сохранена.',
    deleted: 'Категория удалена.',
    dialog: {
      titleNew: 'Новая категория',
      titleEdit: 'Редактирование категории',
      slug: 'Slug',
      nameUz: 'Название (узбекский)',
      nameRu: 'Название (русский)',
      parent: 'Родительская категория',
      noParent: 'Верхний уровень (без родителя)',
      sortOrder: 'Порядок сортировки',
      isActive: 'Показывать в магазине',
      imageUrl: 'Адрес изображения',
      imageHint: 'Только адрес, начинающийся с https://.',
      submitNew: 'Создать',
      submitEdit: 'Сохранить',
    },
    delete: {
      title: 'Удалить категорию',
      description:
        'Категория «{name}» будет удалена. Это действие нельзя отменить. Если в ней есть товары или вложенные категории, удалить её не получится.',
      confirm: 'Удалить',
    },
  },
};
