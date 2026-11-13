import type { Locale } from '@muniramarket/contracts';

export interface DashboardDict {
  title: string;
  asOf: string;
  refresh: string;
  loading: string;
  ordersToday: string;
  newOrders: string;
  newOrdersHint: string;
  gmv: string;
  gmvHint: string;
  averageOrderValue: string;
  cancelledToday: string;
  recentTitle: string;
  recentAll: string;
}

export const dashboardDict: Record<Locale, DashboardDict> = {
  uz: {
    title: 'Bugungi ko‘rsatkichlar',
    asOf: '{date} holatiga, Toshkent vaqti',
    refresh: 'Yangilash',
    loading: 'Ko‘rsatkichlar yuklanmoqda…',
    ordersToday: 'Bugungi buyurtmalar',
    newOrders: 'Yangi buyurtmalar',
    newOrdersHint: 'Hozir qayta ishlashni kutmoqda — ko‘rish',
    gmv: 'Bugungi savdo hajmi',
    gmvHint: 'Bekor qilinganlarsiz',
    averageOrderValue: 'O‘rtacha chek',
    cancelledToday: 'Bugun bekor qilinganlar',
    recentTitle: 'So‘nggi buyurtmalar',
    recentAll: 'Barchasi',
  },
  ru: {
    title: 'Показатели за сегодня',
    asOf: 'На {date}, время Ташкента',
    refresh: 'Обновить',
    loading: 'Загрузка показателей…',
    ordersToday: 'Заказов сегодня',
    newOrders: 'Новые заказы',
    newOrdersHint: 'Ждут обработки сейчас — открыть',
    gmv: 'Оборот за сегодня',
    gmvHint: 'Без отменённых',
    averageOrderValue: 'Средний чек',
    cancelledToday: 'Отменено сегодня',
    recentTitle: 'Последние заказы',
    recentAll: 'Все',
  },
};
