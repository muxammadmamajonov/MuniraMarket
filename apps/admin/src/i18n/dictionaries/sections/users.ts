import type { Locale } from '@muniramarket/contracts';

export interface UsersDict {
  title: string;
  searchLabel: string;
  searchPlaceholder: string;
  roleFilterLabel: string;
  blockedFilterLabel: string;
  blockedChoices: { all: string; blocked: string; active: string };
  loading: string;
  empty: string;
  emptyFiltered: string;
  table: string;
  columns: { user: string; role: string; status: string; actions: string };
  telegramId: string;
  noName: string;
  blockedBadge: string;
  activeBadge: string;
  changeRole: string;
  block: string;
  unblock: string;
  roleDialog: {
    title: string;
    description: string;
    select: string;
    confirm: string;
    unchanged: string;
  };
  blockDialog: { title: string; description: string; confirm: string };
  unblockDialog: { title: string; description: string; confirm: string };
  roleChanged: string;
  blocked: string;
  unblocked: string;
}

export const usersDict: Record<Locale, UsersDict> = {
  uz: {
    title: 'Foydalanuvchilar',
    searchLabel: 'Foydalanuvchilarni qidirish',
    searchPlaceholder: 'Ism, username yoki Telegram ID',
    roleFilterLabel: 'Rol bo‘yicha filtr',
    blockedFilterLabel: 'Holat bo‘yicha filtr',
    blockedChoices: { all: 'Hammasi', blocked: 'Bloklangan', active: 'Bloklanmagan' },
    loading: 'Foydalanuvchilar yuklanmoqda…',
    empty: 'Foydalanuvchilar yo‘q.',
    emptyFiltered: 'Filtrga mos foydalanuvchi topilmadi.',
    table: 'Foydalanuvchilar ro‘yxati',
    columns: { user: 'Foydalanuvchi', role: 'Rol', status: 'Holat', actions: 'Amallar' },
    telegramId: 'Telegram ID',
    noName: 'Ismsiz foydalanuvchi',
    blockedBadge: 'Bloklangan',
    activeBadge: 'Faol',
    changeRole: 'Rolni o‘zgartirish',
    block: 'Bloklash',
    unblock: 'Blokdan chiqarish',
    roleDialog: {
      title: 'Rolni o‘zgartirish',
      description:
        '{name} uchun yangi rolni tanlang. Rol darhol kuchga kiradi: administrator katalog, yetkazib berish va foydalanuvchilarni boshqara oladi.',
      select: 'Yangi rol',
      confirm: 'Rolni o‘zgartirish',
      unchanged: 'Joriy rol: {role}. Boshqa rolni tanlang.',
    },
    blockDialog: {
      title: 'Foydalanuvchini bloklash',
      description:
        '{name} tizimga kira olmaydi va yangi buyurtma bera olmaydi. Keyin blokdan chiqarish mumkin.',
      confirm: 'Bloklash',
    },
    unblockDialog: {
      title: 'Blokdan chiqarish',
      description: '{name} yana tizimga kira oladi.',
      confirm: 'Blokdan chiqarish',
    },
    roleChanged: 'Rol o‘zgartirildi.',
    blocked: 'Foydalanuvchi bloklandi.',
    unblocked: 'Foydalanuvchi blokdan chiqarildi.',
  },
  ru: {
    title: 'Пользователи',
    searchLabel: 'Поиск пользователей',
    searchPlaceholder: 'Имя, username или Telegram ID',
    roleFilterLabel: 'Фильтр по роли',
    blockedFilterLabel: 'Фильтр по статусу',
    blockedChoices: { all: 'Все', blocked: 'Заблокированные', active: 'Не заблокированные' },
    loading: 'Загрузка пользователей…',
    empty: 'Пользователей нет.',
    emptyFiltered: 'По фильтрам никого не найдено.',
    table: 'Список пользователей',
    columns: { user: 'Пользователь', role: 'Роль', status: 'Статус', actions: 'Действия' },
    telegramId: 'Telegram ID',
    noName: 'Пользователь без имени',
    blockedBadge: 'Заблокирован',
    activeBadge: 'Активен',
    changeRole: 'Сменить роль',
    block: 'Заблокировать',
    unblock: 'Разблокировать',
    roleDialog: {
      title: 'Смена роли',
      description:
        'Выберите новую роль для {name}. Она вступает в силу сразу: администратор управляет каталогом, доставкой и пользователями.',
      select: 'Новая роль',
      confirm: 'Сменить роль',
      unchanged: 'Текущая роль: {role}. Выберите другую.',
    },
    blockDialog: {
      title: 'Блокировка пользователя',
      description: '{name} не сможет войти и оформлять заказы. Позже его можно разблокировать.',
      confirm: 'Заблокировать',
    },
    unblockDialog: {
      title: 'Разблокировка',
      description: '{name} снова сможет войти.',
      confirm: 'Разблокировать',
    },
    roleChanged: 'Роль изменена.',
    blocked: 'Пользователь заблокирован.',
    unblocked: 'Пользователь разблокирован.',
  },
};
