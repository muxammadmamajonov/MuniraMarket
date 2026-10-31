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

export const uz: Dictionary = {
  meta: {
    title: 'MuniraMarket Admin',
    description: 'MuniraMarket boshqaruv paneli.',
  },
  header: {
    appName: 'MuniraMarket Admin',
    logout: 'Chiqish',
    language: { label: 'Til', names: { uz: 'O‘zbekcha', ru: 'Русский' } },
  },
  auth: {
    checking: 'Tekshirilmoqda…',
    retry: 'Qayta urinish',
    signInTitle: 'Telegram orqali kiring',
    signInHint: 'Buyurtmalarni boshqarish uchun xodim hisobingiz bilan kiring.',
    notConfiguredTitle: 'Kirish sozlanmagan',
    notConfiguredMessage:
      'Bu muhitda Telegram orqali kirish sozlanmagan. Administratorga murojaat qiling.',
    configFailed: 'Kirish sozlamalarini yuklab bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.',
    accessDeniedTitle: 'Ruxsat yo‘q',
    accessDeniedMessage: 'Sizning hisobingizda boshqaruv paneliga kirish huquqi yo‘q.',
    accountBlocked: 'Hisobingiz bloklangan.',
    rateLimited: 'Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.',
    serviceUnavailable: 'Xizmat vaqtincha ishlamayapti. Birozdan keyin qayta urinib ko‘ring.',
    sessionFailed: 'Sessiyani tekshirib bo‘lmadi.',
    callbackSigningIn: 'Kirilmoqda…',
    callbackFailed: 'Telegram orqali kirib bo‘lmadi.',
    callbackBack: 'Qayta urinish',
  },
  orders: {
    title: 'Buyurtmalar',
    filterLabel: 'Holat bo‘yicha filtr',
    filterAll: 'Hammasi',
    loading: 'Buyurtmalar yuklanmoqda…',
    empty: 'Hozircha buyurtmalar yo‘q.',
    emptyFiltered: 'Bu holatdagi buyurtmalar yo‘q.',
    columns: {
      number: 'Raqam',
      status: 'Holat',
      items: 'Mahsulotlar',
      total: 'Jami',
      created: 'Yaratilgan',
    },
    pagination: {
      label: 'Sahifalar',
      previous: 'Oldingi',
      next: 'Keyingi',
      pageOf: '{page}-sahifa / {total}',
    },
  },
  order: {
    back: 'Buyurtmalarga qaytish',
    title: 'Buyurtma {number}',
    notFoundTitle: 'Buyurtma topilmadi',
    notFoundMessage: 'Bunday buyurtma yo‘q.',
    loading: 'Buyurtma yuklanmoqda…',
    createdAt: 'Yaratilgan',
    deliverySlot: 'Yetkazib berish oralig‘i',
    payment: 'To‘lov usuli',
    items: { title: 'Mahsulotlar', sku: 'Artikul' },
    totals: { subtotal: 'Mahsulotlar summasi', delivery: 'Yetkazib berish', total: 'Jami' },
    recipient: { title: 'Qabul qiluvchi', name: 'Ism', phone: 'Telefon' },
    address: {
      title: 'Manzil',
      district: 'Tuman',
      street: 'Ko‘cha',
      house: 'Uy',
      apartment: 'Xonadon',
      entrance: 'Kirish',
      floor: 'Qavat',
      landmark: 'Mo‘ljal',
    },
    comment: 'Izoh',
    cancelReason: 'Bekor qilish sababi',
    timeline: { title: 'Holatlar tarixi', created: 'Buyurtma yaratildi', reason: 'Sabab' },
    actions: {
      title: 'Amallar',
      none: 'Bu buyurtma uchun boshqa amallar yo‘q.',
      cancel: 'Bekor qilish',
      working: 'Saqlanmoqda…',
    },
    cancelDialog: {
      title: 'Buyurtmani bekor qilish',
      description: 'Mahsulotlar omborga qaytariladi. Sababni yozing (3–300 belgi).',
      reasonLabel: 'Bekor qilish sababi',
      reasonInvalid: 'Sabab 3 tadan 300 tagacha belgidan iborat bo‘lishi kerak.',
      confirm: 'Buyurtmani bekor qilish',
      dismiss: 'Yopish',
    },
    notices: {
      conflict:
        'Buyurtma holati boshqa xodim tomonidan o‘zgartirilgan: hozir «{status}». Sahifa yangilandi, amalni qaytadan tanlang.',
      updated: 'Buyurtma holati yangilandi: «{status}».',
    },
    errors: {
      invalidTransition: 'Bu holatga o‘tish mumkin emas. Buyurtmani yangilang.',
      failed: 'Holatni o‘zgartirib bo‘lmadi. Qayta urinib ko‘ring.',
    },
  },
  status: {
    NEW: 'Yangi',
    CONFIRMED: 'Tasdiqlangan',
    PICKING: 'Yig‘ilmoqda',
    READY_FOR_DELIVERY: 'Yetkazishga tayyor',
    OUT_FOR_DELIVERY: 'Yo‘lda',
    DELIVERED: 'Yetkazilgan',
    CANCELLED: 'Bekor qilingan',
  },
  actions: {
    NEW: 'Yangi deb belgilash',
    CONFIRMED: 'Tasdiqlash',
    PICKING: 'Yig‘ishni boshlash',
    READY_FOR_DELIVERY: 'Yetkazishga tayyor',
    OUT_FOR_DELIVERY: 'Kuryerga topshirish',
    DELIVERED: 'Yetkazildi deb belgilash',
    CANCELLED: 'Bekor qilish',
  },
  roles: {
    customer: 'Mijoz',
    operator: 'Operator',
    admin: 'Administrator',
  },
  payment: {
    cash_on_delivery: 'Naqd pul (yetkazilganda)',
    card_on_delivery: 'Karta (yetkazilganda)',
  },
  units: {
    piece: 'dona',
    kg: 'kg',
    g: 'g',
    l: 'l',
    ml: 'ml',
  },
  errors: {
    title: 'Xatolik yuz berdi',
    message: 'Ma’lumotlarni yuklab bo‘lmadi. Internetni tekshirib, qayta urinib ko‘ring.',
    retry: 'Qayta urinish',
    forbidden: 'Bu ma’lumotlarni ko‘rish huquqingiz yo‘q.',
    rateLimited: 'Juda ko‘p so‘rov. Birozdan keyin qayta urinib ko‘ring.',
    serviceUnavailable: 'Xizmat vaqtincha ishlamayapti. Birozdan keyin qayta urinib ko‘ring.',
  },
  nav: sharedDict.nav.uz,
  common: sharedDict.common.uz,
  permission: sharedDict.permission.uz,
  validation: sharedDict.validation.uz,
  apiErrors: sharedDict.apiErrors.uz,
  dashboard: dashboardDict.uz,
  products: productsDict.uz,
  categories: categoriesDict.uz,
  csv: csvDict.uz,
  zones: zonesDict.uz,
  slots: slotsDict.uz,
  users: usersDict.uz,
  audit: auditDict.uz,
};
