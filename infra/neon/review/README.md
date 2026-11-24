# Neon SQL Editor review queries (nothing here runs by itself)

Every file in this folder is for a human to read, paste into the **Neon Console SQL Editor** and
run, **first on a Neon branch** (a restore-point branch of production is fine only if no one
connects to it afterwards; see `../README.md`), then in production once the branch results are
reviewed. Nothing here is applied by CI, a migration or a deploy, and no file contains a password,
host or project id.

| File                                     | What it does                                         | Changes data or grants? |
| ---------------------------------------- | ---------------------------------------------------- | ----------------------- |
| `o5-inventory-and-public-privileges.sql` | Inventory of live objects and PUBLIC/role privileges | No (read-only)          |
| `rls-preflight.sql`                      | Row-level-security state per table, policies, roles  | No (read-only)          |
| `s2-revoke-delete-order-history.sql`     | Revoke DELETE on three order tables from `mm_app`    | Yes, in a transaction   |

## SQL Editor basics

1. Open the Console, pick the **branch** (not production) and the database, then the SQL Editor.
2. The Editor connects as the **project owner role**. That role is not a PostgreSQL superuser and
   does not own the application tables (`mm_migrator` does), see the note in the S2 file.
3. Run **one numbered query at a time** (select it, then Run/Run selected); the Editor shows only
   the last result of a multi-statement run.
4. For the S2 file, run the dry-run block first (it ends in `ROLLBACK`), read the output, and only
   then run the `COMMIT` block.
5. Paste the result of each read-only query back to the team. The queries return object names,
   role names and privilege letters only; they never return row data from application tables.
   Do not paste connection strings or passwords anywhere.
