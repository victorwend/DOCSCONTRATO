import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../config/env';

/**
 * Armazenamento PRIVADO de arquivos.
 * Estrutura lógica:
 *   requests/{request_id}/original/{file_id}.{ext}
 *   requests/{request_id}/processed/{document_id}.pdf
 *   requests/{request_id}/final/{file_id}.pdf
 * Nenhum nome de arquivo contém CPF, nome ou outro dado pessoal.
 */
export interface StorageDriver {
  readonly name: 'local' | 'supabase';
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /** URL temporária assinada para download direto (Supabase) — local retorna null (a API serve o arquivo). */
  signedUrl(key: string, ttlSeconds: number, downloadName?: string): Promise<string | null>;
}

export function assertSafeKey(key: string) {
  if (!/^requests\/[0-9a-f-]{36}\/(original|processed|final)\/[A-Za-z0-9._-]+$/.test(key)) {
    throw new Error(`Chave de storage inválida: ${key}`);
  }
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;
  constructor(private readonly root: string) {}

  private path(key: string) {
    assertSafeKey(key);
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root) + sep)) throw new Error('Caminho fora do storage');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode: 0o600, flag: 'wx' }).catch(async (e: NodeJS.ErrnoException) => {
      if (e.code === 'EEXIST' && key.includes('/processed/')) return writeFile(p, data, { mode: 0o600 });
      throw e;
    });
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async exists(key: string) {
    return stat(this.path(key)).then(() => true, () => false);
  }
  async signedUrl() {
    return null;
  }
}

export class SupabaseStorageDriver implements StorageDriver {
  readonly name = 'supabase' as const;
  private client: SupabaseClient;
  private ready: Promise<void> | null = null;

  constructor(url: string, serviceKey: string, private readonly bucket: string) {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private ensureBucket() {
    if (!this.ready) {
      this.ready = (async () => {
        const { data } = await this.client.storage.getBucket(this.bucket);
        if (data) {
          if (data.public) throw new Error(`O bucket "${this.bucket}" é público. Torne-o privado no Supabase.`);
          return;
        }
        const { error } = await this.client.storage.createBucket(this.bucket, { public: false });
        if (error && !/already exists/i.test(error.message)) throw error;
      })().catch((e) => {
        this.ready = null;
        throw e;
      });
    }
    return this.ready;
  }

  async put(key: string, data: Buffer, contentType: string) {
    assertSafeKey(key);
    await this.ensureBucket();
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(key, data, { contentType, upsert: key.includes('/processed/') });
    if (error) throw new Error(`Falha ao gravar no storage: ${error.message}`);
  }
  async get(key: string) {
    assertSafeKey(key);
    await this.ensureBucket();
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) throw new Error(`Falha ao ler do storage: ${error?.message}`);
    return Buffer.from(await data.arrayBuffer());
  }
  async remove(key: string) {
    assertSafeKey(key);
    await this.ensureBucket();
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) throw new Error(`Falha ao remover do storage: ${error.message}`);
  }
  async signedUrl(key: string, ttlSeconds: number, downloadName?: string) {
    assertSafeKey(key);
    await this.ensureBucket();
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(key, ttlSeconds, downloadName ? { download: downloadName } : undefined);
    if (error || !data) throw new Error(`Falha ao gerar URL assinada: ${error?.message}`);
    return data.signedUrl;
  }
}

export function createStorageDriver(env: Env): StorageDriver {
  if (env.STORAGE_DRIVER === 'supabase') {
    return new SupabaseStorageDriver(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, env.SUPABASE_STORAGE_BUCKET);
  }
  return new LocalStorageDriver(env.LOCAL_STORAGE_DIR);
}

// ---------------------------------------------------------------------------
// URLs temporárias assinadas (HMAC) servidas pela própria API
// ---------------------------------------------------------------------------
export interface FileUrlClaims {
  fid: string; // file id
  exp: number; // epoch seconds
  disp: 'inline' | 'attachment';
  uid: string; // usuário que gerou (auditoria)
  n?: string; // nome sugerido para download
}

export function signFileUrl(secret: string, claims: FileUrlClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyFileUrl(secret: string, token: string): FileUrlClaims | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FileUrlClaims;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}
