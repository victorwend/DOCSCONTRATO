import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { SessionUser } from '../common/http';

/**
 * Autenticação dos usuários internos.
 *  AUTH_PROVIDER=local    -> senha com bcrypt na tabela users
 *  AUTH_PROVIDER=supabase -> credenciais validadas no Supabase Auth; o papel/permissões
 *                            continuam na tabela users (vinculada pelo e-mail)
 * Em ambos os casos a API emite a própria sessão (JWT em cookie httpOnly).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // hash fictício para manter o tempo de resposta constante quando o e-mail não existe
  private readonly dummyHash = bcrypt.hashSync('pavidez-docs-dummy-password', 10);

  constructor(@Inject(ENV) private readonly env: Env, private readonly db: Db) {}

  async validate(email: string, password: string): Promise<SessionUser> {
    const normalized = email.trim().toLowerCase();
    const row = await this.db.maybe<SessionUser & { password_hash: string | null; active: boolean }>(
      `select u.id, u.name, u.email::text as email, u.password_hash, u.active, r.code as role, r.permissions
         from users u join roles r on r.id = u.role_id where u.email = $1`,
      [normalized],
    );

    let ok = false;
    if (this.env.AUTH_PROVIDER === 'supabase') {
      ok = await this.validateWithSupabase(normalized, password);
    } else {
      ok = await bcrypt.compare(password, row?.password_hash ?? this.dummyHash);
    }
    if (!ok || !row || !row.active) throw new UnauthorizedException('E-mail ou senha inválidos.');

    await this.db.exec('update users set last_login_at = now() where id = $1', [row.id]);
    return { id: row.id, name: row.name, email: row.email, role: row.role, permissions: row.permissions };
  }

  private async validateWithSupabase(email: string, password: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: this.env.SUPABASE_ANON_KEY!, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return res.ok;
    } catch (e) {
      this.logger.error(`Supabase Auth indisponível: ${(e as Error).message}`);
      return false;
    }
  }

  /** Cria/atualiza a senha do usuário no provedor configurado. */
  async setPassword(userId: string, email: string, password: string) {
    if (this.env.AUTH_PROVIDER === 'supabase') {
      const admin = createClient(this.env.SUPABASE_URL!, this.env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      }).auth.admin;
      const { data: list } = await admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list?.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      const { error } = existing
        ? await admin.updateUserById(existing.id, { password })
        : await admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error(`Supabase Auth: ${error.message}`);
      return;
    }
    const hash = await bcrypt.hash(password, 12);
    await this.db.exec('update users set password_hash = $2 where id = $1', [userId, hash]);
  }

  sign(user: SessionUser): string {
    return jwt.sign({ sub: user.id, role: user.role }, this.env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: `${this.env.SESSION_HOURS}h`,
      issuer: 'pavidez-docs',
    });
  }
}
