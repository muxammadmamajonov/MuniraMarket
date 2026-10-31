import type { Locale } from '@muniramarket/contracts';

export interface ZonesDict {
  title: string;
  newZone: string;
  loading: string;
  empty: string;
  list: string;
  fee: string;
  freeFrom: string;
  neverFree: string;
  minOrder: string;
  hours: string;
  districts: string;
  edit: string;
  remove: string;
  created: string;
  saved: string;
  deleted: string;
  form: {
    titleNew: string;
    titleEdit: string;
    slug: string;
    nameUz: string;
    nameRu: string;
    fee: string;
    freeThreshold: string;
    freeThresholdHint: string;
    minOrder: string;
    opensAt: string;
    closesAt: string;
    sortOrder: string;
    isActive: string;
    districts: string;
    districtsHint: string;
    districtTaken: string;
    submitNew: string;
    submitEdit: string;
    noChanges: string;
  };
  delete: { title: string; description: string; confirm: string };
}

export const zonesDict: Record<Locale, ZonesDict> = {
  uz: {
    title: 'Yetkazib berish hududlari',
    newZone: 'Yangi hudud',
    loading: 'Hududlar yuklanmoqda…',
    empty: 'Hozircha hududlar yo‘q. Birinchisini yarating.',
    list: 'Hududlar ro‘yxati',
    fee: 'Yetkazish narxi',
    freeFrom: 'Bepul: {amount} dan',
    neverFree: 'Hech qachon bepul emas',
    minOrder: 'Minimal buyurtma',
    hours: 'Ish vaqti',
    districts: 'Tumanlar',
    edit: 'Tahrirlash',
    remove: 'O‘chirish',
    created: 'Hudud yaratildi.',
    saved: 'Hudud saqlandi.',
    deleted: 'Hudud o‘chirildi.',
    form: {
      titleNew: 'Yangi hudud',
      titleEdit: 'Hududni tahrirlash',
      slug: 'Slug',
      nameUz: 'Nomi (o‘zbekcha)',
      nameRu: 'Nomi (ruscha)',
      fee: 'Yetkazish narxi (so‘m)',
      freeThreshold: 'Bepul yetkazish chegarasi (so‘m)',
      freeThresholdHint: 'Bo‘sh qoldirilsa, yetkazish hech qachon bepul bo‘lmaydi.',
      minOrder: 'Minimal buyurtma (so‘m)',
      opensAt: 'Ochilish vaqti',
      closesAt: 'Yopilish vaqti',
      sortOrder: 'Saralash tartibi',
      isActive: 'Faol (yetkazib beradi)',
      districts: 'Tumanlar',
      districtsHint: 'Har bir tuman bittagina hududga tegishli bo‘la oladi.',
      districtTaken: 'band: {zone}',
      submitNew: 'Hududni yaratish',
      submitEdit: 'Saqlash',
      noChanges: 'O‘zgarishlar yo‘q.',
    },
    delete: {
      title: 'Hududni o‘chirish',
      description:
        '«{name}» hududi o‘chiriladi. Unga buyurtmalar yoki vaqt oraliqlari bog‘langan bo‘lsa, o‘chirilmaydi — o‘rniga uni nofaol qiling.',
      confirm: 'O‘chirish',
    },
  },
  ru: {
    title: 'Зоны доставки',
    newZone: 'Новая зона',
    loading: 'Загрузка зон…',
    empty: 'Зон пока нет. Создайте первую.',
    list: 'Список зон',
    fee: 'Стоимость доставки',
    freeFrom: 'Бесплатно от {amount}',
    neverFree: 'Бесплатной доставки нет',
    minOrder: 'Минимальный заказ',
    hours: 'Часы работы',
    districts: 'Районы',
    edit: 'Изменить',
    remove: 'Удалить',
    created: 'Зона создана.',
    saved: 'Зона сохранена.',
    deleted: 'Зона удалена.',
    form: {
      titleNew: 'Новая зона',
      titleEdit: 'Редактирование зоны',
      slug: 'Slug',
      nameUz: 'Название (узбекский)',
      nameRu: 'Название (русский)',
      fee: 'Стоимость доставки (сум)',
      freeThreshold: 'Порог бесплатной доставки (сум)',
      freeThresholdHint: 'Если оставить пустым, доставка никогда не бесплатная.',
      minOrder: 'Минимальный заказ (сум)',
      opensAt: 'Время открытия',
      closesAt: 'Время закрытия',
      sortOrder: 'Порядок сортировки',
      isActive: 'Активна (доставляет)',
      districts: 'Районы',
      districtsHint: 'Каждый район может входить только в одну зону.',
      districtTaken: 'занят: {zone}',
      submitNew: 'Создать зону',
      submitEdit: 'Сохранить',
      noChanges: 'Изменений нет.',
    },
    delete: {
      title: 'Удалить зону',
      description:
        'Зона «{name}» будет удалена. Если к ней привязаны заказы или слоты, удалить её нельзя — сделайте её неактивной.',
      confirm: 'Удалить',
    },
  },
};
