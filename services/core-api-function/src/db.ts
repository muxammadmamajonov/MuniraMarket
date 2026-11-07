import pg from 'pg';
import { StoreUnavailableError } from './errors.ts';

/**
 * PostgreSQL access. One module-scope `pg.Pool` per isolate (src/index.ts, `max: 5`), reused by
 * every request that isolate serves; `attachDatabasePool` keeps an idle disconnect from killing
 * the isolate. Runtime traffic uses Neon's injected pooled `DATABASE_URL`; migrations stay on
 * Alembic with `DATABASE_URL_UNPOOLED`.
 *
 * Every unit of work that writes runs in ONE transaction (`tx`): checkout, stock decrement,
 * idempotency record and order status changes commit or roll back together. Transaction-local
 * guards (`SET LOCAL statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout`)
 * bound a runaway query and work through the transaction-mode pooler, unlike startup options.
 *
 * Least privilege: Neon injects `DATABASE_URL` with the branch's default role. When
 * `runtimeRole` is set (`DB_RUNTIME_ROLE=mm_app`, required in staging/production), every
 * statement runs inside a transaction that first does `SET LOCAL ROLE mm_app`, so the Core API
 * keeps exactly the `mm_app` grants (DML only, `audit_log` append-only, no DDL; infra/neon).
 * `SET LOCAL` ends with the transaction, so a pooled server connection never leaks the role.
 */

export type Queryable = Pick<pg.PoolClient, 'query'>;

export const POOL_MAX = 5;

// int8 (bigint) as a JS number: Telegram ids (< 2^52), counts and so'm amounts are all safe
// integers. Anything larger is a bug, so refuse it loudly instead of losing precision.
pg.types.setTypeParser(20, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError('bigint value exceeds safe integer');
  return parsed;
});

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}

export interface TxOptions {
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** PostgreSQL role every transaction switches to (`SET LOCAL ROLE`); `null` = connection role. */
  runtimeRole?: string | null;
}

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class Database {
  readonly pool: pg.Pool;
  private readonly prelude: string;
  private readonly runtimeRole: string | null;

  constructor(pool: pg.Pool, options: TxOptions = {}) {
    this.pool = pool;
    const role = options.runtimeRole ?? null;
    if (role !== null && !ROLE_NAME.test(role)) throw new Error('invalid runtime role name');
    this.runtimeRole = role;
    const statements = [
      ...(role !== null ? [`SET LOCAL ROLE "${role}"`] : []),
      `SET LOCAL statement_timeout = ${Math.trunc(options.statementTimeoutMs ?? 15_000)}`,
      `SET LOCAL idle_in_transaction_session_timeout = ${Math.trunc(options.idleInTransactionTimeoutMs ?? 30_000)}`,
      `SET LOCAL lock_timeout = ${Math.trunc(options.lockTimeoutMs ?? 5_000)}`,
    ];
    this.prelude = statements.join('; ');
  }

  /**
   * A single read statement. Without a runtime role it runs directly on the pool; with one it
   * runs in a short transaction so it gets the same role and guards as everything else.
   */
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<pg.QueryResult<R>> {
    if (this.runtimeRole === null) return this.pool.query<R>(sql, params as unknown[]);
    return this.tx((client) => client.query<R>(sql, params as unknown[]));
  }

  /**
   * Run `work` in one committed READ COMMITTED transaction; any throw rolls back. Row locks
   * (`SELECT ... FOR UPDATE`) and atomic `UPDATE ... RETURNING` give the same concurrency
   * guarantees as the SQLAlchemy reference.
   */
  async tx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let released = false;
    try {
      await client.query('BEGIN');
      await client.query(this.prelude);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // The connection is unusable; drop it from the pool instead of returning it.
        client.release(rollbackError as Error);
        released = true;
      }
      throw error;
    } finally {
      if (!released) client.release();
    }
  }

  /**
   * Security-store unit of work: its own short transaction, separate from the request's, so a
   * route that later rolls back never undoes a rate-limit hit, nonce or session rotation. Any
   * database failure becomes `StoreUnavailableError` (callers fail closed with 503).
   */
  async storeTx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.tx(work);
    } catch (error) {
      if (error instanceof StoreUnavailableError) throw error;
      throw new StoreUnavailableError();
    }
  }
}

/** `timestamptz` value for an injectable-clock epoch (seconds). */
export function asDate(epochSeconds: number): Date {
  return new Date(epochSeconds * 1000);
}
