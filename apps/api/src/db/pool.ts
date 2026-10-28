import { Pool, PoolClient, QueryResultRow, types } from 'pg';

// DATE (1082) como string 'YYYY-MM-DD' — evita deslocamento de fuso horário
types.setTypeParser(1082, (v: string) => v);
// BIGINT (20) como número (contagens)
types.setTypeParser(20, (v: string) => Number(v));

export interface Queryable {
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

export function createPool(connectionString: string, ssl: boolean): Pool {
  return new Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  });
}

export class Db {
  constructor(public readonly pool: Pool) {}

  async many<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<T[]> {
    return (await c.query<T>(sql, params)).rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<T> {
    const rows = await this.many<T>(sql, params, c);
    if (rows.length !== 1) throw new Error(`Esperado 1 registro, obtido ${rows.length}`);
    return rows[0];
  }

  async maybe<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<T | null> {
    const rows = await this.many<T>(sql, params, c);
    return rows[0] ?? null;
  }

  async exec(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<number> {
    return (await c.query(sql, params)).rowCount ?? 0;
  }

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
