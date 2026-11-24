# O7: backup and restore runbook (document only; no backup is started by this file)

Today the only protection is Neon's point-in-time restore (history retention). That covers a bad
migration or a bad deploy. It does **not** cover loss of the Neon project or account, a dropped
branch past the retention window, or a corruption noticed after the window. A logical backup held
by the business covers those. The README's current restore drill also points a laptop at
restored production data, which its own rule forbids; this runbook replaces it.

Nothing here has been run. No storage bucket, secret or schedule exists yet.

## 1. What you need first (decisions and access)

| Need                    | Detail                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup storage          | Object storage **owned by the business**, outside the Neon project: a Cloudflare R2 bucket in a separate account or a separate bucket with its own token, or another provider. Versioning on, public access off, a retention rule (see 5).                                                                                                                                  |
| A read-only backup role | A new DB role `mm_backup` (`LOGIN`, `NOCREATEDB NOCREATEROLE NOBYPASSRLS`, `CONNECTION LIMIT 2`, `pg_read_all_data`) created by the project owner with SQL (not the Console, which makes superuser-group roles). It is a **change to roles**: review it on a branch first.                                                                                                  |
| Where the dump job runs | A scheduled job outside Neon and outside the Workers (a GitHub Actions workflow with a protected Environment, or a small VM). Needs `pg_dump` 17 or newer (match the server) and `age` or `gpg`.                                                                                                                                                                            |
| Secrets (names only)    | `BACKUP_DATABASE_URL` (the `mm_backup` URL, **direct/unpooled** endpoint, `sslmode=verify-full`), `BACKUP_AGE_RECIPIENT` (public key; the private key lives offline with two people), `BACKUP_STORAGE_*` (a token that can only **write** new objects to the one bucket, no delete). Store them only in the job's secret store. Never in this repo, never pasted in a chat. |
| An owner and an on-call | One named person owns the schedule and the quarterly drill.                                                                                                                                                                                                                                                                                                                 |

## 2. The dump (design; the command a job would run)

```bash
# Direct endpoint, read-only role. Custom format = compressed, selectively restorable.
pg_dump --format=custom --no-owner --no-privileges --exclude-table-data=public.auth_sessions \
        --exclude-table-data=public.rate_limit_counters --exclude-table-data=public.service_request_nonces \
        --exclude-table-data=public.oidc_login_states --file=munira-$(date -u +%Y%m%dT%H%MZ).dump \
        "$BACKUP_DATABASE_URL"
age -r "$BACKUP_AGE_RECIPIENT" -o "$f.age" "$f" && sha256sum "$f.age" > "$f.age.sha256"
# upload both files, then delete the plaintext; the job log prints names and sizes only.
```

- The security-state tables (session hashes, rate counters, nonces, login states) are **not**
  dumped as data: they are worthless after a restore (everyone signs in again) and sensitive.
- The dump holds customer **names, phone numbers and addresses**. It is encrypted before it leaves
  the job, readable only with the offline private key, kept per the privacy policy, and deleted when
  the retention ends. Nobody downloads it to a laptop.
- Schedule: nightly at a quiet hour (Tashkent night), plus one before every production migration
  (the existing `pre-migration-<release>` branch stays as well).

## 3. Restore drill (replaces the README's laptop drill)

Run before launch and then quarterly. Never restore into the production branch and never onto a
personal machine.

1. **Neon point-in-time restore**: create a branch from production at "now minus 1 hour"
   (before launch: the freshly migrated empty branch). Record the start time (UTC).
2. Connect to that **branch** only from the CI job or a jump host (the `mm_migrator`/owner URL of
   the branch, never production's), run `20-verify-runtime-role.sql` and the counts query below.
3. **Logical restore**: create a second empty branch, install roles (`01-roles.sql`,
   `02-database.sql`, `03-default-privileges.sql`), decrypt the latest dump on the job host,
   `pg_restore --no-owner --role=mm_migrator --exit-on-error --dbname <branch url> file.dump`, then
   `10-runtime-grants.sql`, `20-verify-runtime-role.sql`.
4. Compare counts on the original and restored branch (as the owner, aggregates only):

```sql
SELECT 'orders' AS t, count(*) FROM orders UNION ALL SELECT 'order_items', count(*) FROM order_items
UNION ALL SELECT 'products', count(*) FROM products UNION ALL SELECT 'users', count(*) FROM users
UNION ALL SELECT 'audit_log', count(*) FROM audit_log;
SELECT max(created_at) AS newest_order FROM orders;
```

5. Point a **branch** Function (or a local Core API on the CI host) at the restored branch, check
   `/api/v1/health/ready`, then delete both branches and the decrypted file. Record the times.

## 4. Restore-time acceptance checklist

- [ ] Time to restore recorded for **both** paths: Neon point-in-time branch ready in ______ min;
      logical restore of the latest dump finished in ______ min (decrypt + `pg_restore` + grants).
- [ ] The logical restore reaches `20-verify-runtime-role.sql` without a failure, and
      `/api/v1/health/ready` answers `200` against the restored branch.
- [ ] Row counts match the source within the dump window; `newest_order` is within 24 h of "now".
- [ ] RTO target written down (suggested: 60 min for the Neon path, 4 h for the logical path) and
      met, or the gap is logged as a risk with an owner.
- [ ] RPO written down (suggested: 24 h for the logical path, minutes for Neon PITR inside the
      retention window).
- [ ] No plaintext dump and no decrypted copy remains anywhere; both drill branches are deleted.
- [ ] The offline private key was used once in the drill by someone other than its custodian, with
      the second custodian present.
- [ ] The backup-age alert (`infra/launch/o6-cloudflare-rules.md`, alerts) fired in a test.

## 5. Retention and access

- Keep nightly dumps 30 days, the weekly ones for 12 weeks, one monthly for 12 months, unless the
  privacy policy says shorter (`infra/launch/legal-content-checklist.md`, retention). Enforce it
  with a bucket lifecycle rule, not by hand.
- The write token cannot delete or read; reading needs a separate, rarely used credential.
- Writes and reads are logged; the quarterly drill checks the log.

## Risk

The dump contains personal data of customers: the encryption key custody, the bucket's access
policy and the retention rule are the controls, and they matter more than the schedule. A read
role with `pg_read_all_data` can read every table, so its URL is as sensitive as the owner's.
