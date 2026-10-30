/**
 * Ambient declarations for the Telegram Serverless SDK, limited to the surface documented at
 * Telegram Serverless docs ("The SDK"). Anything not in the docs is intentionally absent or
 * marked as unconfirmed.
 *
 * This file is a script (no top-level import/export) so the `declare module` blocks are ambient.
 */

declare module 'sdk/db' {
  /** Column builder. `N` tracks NOT NULL so selected rows type correctly. */
  export interface Column<T = unknown, N extends boolean = false> {
    readonly _brand: 'column';
    readonly _data: T;
    readonly _notNull: N;
    primaryKey(options?: { autoIncrement?: boolean }): Column<T, true>;
    notNull(): Column<T, true>;
    unique(): Column<T, N>;
    default(value: unknown): Column<T, N>;
    deprecated(reason: string): Column<T, N>;
  }

  export function text(name?: string, options?: { mode?: 'json' }): Column<string>;
  export function integer(
    name?: string,
    options?: { mode?: 'boolean' | 'timestamp' | 'timestamp_ms' },
  ): Column<number>;
  export function real(name?: string): Column<number>;
  export function numeric(name?: string): Column<number>;
  export function blob(name?: string, options?: { mode?: 'bytes' | 'json' }): Column<Uint8Array>;
  export function boolean(name?: string): Column<boolean>;
  export function json(name?: string): Column<unknown>;

  export interface Table<C extends Record<string, Column<any, boolean>>> {
    readonly _brand: 'table';
    readonly _columns: C;
    deprecated(reason: string): Table<C>;
  }

  export type Row<C extends Record<string, Column<any, boolean>>> = {
    [K in keyof C]: C[K] extends Column<infer T, infer N> ? (N extends true ? T : T | null) : never;
  };

  export function table<C extends Record<string, Column<any, boolean>>>(
    name: string,
    columns: C,
    extras?: (t: C) => Record<string, unknown>,
  ): Table<C> & C;

  export interface SqlFragment {
    readonly _brand: 'sql';
  }
  export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment;
  export namespace sql {
    function raw(text: string): SqlFragment;
  }

  export interface Predicate {
    readonly _brand: 'predicate';
  }
  export function eq(column: Column<any, boolean>, value: unknown): Predicate;
  export function and(...predicates: Predicate[]): Predicate;
  export function or(...predicates: Predicate[]): Predicate;
  export function asc(column: Column<any, boolean>): unknown;
  export function desc(column: Column<any, boolean>): unknown;

  export interface SelectBuilder<R> {
    from<C extends Record<string, Column<any, boolean>>>(table: Table<C>): SelectBuilder<Row<C>>;
    where(...predicates: Predicate[]): SelectBuilder<R>;
    limit(n: number): SelectBuilder<R>;
    all(): Promise<R[]>;
    get(): Promise<R | null>;
  }

  export interface Db {
    select(): SelectBuilder<unknown>;
    $count(table: Table<any>, where?: Predicate): Promise<number>;
    run(query: string | SqlFragment, params?: Record<string, unknown>): Promise<unknown>;
    all(query: SqlFragment): Promise<unknown[]>;
    get(query: SqlFragment): Promise<unknown>;
  }
}

declare module 'sdk/api' {
  export class BotApiError extends Error {
    /** Bot API `error_code`. */
    code: number;
    /** Human-readable description from the Bot API. */
    description: string;
    /** Bot API method that failed. */
    method: string;
    /** Extra data such as `retry_after` or `migrate_to_chat_id`. */
    parameters?: Record<string, unknown>;
  }

  /** `api.<method>(params)` resolves to the unwrapped `result`; failures throw `BotApiError`. */
  export interface Api {
    sendMessage(params: Record<string, unknown>): Promise<unknown>;
    getMe(): Promise<unknown>;
    [method: string]: (params?: Record<string, any>) => Promise<any>;
  }
  export const api: Api;
}

declare module 'sdk/fetch' {
  export class InputFile {
    constructor(bytes: Uint8Array, filename: string, options?: { type?: string });
  }

  export interface FetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Uint8Array | InputFile;
    /** NOT documented for the Serverless runtime; used only when AbortController exists. */
    signal?: AbortSignal;
  }

  export interface FetchResponse {
    status: number;
    statusText: string;
    ok: boolean;
    url: string;
    headers: {
      get(name: string): string | null;
      has(name: string): boolean;
      keys(): Iterable<string>;
      entries(): Iterable<[string, string]>;
    };
    json(): Promise<unknown>;
    text(): Promise<string>;
  }

  export function fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
}

declare module 'sdk' {
  import type { Db } from 'sdk/db';
  import type { Api } from 'sdk/api';
  import type { FetchResponse, FetchInit } from 'sdk/fetch';

  export const db: Db;
  export const api: Api;
  export function fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
  export { InputFile } from 'sdk/fetch';
  export { BotApiError } from 'sdk/api';

  /**
   * Refuses a Mini App call. The Mini App receives `message` and `parameters` unchanged; any other
   * exception is reported to the client as a generic internal error.
   */
  export class EndpointError extends Error {
    constructor(description: string, parameters?: Record<string, unknown>);
    parameters?: Record<string, unknown>;
  }
}
