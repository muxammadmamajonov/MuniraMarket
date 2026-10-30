'use client';

import { useEffect } from 'react';
import { useTelegram } from './provider';
import type { TelegramThemeParams } from './types';

/** Telegram theme parameter -> design token it overrides (see packages/ui tokens.css). */
const TOKEN_FOR_PARAM: ReadonlyArray<[keyof TelegramThemeParams, string]> = [
  ['bg_color', '--mm-color-background'],
  ['section_bg_color', '--mm-color-surface'],
  ['secondary_bg_color', '--mm-color-surface-muted'],
  ['text_color', '--mm-color-foreground'],
  ['hint_color', '--mm-color-muted-foreground'],
  ['button_color', '--mm-color-primary'],
  ['button_color', '--mm-color-primary-hover'],
  ['button_text_color', '--mm-color-primary-foreground'],
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Applies Telegram's theme colours to the design tokens. Returns a function that undoes it. */
export function applyTelegramTheme(params: TelegramThemeParams, root: HTMLElement): () => void {
  const applied: string[] = [];
  for (const [param, token] of TOKEN_FOR_PARAM) {
    const value = params[param];
    // Only well-formed colours: the values come from the client environment.
    if (typeof value === 'string' && HEX_COLOR.test(value)) {
      root.style.setProperty(token, value);
      applied.push(token);
    }
  }
  return () => {
    for (const token of applied) root.style.removeProperty(token);
  };
}

/** Mirrors the Telegram theme (and its changes) onto the design tokens inside the Mini App. */
export function useTelegramTheme(): void {
  const telegram = useTelegram();
  const webApp = telegram.kind === 'telegram' ? telegram.webApp : null;

  useEffect(() => {
    if (webApp === null) return undefined;
    let undo = applyTelegramTheme(webApp.themeParams, document.documentElement);
    const onThemeChanged = () => {
      undo();
      undo = applyTelegramTheme(webApp.themeParams, document.documentElement);
    };
    webApp.onEvent('themeChanged', onThemeChanged);
    return () => {
      webApp.offEvent('themeChanged', onThemeChanged);
      undo();
    };
  }, [webApp]);
}
