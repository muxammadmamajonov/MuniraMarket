import type { Locale } from '@muniramarket/contracts';

export interface SlotsDict {
  title: string;
  newSlot: string;
  filtersLabel: string;
  zone: string;
  allZones: string;
  from: string;
  to: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  truncated: string;
  dayList: string;
  slotsOfDay: string;
  reserved: string;
  remaining: string;
  full: string;
  cutoff: string;
  toggleLabel: string;
  edit: string;
  remove: string;
  created: string;
  saved: string;
  deleted: string;
  noZones: string;
  form: {
    titleNew: string;
    titleEdit: string;
    zone: string;
    zonePlaceholder: string;
    date: string;
    startsAt: string;
    endsAt: string;
    capacity: string;
    capacityHint: string;
    cutoff: string;
    cutoffHint: string;
    isActive: string;
    lockedHint: string;
    submitNew: string;
    submitEdit: string;
    noChanges: string;
  };
  delete: { title: string; description: string; confirm: string };
}

export const slotsDict: Record<Locale, SlotsDict> = {
  uz: {
    title: 'Yetkazib berish vaqt oraliqlari',
    newSlot: 'Yangi oraliq',
    filtersLabel: 'Oraliqlar filtri',
    zone: 'Hudud',
    allZones: 'Barcha hududlar',
    from: 'Sanadan',
    to: 'Sanagacha',
    loading: 'Oraliqlar yuklanmoqda…',
    empty: 'Hozircha oraliqlar yo‘q.',
    emptyFiltered: 'Tanlangan hudud va sanalar uchun oraliqlar yo‘q.',
    truncated: 'Ro‘yxat qisqartirilgan. Ko‘proq ko‘rish uchun sana oralig‘ini toraytiring.',
    dayList: 'Oraliqlar sanalar bo‘yicha',
    slotsOfDay: '{date} kuni oraliqlari',
    reserved: 'Band: {reserved} / {capacity}',
    remaining: 'Bo‘sh: {count}',
    full: 'To‘lgan',
    cutoff: 'Buyurtma qabul qilish: {time} gacha',
    toggleLabel: '{time}: faollik',
    edit: 'Tahrirlash',
    remove: 'O‘chirish',
    created: 'Oraliq yaratildi.',
    saved: 'Oraliq saqlandi.',
    deleted: 'Oraliq o‘chirildi.',
    noZones: 'Avval yetkazib berish hududini yarating.',
    form: {
      titleNew: 'Yangi oraliq',
      titleEdit: 'Oraliqni tahrirlash',
      zone: 'Hudud',
      zonePlaceholder: 'Hududni tanlang',
      date: 'Sana',
      startsAt: 'Boshlanishi',
      endsAt: 'Tugashi',
      capacity: 'Sig‘im (buyurtmalar soni)',
      capacityHint: 'Band qilingan joylar sonidan kam bo‘lmasin.',
      cutoff: 'Buyurtma qabul qilishni to‘xtatish',
      cutoffHint: 'Toshkent vaqti. Odatda oraliq boshlanishidan 2 soat oldin.',
      isActive: 'Faol (xaridorlarga ko‘rinadi)',
      lockedHint:
        'Hudud, sana va vaqtni o‘zgartirib bo‘lmaydi: kerak bo‘lsa, yangi oraliq yarating.',
      submitNew: 'Oraliqni yaratish',
      submitEdit: 'Saqlash',
      noChanges: 'O‘zgarishlar yo‘q.',
    },
    delete: {
      title: 'Oraliqni o‘chirish',
      description:
        '{date}, {time} oralig‘i o‘chiriladi. Unda band qilingan buyurtmalar bo‘lsa, o‘chirilmaydi.',
      confirm: 'O‘chirish',
    },
  },
  ru: {
    title: 'Слоты доставки',
    newSlot: 'Новый слот',
    filtersLabel: 'Фильтры слотов',
    zone: 'Зона',
    allZones: 'Все зоны',
    from: 'С даты',
    to: 'По дату',
    loading: 'Загрузка слотов…',
    empty: 'Слотов пока нет.',
    emptyFiltered: 'Для выбранной зоны и дат слотов нет.',
    truncated: 'Список сокращён. Сузьте диапазон дат, чтобы увидеть больше.',
    dayList: 'Слоты по датам',
    slotsOfDay: 'Слоты на {date}',
    reserved: 'Занято: {reserved} из {capacity}',
    remaining: 'Свободно: {count}',
    full: 'Заполнен',
    cutoff: 'Приём заказов до {time}',
    toggleLabel: '{time}: активность',
    edit: 'Изменить',
    remove: 'Удалить',
    created: 'Слот создан.',
    saved: 'Слот сохранён.',
    deleted: 'Слот удалён.',
    noZones: 'Сначала создайте зону доставки.',
    form: {
      titleNew: 'Новый слот',
      titleEdit: 'Редактирование слота',
      zone: 'Зона',
      zonePlaceholder: 'Выберите зону',
      date: 'Дата',
      startsAt: 'Начало',
      endsAt: 'Конец',
      capacity: 'Вместимость (число заказов)',
      capacityHint: 'Не меньше числа уже занятых мест.',
      cutoff: 'Закрытие приёма заказов',
      cutoffHint: 'Время Ташкента. По умолчанию за 2 часа до начала слота.',
      isActive: 'Активен (виден покупателям)',
      lockedHint: 'Зону, дату и время изменить нельзя: при необходимости создайте новый слот.',
      submitNew: 'Создать слот',
      submitEdit: 'Сохранить',
      noChanges: 'Изменений нет.',
    },
    delete: {
      title: 'Удалить слот',
      description:
        'Слот {date}, {time} будет удалён. Если в нём есть забронированные заказы, удалить его нельзя.',
      confirm: 'Удалить',
    },
  },
};
