import type { Database } from '../db.ts';
import type { Clock, SessionEntrance } from '../http/context.ts';

/**
 * One-time Telegram OIDC login state (port of services/api/app/security/oidc_state.py,
 * ADR 0014), stored in `oidc_login_states`. `take` deletes and returns the row in one statement
 * (`DELETE ... RETURNING`), so a state is consumed at most once even when the same callback URL
 * arrives twice in parallel.
 */

export interface PendingLogin {
  bindingHash: string;
  entrance: SessionEntrance;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
}

export class PostgresOidcStateStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async put(stateHash: string, login: PendingLogin, ttlSeconds: number): Promise<void> {
    const expires = this.clock() + ttlSeconds;
    await this.db.storeTx(async (client) => {
      await client.query(
        `INSERT INTO oidc_login_states (state_hash, binding_hash, entrance, code_verifier, nonce,
           return_to, created_at_epoch, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8::float8))`,
        [
          stateHash,
          login.bindingHash,
          login.entrance,
          login.codeVerifier,
          login.nonce,
          login.returnTo,
          login.createdAt,
          expires,
        ],
      );
    });
  }

  /** Remove and return the unexpired login for `stateHash` (`null` otherwise). */
  async take(stateHash: string): Promise<PendingLogin | null> {
    const now = this.clock();
    return this.db.storeTx(async (client) => {
      const { rows } = await client.query<{
        binding_hash: string;
        entrance: string;
        code_verifier: string;
        nonce: string;
        return_to: string;
        created_at_epoch: number;
        expired: boolean;
      }>(
        `DELETE FROM oidc_login_states WHERE state_hash = $1
         RETURNING binding_hash, entrance, code_verifier, nonce, return_to, created_at_epoch,
           expires_at <= to_timestamp($2::float8) AS expired`,
        [stateHash, now],
      );
      const row = rows[0];
      if (row === undefined || row.expired) return null;
      return {
        bindingHash: row.binding_hash,
        entrance: row.entrance === 'admin' ? 'admin' : 'storefront',
        codeVerifier: row.code_verifier,
        nonce: row.nonce,
        returnTo: row.return_to,
        createdAt: row.created_at_epoch,
      };
    });
  }
}
