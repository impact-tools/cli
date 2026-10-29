/** The part of a SQLite connection the CLI uses; `node:sqlite` and `bun:sqlite` both provide it. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: readonly (string | number)[]): unknown;
    all(...params: readonly (string | number)[]): unknown[];
    run(...params: readonly (string | number)[]): unknown;
  };
  close(): void;
}

/**
 * Opens a SQLite file with the runtime's own driver: `bun:sqlite` under Bun, which has no
 * `node:sqlite` before 1.4, and `node:sqlite` under Node. Loaded on first use, so a command that
 * never opens a database runs on any runtime. `readOnly` opens the file without creating it and
 * refuses writes; under Bun the file is opened writable with `query_only`, because Bun needs write
 * access to create a missing WAL sidecar.
 */
export async function openSqlite(path: string, options: { readonly readOnly?: boolean } = {}): Promise<SqliteDatabase> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, options.readOnly ? { readwrite: true, create: false } : { create: true });
    if (options.readOnly) db.exec("PRAGMA query_only=ON");
    return {
      exec: (sql) => void db.exec(sql),
      prepare: (sql) => {
        const statement = db.prepare(sql);
        return {
          get: (...params) => statement.get(...params) ?? undefined,
          all: (...params) => statement.all(...params),
          run: (...params) => statement.run(...params),
        };
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { readOnly: options.readOnly === true });
}
