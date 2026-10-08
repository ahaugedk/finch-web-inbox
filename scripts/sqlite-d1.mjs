import { DatabaseSync } from 'node:sqlite';

// Development and test adapter. Production uses the real D1 binding.
export function sqliteD1(filename = ':memory:') {
  const sqlite = new DatabaseSync(filename); sqlite.exec('PRAGMA foreign_keys = ON');
  function prepared(sql, values = []) {
    return {
      bind(...args) { return prepared(sql, args); },
      first() { return Promise.resolve(sqlite.prepare(sql).get(...values) || null); },
      all() { return Promise.resolve({ results: sqlite.prepare(sql).all(...values) }); },
      run() { const result = sqlite.prepare(sql).run(...values); return Promise.resolve({ meta: { changes: Number(result.changes) } }); },
      execute() {
        if (/\bRETURNING\b/i.test(sql) || /^\s*SELECT\b/i.test(sql)) return { results: sqlite.prepare(sql).all(...values) };
        const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    sqlite, prepare: prepared,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map((s) => s.execute()); sqlite.exec('COMMIT'); return results; }
      catch (e) { sqlite.exec('ROLLBACK'); throw e; }
    },
  };
}
