export function database(env) {
  if (!env.DB) throw new Error('Database binding DB is unavailable.');
  return {
    statement(sql, ...values) { return env.DB.prepare(sql).bind(...values); },
    first(sql, ...values) { return this.statement(sql, ...values).first(); },
    async all(sql, ...values) { return (await this.statement(sql, ...values).all()).results; },
    run(sql, ...values) { return this.statement(sql, ...values).run(); },
    batch(statements) { return env.DB.batch(statements); },
  };
}
