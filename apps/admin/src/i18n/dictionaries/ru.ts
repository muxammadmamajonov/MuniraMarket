import { auditDict } from './sections/audit';
import { categoriesDict } from './sections/categories';
import { csvDict } from './sections/csv';
import { dashboardDict } from './sections/dashboard';
import { productsDict } from './sections/products';
import { sharedDict } from './sections/shared';
import { slotsDict } from './sections/slots';
import { usersDict } from './sections/users';
import { zonesDict } from './sections/zones';
import type { Dictionary } from './types';

export const ru: Dictionary = {
  meta: {
    title: 'MuniraMarket Admin',
    description: 'Панель управления MuniraMarket.',
  },
  header: {
    appName: 'MuniraMarket Admin',
    logout: 'Выйти',
    language: { label: 'Язык', names: { uz: 'O‘zbekcha', ru: 'Русский' } },
  },
  auth: {
    checking: 'Проверка…',
    retry: 'Повторить',
    signInTitle: 'Войдите через Telegram',
    signInHint: 'Для работы с заказами войдите под учётной записью сотрудника.',
    notConfiguredTitle: 'Вход не настроен',
    notConfiguredMessage:
      'В этом окружении вход через Telegram не настроен. Обратитесь к администратору.',
    configFailed: 'Не удалось загрузить настройки входа. Попробуйте позже.',
    accessDeniedTitle: 'Доступ запрещён',
    accessDeniedMessage: 'У вашей учётной записи нет доступа к панели управления.',
    accountBlocked: 'Ваша учётная запись заблокирована.',
    rateLimited: 'Слишком много попыток. Попробуйте чуть позже.',
    serviceUnavailable: 'Сервис временно недоступен. Попробуйте чуть позже.',
    sessionFailed: 'Не удалось проверить сессию.',
    callbackSigningIn: 'Выполняется вход…',
    callbackFailed: 'Не удалось войти через Telegram.',
    callbackBack: 'Повторить',
  },
  orders: {
    title: 'Заказы',
    filterLabel: 'Фильтр по статусу',
    filterAll: 'Все',
    loading: 'Загрузка заказов…',
    empty: 'Заказов пока нет.',
    emptyFiltered: 'Заказов с таким статусом нет.',
    columns: {
      number: 'Номер',
      status: 'Статус',
      items: 'Товаров',
      total: 'Сумма',
      created: 'Создан',
    },
    pagination: {
      label: 'Страницы',
      previous: 'Назад',
      next: 'Далее',
      pageOf: 'Страница {page} из {total}',
    },
  },
  order: {
    back: 'К заказам',
    title: 'Заказ {number}',
    notFoundTitle: 'Заказ не найден',
    notFoundMessage: 'Такого заказа нет.',
    loading: 'Загрузка заказа…',
    createdAt: 'Создан',
    deliverySlot: 'Окно доставки',
    payment: 'Способ оплаты',
    items: { title: 'Товары', sku: 'Артикул' },
    totals: { subtotal: 'Сумма товаров', delivery: 'Доставка', total: 'Итого' },
    recipient: { title: 'Получатель', name: 'Имя', phone: 'Телефон' },
    address: {
      title: 'Адрес',
      district: 'Район',
      street: 'Улица',
      house: 'Дом',
      apartment: 'Квартира',
      entrance: 'Подъезд',
      floor: 'Этаж',
      landmark: 'Ориентир',
    },
    comment: 'Комментарий',
    cancelReason: 'Причина отмены',
    timeline: { title: 'История статусов', created: 'Заказ создан', reason: 'Причина' },
    actions: {
      title: 'Действия',
      none: 'Других действий для этого заказа нет.',
      cancel: 'Отменить',
      working: 'Сохранение…',
    },
    cancelDialog: {
      title: 'Отмена заказа',
      description: 'Товары вернутся на склад. Укажите причину (от 3 до 300 символов).',
      reasonLabel: 'Причина отмены',
      reasonInvalid: 'Причина должна содержать от 3 до 300 символов.',
      confirm: 'Отменить заказ',
      dismiss: 'Закрыть',
    },
    notices: {
      conflict:
        'Статус заказа изменил другой сотрудник: сейчас «{status}». Страница обновлена, выберите действие заново.',
      updated: 'Статус заказа обновлён: «{status}».',
    },
    errors: {
      invalidTransition: 'Переход в этот статус невозможен. Обновите заказ.',
      failed: 'Не удалось изменить статус. Попробуйте ещё раз.',
    },
  },
  status: {
    NEW: 'Новый',
    CONFIRMED: 'Подтверждён',
    PICKING: 'Сборка',
    READY_FOR_DELIVERY: 'Готов к доставке',
    OUT_FOR_DELIVERY: 'В пути',
    DELIVERED: 'Доставлен',
    CANCELLED: 'Отменён',
  },
  actions: {
    NEW: 'Отметить новым',
    CONFIRMED: 'Подтвердить',
    PICKING: 'Начать сборку',
    READY_FOR_DELIVERY: 'Готов к доставке',
    OUT_FOR_DELIVERY: 'Передать курьеру',
    DELIVERED: 'Отметить доставленным',
    CANCELLED: 'Отменить заказ',
  },
  roles: {
    customer: 'Клиент',
    operator: 'Оператор',
    admin: 'Администратор',
  },
  payment: {
    cash_on_delivery: 'Наличные при получении',
    card_on_delivery: 'Картой при получении',
  },
  units: {
    piece: 'шт.',
    kg: 'кг',
    g: 'г',
    l: 'л',
    ml: 'мл',
  },
  errors: {
    title: 'Произошла ошибка',
    message: 'Не удалось загрузить данные. Проверьте интернет и повторите попытку.',
    retry: 'Повторить',
    forbidden: 'У вас нет доступа к этим данным.',
    rateLimited: 'Слишком много запросов. Попробуйте чуть позже.',
    serviceUnavailable: 'Сервис временно недоступен. Попробуйте чуть позже.',
  },
  nav: sharedDict.nav.ru,
  common: sharedDict.common.ru,
  permission: sharedDict.permission.ru,
  validation: sharedDict.validation.ru,
  apiErrors: sharedDict.apiErrors.ru,
  dashboard: dashboardDict.ru,
  products: productsDict.ru,
  categories: categoriesDict.ru,
  csv: csvDict.ru,
  zones: zonesDict.ru,
  slots: slotsDict.ru,
  users: usersDict.ru,
  audit: auditDict.ru,
};
