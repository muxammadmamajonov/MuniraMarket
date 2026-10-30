// Test double for `sdk/db`: a minimal stand-in for the documented schema DSL, plus an in-memory
// `db` that supports only what the code under test uses (`select().from().where().all()/get()`).

function column(name) {
  const col = {
    $column: name,
    primaryKey: () => col,
    notNull: () => col,
    unique: () => col,
    default: () => col,
    deprecated: () => col,
  };
  return col;
}

export const text = (name) => column(name);
export const integer = (name) => column(name);
export const real = (name) => column(name);
export const numeric = (name) => column(name);
export const blob = (name) => column(name);
export const boolean = (name) => column(name);
export const json = (name) => column(name);

export function table(name, columns) {
  const t = { $table: name };
  for (const [key, col] of Object.entries(columns)) {
    t[key] = { $column: col.$column ?? key, $key: key, $tableName: name };
  }
  t.deprecated = () => t;
  return t;
}

export function sql(strings, ...values) {
  return { $sql: strings.join('?'), values };
}
sql.raw = (text) => ({ $sql: text, values: [] });

export const eq = (column, value) => ({ op: 'eq', column, value });
export const and = (...predicates) => ({ op: 'and', predicates });
export const or = (...predicates) => ({ op: 'or', predicates });
export const asc = (column) => ({ op: 'asc', column });
export const desc = (column) => ({ op: 'desc', column });

function matches(row, predicate) {
  if (predicate.op === 'eq') return row[predicate.column.$key] === predicate.value;
  if (predicate.op === 'and') return predicate.predicates.every((p) => matches(row, p));
  if (predicate.op === 'or') return predicate.predicates.some((p) => matches(row, p));
  throw new Error(`fake db: unsupported predicate ${predicate.op}`);
}

export function createFakeDb() {
  const tables = new Map();
  let failure = null;
  return {
    /** Test helper: replace the rows of a table. */
    __setRows(tableName, rows) {
      tables.set(
        tableName,
        rows.map((row) => ({ ...row })),
      );
    },
    /** Test helper: make every query reject with this error (or null to stop). */
    __failWith(error) {
      failure = error;
    },
    select() {
      return {
        from(t) {
          const predicates = [];
          const builder = {
            where(...p) {
              predicates.push(...p);
              return builder;
            },
            async all() {
              if (failure) throw failure;
              const rows = tables.get(t.$table) ?? [];
              return rows.filter((row) => predicates.every((p) => matches(row, p)));
            },
            async get() {
              return (await builder.all())[0] ?? null;
            },
          };
          return builder;
        },
      };
    },
  };
}

export const db = createFakeDb();
