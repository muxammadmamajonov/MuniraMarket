import type { Locale } from '@muniramarket/contracts';

export const AUDIT_ENTITY_TYPES = ['category', 'product', 'catalog', 'user', 'order'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = [
  'category.create',
  'category.update',
  'category.delete',
  'product.create',
  'product.update',
  'product.archive',
  'product.restore',
  'catalog.import',
  'user.role_change',
  'user.block',
  'user.unblock',
  'order.status_change',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditDict {
  title: string;
  entityFilter: string;
  actionFilter: string;
  allEntities: string;
  allActions: string;
  entityIdFilter: string;
  clearEntityId: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  table: string;
  columns: { when: string; actor: string; action: string; entity: string; details: string };
  entities: Record<AuditEntityType, string>;
  actions: Record<AuditAction, string>;
  system: string;
  noDetails: string;
  arrow: string;
  extra: {
    source: string;
    rows: string;
    creates: string;
    updates: string;
    unchanged: string;
    has_reason: string;
    order_number: string;
    sku: string;
    slug: string;
  };
}

export const auditDict: Record<Locale, AuditDict> = {
  uz: {
    title: 'Audit jurnali',
    entityFilter: 'Obyekt turi',
    actionFilter: 'Amal',
    allEntities: 'Barcha obyektlar',
    allActions: 'Barcha amallar',
    entityIdFilter: 'Obyekt: {id}',
    clearEntityId: 'Obyekt filtrini olib tashlash',
    loading: 'Jurnal yuklanmoqda…',
    empty: 'Jurnalda yozuvlar yo‘q.',
    emptyFiltered: 'Filtrga mos yozuv topilmadi.',
    table: 'Audit yozuvlari, yangilari birinchi',
    columns: {
      when: 'Vaqt',
      actor: 'Kim',
      action: 'Amal',
      entity: 'Obyekt',
      details: 'Tafsilotlar',
    },
    entities: {
      category: 'Kategoriya',
      product: 'Mahsulot',
      catalog: 'Katalog',
      user: 'Foydalanuvchi',
      order: 'Buyurtma',
    },
    actions: {
      'category.create': 'Kategoriya yaratildi',
      'category.update': 'Kategoriya o‘zgartirildi',
      'category.delete': 'Kategoriya o‘chirildi',
      'product.create': 'Mahsulot yaratildi',
      'product.update': 'Mahsulot o‘zgartirildi',
      'product.archive': 'Mahsulot arxivlandi',
      'product.restore': 'Mahsulot tiklandi',
      'catalog.import': 'Katalog import qilindi',
      'user.role_change': 'Rol o‘zgartirildi',
      'user.block': 'Foydalanuvchi bloklandi',
      'user.unblock': 'Foydalanuvchi blokdan chiqarildi',
      'order.status_change': 'Buyurtma holati o‘zgardi',
    },
    system: 'Tizim',
    noDetails: '—',
    arrow: '→',
    extra: {
      source: 'manba',
      rows: 'qatorlar',
      creates: 'yangi',
      updates: 'yangilandi',
      unchanged: 'o‘zgarmadi',
      has_reason: 'sabab ko‘rsatilgan',
      order_number: 'buyurtma',
      sku: 'artikul',
      slug: 'slug',
    },
  },
  ru: {
    title: 'Журнал аудита',
    entityFilter: 'Тип объекта',
    actionFilter: 'Действие',
    allEntities: 'Все объекты',
    allActions: 'Все действия',
    entityIdFilter: 'Объект: {id}',
    clearEntityId: 'Снять фильтр по объекту',
    loading: 'Загрузка журнала…',
    empty: 'В журнале пока нет записей.',
    emptyFiltered: 'По фильтрам записей не найдено.',
    table: 'Записи аудита, сначала новые',
    columns: {
      when: 'Время',
      actor: 'Кто',
      action: 'Действие',
      entity: 'Объект',
      details: 'Подробности',
    },
    entities: {
      category: 'Категория',
      product: 'Товар',
      catalog: 'Каталог',
      user: 'Пользователь',
      order: 'Заказ',
    },
    actions: {
      'category.create': 'Категория создана',
      'category.update': 'Категория изменена',
      'category.delete': 'Категория удалена',
      'product.create': 'Товар создан',
      'product.update': 'Товар изменён',
      'product.archive': 'Товар в архиве',
      'product.restore': 'Товар восстановлен',
      'catalog.import': 'Импорт каталога',
      'user.role_change': 'Роль изменена',
      'user.block': 'Пользователь заблокирован',
      'user.unblock': 'Пользователь разблокирован',
      'order.status_change': 'Статус заказа изменён',
    },
    system: 'Система',
    noDetails: '—',
    arrow: '→',
    extra: {
      source: 'источник',
      rows: 'строк',
      creates: 'новых',
      updates: 'обновлено',
      unchanged: 'без изменений',
      has_reason: 'причина указана',
      order_number: 'заказ',
      sku: 'артикул',
      slug: 'slug',
    },
  },
};
