/**
 * Minimal typings for the parts of `window.Telegram.WebApp` that MuniraMarket uses.
 * Reference: https://core.telegram.org/bots/webapps
 *
 * SECURITY: everything on `initDataUnsafe` is client-controlled and MUST be treated as untrusted.
 * It is for display only (for example greeting the user by first name). User identity must always
 * come from server-side verification of the raw `initData` string. Never send a client-side user
 * id to any API as proof of who the user is.
 */

export type TelegramColorScheme = 'light' | 'dark';

export type TelegramThemeParams = Partial<
  Record<
    | 'bg_color'
    | 'text_color'
    | 'hint_color'
    | 'link_color'
    | 'button_color'
    | 'button_text_color'
    | 'secondary_bg_color'
    | 'header_bg_color'
    | 'accent_text_color'
    | 'section_bg_color'
    | 'section_header_text_color'
    | 'subtitle_text_color'
    | 'destructive_text_color',
    string
  >
>;

/** UNTRUSTED, display-only. Parsed by the Telegram client; not signed, can be forged by anyone. */
export interface TelegramUntrustedUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

/** UNTRUSTED, display-only. Never use any field of this as an identity or authorisation signal. */
export interface TelegramUntrustedInitData {
  query_id?: string;
  user?: TelegramUntrustedUser;
  start_param?: string;
  auth_date?: number;
  hash?: string;
}

export type TelegramEventType =
  | 'themeChanged'
  | 'viewportChanged'
  | 'mainButtonClicked'
  | 'backButtonClicked'
  | 'settingsButtonClicked';

export type TelegramEventHandler = (...args: unknown[]) => void;

export interface TelegramBackButton {
  readonly isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

export interface TelegramMainButton {
  readonly isVisible: boolean;
  readonly isActive: boolean;
  text: string;
  setText(text: string): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
}

export type TelegramImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';
export type TelegramNotificationType = 'error' | 'success' | 'warning';

export interface TelegramHapticFeedback {
  impactOccurred(style: TelegramImpactStyle): void;
  notificationOccurred(type: TelegramNotificationType): void;
  selectionChanged(): void;
}

/** Error delivered to a `Serverless.call` callback. */
export interface TelegramServerlessError {
  message: string;
  type?: string;
  status: number;
  parameters?: Record<string, unknown>;
}

/**
 * Node-style callback: `error` is non-null on failure, otherwise `result` holds the endpoint's
 * response.
 *
 * ASSUMPTION: the argument order is `(error, result)`. The Serverless client API is only loosely
 * documented; if the real order differs, `callServerless` in `serverless.ts` is the single place
 * that needs to change.
 */
export type TelegramServerlessCallback = (
  error: TelegramServerlessError | null,
  result?: unknown,
) => void;

export interface TelegramServerless {
  call(name: string, input?: unknown, callback?: TelegramServerlessCallback): void;
}

export interface TelegramWebApp {
  /** Raw, signed init data. Empty string when the page is not opened inside Telegram. */
  readonly initData: string;
  /** UNTRUSTED. Display only, see the file header. */
  readonly initDataUnsafe: TelegramUntrustedInitData;
  readonly colorScheme: TelegramColorScheme;
  readonly themeParams: TelegramThemeParams;
  readonly platform: string;
  readonly version: string;
  ready(): void;
  expand(): void;
  onEvent(eventType: TelegramEventType, handler: TelegramEventHandler): void;
  offEvent(eventType: TelegramEventType, handler: TelegramEventHandler): void;
  readonly BackButton: TelegramBackButton;
  readonly MainButton: TelegramMainButton;
  readonly HapticFeedback?: TelegramHapticFeedback;
  readonly Serverless?: TelegramServerless;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}
