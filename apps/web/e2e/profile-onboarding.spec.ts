import { expect, test, type Page } from '@playwright/test';
import { botChooseLanguage, botReceivesOwnContact, demoPhoneFor } from './bot';
import { installTelegramStub, requireBotToken, type TelegramStubOptions } from './support';
import { buildSignedInitData, type FakeTelegramUser } from './telegram-init-data';

/**
 * One canonical preference model across bot, API and storefront:
 *
 * - the language picked in the bot's first-start buttons (played by the signed bot stand-in) is
 *   the account language, and the storefront URL follows it; Profile is the only place to change
 *   it and there is no switch in the header;
 * - the phone is shared from the Mini App profile (`requestContact`), arrives through the bot,
 *   and the profile shows the masked verified number; checkout asks for it before ordering;
 * - Telegram fullscreen is requested once after a tap on phones and degrades when refused;
 * - the branded sign-in screen in a plain browser; 320px / 390px / desktop / dark layouts.
 *
 * Uses one fresh Telegram id per run so first-start state is real. 3 Mini App logins.
 */

const RUN = Date.now() % 1_000_000;
const PHONE_USER: FakeTelegramUser = {
  id: 910_000_000 + RUN,
  first_name: 'Munira',
  last_name: 'Profil',
  username: `e2e_profile_${RUN}`,
  language_code: 'uz',
};

async function openMiniApp(page: Page, who: FakeTelegramUser, options: TelegramStubOptions = {}) {
  await installTelegramStub(page, buildSignedInitData({ botToken: requireBotToken(), user: who }), {
    verifiedPhone: false,
    ...options,
  });
}

/** A real tap on the page body (the first user gesture). */
async function tap(page: Page): Promise<void> {
  await page.getByRole('main').click({ position: { x: 8, y: 8 } });
}

function fullscreenRequests(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __mm: { fullscreenRequests?: number } }).__mm.fullscreenRequests ?? 0,
  );
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'page must not scroll sideways').toBeLessThanOrEqual(0);
}

