import { DatabaseSync } from 'node:sqlite';
import { INITIAL_SCHEMA_SQL } from './schema.js';

export interface Migration {
  id: string;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001',
    name: '001_initial_schema',
    sql: INITIAL_SCHEMA_SQL
  }
];

export function runMigrations(db: DatabaseSync): string[] {
  // 1. Ensure migrations metadata table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const appliedList = db.prepare('SELECT name FROM _migrations').all() as Array<{ name: string }>;
  const appliedSet = new Set(appliedList.map((m) => m.name));
  const newlyApplied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (!appliedSet.has(migration.name)) {
      db.exec('BEGIN TRANSACTION;');
      try {
        db.exec(migration.sql);
        const insertStmt = db.prepare('INSERT INTO _migrations (name) VALUES (?)');
        insertStmt.run(migration.name);
        db.exec('COMMIT;');
        newlyApplied.push(migration.name);
      } catch (err) {
        db.exec('ROLLBACK;');
        throw new Error(`Migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return newlyApplied;
}
