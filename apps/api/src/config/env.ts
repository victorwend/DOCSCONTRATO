import { z } from 'zod';
import { resolve } from 'node:path';

/** Configuração centralizada e validada na inicialização. Nada de credenciais no código. */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    API_PORT: z.coerce.number().int().default(4000),
    APP_URL: z.string().url().default('http://localhost:3000'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
    DATABASE_SSL: bool(false),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter ao menos 32 caracteres'),
    SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    TOKEN_ENCRYPTION_KEY: z.string().min(32, 'TOKEN_ENCRYPTION_KEY deve ter ao menos 32 caracteres'),
    FILE_URL_SECRET: z.string().min(32, 'FILE_URL_SECRET deve ter ao menos 32 caracteres'),
    COOKIE_SECURE: bool(false),

    AUTH_PROVIDER: z.enum(['local', 'supabase']).default('local'),
    STORAGE_DRIVER: z.enum(['local', 'supabase']).default('local'),
    LOCAL_STORAGE_DIR: z.string().default('./storage'),
    SUPABASE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
    SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    SUPABASE_STORAGE_BUCKET: z.string().default('pavidez-docs'),

    MAX_UPLOAD_MB: z.coerce.number().min(1).max(100).default(20),
    MAX_FILES_PER_UPLOAD: z.coerce.number().int().min(1).max(50).default(10),
    LINK_DEFAULT_EXPIRATION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    RETENTION_DAYS: z.coerce.number().int().min(0).default(0),
    RETENTION_AUTO_PURGE: bool(false),

    EMAIL_DRIVER: z.enum(['smtp', 'log']).default('log'),
    EMAIL_FROM: z.string().default('PAVIDEZ DOCS <no-reply@pavidez.com.br>'),
    EMAIL_LOG_DIR: z.string().default('./storage/emails'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: bool(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    DEFAULT_NOTIFY_EMAIL: z.string().email().optional().or(z.literal('').transform(() => undefined)),
    NOTIFY_APPLICANT_EMAILS: bool(true),

    COMPANY_NAME: z.string().default('PAVIDEZ ENGENHARIA'),
    COMPANY_CNPJ: z.string().default('01.744.153/0001-06'),
    COMPANY_LOGO_PATH: z.string().default('./apps/api/assets/logo-pavidez.png'),

    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_NAME: z.string().default('Administrador'),
    ADMIN_PASSWORD: z.string().optional(),

    // quantidade de proxies na frente da API (o Next.js conta como 1). Usado para obter o IP real.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  })
  .superRefine((e, ctx) => {
    if (e.AUTH_PROVIDER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_ANON_KEY || !e.SUPABASE_SERVICE_ROLE_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'AUTH_PROVIDER=supabase exige SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY' });
    }
    if (e.STORAGE_DRIVER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'STORAGE_DRIVER=supabase exige SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY' });
    }
    if (e.EMAIL_DRIVER === 'smtp' && !e.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', message: 'EMAIL_DRIVER=smtp exige SMTP_HOST' });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'config'}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida (.env):\n${msg}`);
  }
  const env = parsed.data;
  // caminhos relativos são resolvidos a partir da raiz do repositório (onde fica o .env)
  const apiRoot = process.env.PD_ROOT_DIR ?? resolve(__dirname, '..', '..', '..', '..');
  env.LOCAL_STORAGE_DIR = resolve(apiRoot, env.LOCAL_STORAGE_DIR);
  env.EMAIL_LOG_DIR = resolve(apiRoot, env.EMAIL_LOG_DIR);
  env.COMPANY_LOGO_PATH = resolve(apiRoot, env.COMPANY_LOGO_PATH);
  cached = env;
  return env;
}

export const ENV = Symbol('ENV');
