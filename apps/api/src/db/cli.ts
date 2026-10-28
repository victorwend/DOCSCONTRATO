/**
 * CLI de banco:
 *   npm run db:migrate   -> aplica db/migrations/*.sql ainda não aplicadas (tabela schema_migrations)
 *   npm run db:seed      -> executa db/seed/seed.sql (idempotente) e cria o administrador inicial
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';

const ROOT = process.env.PD_ROOT_DIR ?? resolve(__dirname, '..', '..', '..', '..');
const DB_DIR = join(ROOT, 'db');

async function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida (.env)');
  const ssl = ['1', 'true', 'yes'].includes((process.env.DATABASE_SSL ?? '').toLowerCase());
  const client = new Client({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  return client;
}

async function migrate() {
  const c = await connect();
  try {
    await c.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await c.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(join(DB_DIR, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(DB_DIR, 'migrations', f), 'utf8');
      process.stdout.write(`Aplicando ${f}... `);
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations(name) values ($1)', [f]);
        await c.query('commit');
        console.log('ok');
      } catch (e) {
        await c.query('rollback');
        throw e;
      }
    }
    console.log('Migrations em dia.');
  } finally {
    await c.end();
  }
}

async function seed() {
  const c = await connect();
  try {
    await c.query(readFileSync(join(DB_DIR, 'seed', 'seed.sql'), 'utf8'));
    console.log('Modelos e papéis iniciais ok.');
    const email = process.env.ADMIN_EMAIL;
    if (email) {
      const password = process.env.AUTH_PROVIDER === 'supabase' ? null : process.env.ADMIN_PASSWORD;
      if (process.env.AUTH_PROVIDER !== 'supabase' && (!password || password.length < 8)) {
        throw new Error('Defina ADMIN_PASSWORD (mínimo 8 caracteres) para criar o administrador.');
      }
      await c.query('select pd_seed_admin($1, $2, $3)', [email.toLowerCase(), process.env.ADMIN_NAME ?? 'Administrador', password]);
      console.log(`Administrador: ${email}`);
    } else {
      console.log('ADMIN_EMAIL não definido — administrador não criado.');
    }
  } finally {
    await c.end();
  }
}

const cmd = process.argv[2];
(cmd === 'migrate' ? migrate() : cmd === 'seed' ? seed() : Promise.reject(new Error('uso: cli.ts migrate|seed'))).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