test.describe.serial('profile, language and phone', () => {
  test('bot language choice wins over the link; Profile is the one place to change it', async ({
    page,
  }) => {
    await botChooseLanguage(PHONE_USER, 'ru');
    await openMiniApp(page, PHONE_USER);
    await page.goto('/uz');
    // Signed in from initData, the saved language (ru) replaces the /uz link.
    await expect(page).toHaveURL(/\/ru$/, { timeout: 15_000 });
    await expect(page.getByRole('banner').getByRole('link', { name: 'Русский' })).toHaveCount(0);
    await expect(page.getByRole('banner').getByRole('link', { name: 'O‘zbekcha' })).toHaveCount(0);

    await page.goto('/ru/profile');
    await expect(page.getByTestId('profile-name')).toHaveText('Munira Profil');
    await page.getByRole('radio', { name: 'O‘zbekcha' }).click();
    await expect(page).toHaveURL(/\/uz\/profile$/);
    await expect(page.getByRole('radio', { name: 'O‘zbekcha' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Saved on the account: a fresh visit to the Russian link comes back to Uzbek.
    await page.goto('/ru');
    await expect(page).toHaveURL(/\/uz$/, { timeout: 15_000 });
  });

  test('the phone is shared from the Mini App profile and comes back verified', async ({
    page,
  }) => {
    await openMiniApp(page, PHONE_USER);
    let declined = true;
    await page.exposeFunction('__mmShareContact', async () => {
      if (declined) return false;
      // Telegram sends the contact to the bot; the bot stores it through the Core API.
      await botReceivesOwnContact(PHONE_USER, demoPhoneFor(PHONE_USER));
      return true;
    });

    await page.goto('/uz/profile');
    const card = page.getByTestId('phone-card-profile');
    await expect(card).toContainText('Telefon raqami');
    const share = card.getByRole('button', { name: 'Raqamni Telegram orqali ulashish' });

    await share.click();
    await expect(card).toContainText('Raqam ulashilmadi');

    declined = false;
    await share.click();
    await expect(card).toContainText('Raqamingiz tasdiqlandi.', { timeout: 15_000 });
    const digits = demoPhoneFor(PHONE_USER).slice(-4);
    await expect(card).toContainText(`${digits.slice(0, 2)} ${digits.slice(2)}`);
    await expect(card).toContainText('Tasdiqlangan');
    // Only the masked hint is ever on the page.
    expect(await page.content()).not.toContain(demoPhoneFor(PHONE_USER));
    await expect(card.getByRole('button', { name: 'Raqamni yangilash' })).toBeVisible();
  });
});

test('fullscreen is requested once after the first tap on phones', async ({ page }) => {
  const who = { ...PHONE_USER, id: PHONE_USER.id + 1, username: `e2e_fs_${RUN}` };
  await openMiniApp(page, who, { platform: 'android', fullscreen: 'ok' });
  await page.goto('/uz');
  await expect(page.getByRole('banner')).toBeVisible();
  expect(await fullscreenRequests(page)).toBe(0);

  await tap(page);
  await expect.poll(() => fullscreenRequests(page)).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-tg-fullscreen', '');
  // The logo sits below Telegram's controls, centred in the content safe area.
  const header = page.getByRole('banner');
  const box = await header.getByRole('link').first().boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(46 + 47 - 1);
  expect(Math.abs(box!.x + box!.width / 2 - width / 2)).toBeLessThan(24);

  await tap(page);
  expect(await fullscreenRequests(page)).toBe(1);
  await noHorizontalScroll(page);
});

test('a refused fullscreen leaves the app usable; desktop clients never ask', async ({ page }) => {
  const who = { ...PHONE_USER, id: PHONE_USER.id + 1, username: `e2e_fs_${RUN}` };
  await openMiniApp(page, who, { platform: 'android', fullscreen: 'fail' });
  await page.goto('/uz');
  await tap(page);
  await expect.poll(() => fullscreenRequests(page)).toBe(1);
  await expect(page.locator('html')).not.toHaveAttribute('data-tg-fullscreen', '');
  await expect(page.getByRole('navigation', { name: 'Bo‘limlar' })).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await openMiniApp(page, who, { platform: 'tdesktop', fullscreen: 'ok' });
  await page.goto('/uz/profile');
  await tap(page);
  expect(await fullscreenRequests(page)).toBe(0);
});

test.describe('browser visitors', () => {
  test('cart and orders show the branded sign-in screen', async ({ page }) => {
    await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
    for (const path of ['/uz/cart', '/uz/orders', '/uz/profile']) {
      await page.goto(path);
      const screen = page.getByTestId('sign-in-screen');
      await expect(screen).toBeVisible();
      await expect(screen).toContainText('Telegram orqali kiring');
      await expect(screen).toContainText('parolingizni hech qachon ko‘rmaymiz');
    }
  });

  for (const viewport of [
    { name: '320px', width: 320, height: 640 },
    { name: '390px', width: 390, height: 844 },
    { name: 'desktop', width: 1280, height: 800 },
  ]) {
    for (const scheme of ['light', 'dark'] as const) {
      test(`no sideways scroll at ${viewport.name} (${scheme})`, async ({ page }) => {
        await page.route(/^https:\/\/([^/]+\.)?telegram\.org\//, (route) => route.abort());
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.emulateMedia({ colorScheme: scheme });
        for (const path of ['/ru', '/ru/profile', '/ru/help', '/uz/cart']) {
          await page.goto(path);
          await expect(page.getByRole('main')).toBeVisible();
          await noHorizontalScroll(page);
        }
        const gutter = await page.evaluate(
          () => getComputedStyle(document.documentElement).scrollbarGutter,
        );
        expect(gutter).toBe('stable');
      });
    }
  }
});
