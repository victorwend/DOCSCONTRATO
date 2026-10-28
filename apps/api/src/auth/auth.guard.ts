import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { AuthedRequest, hasPermission, IS_PUBLIC, PERMISSIONS, SessionUser } from '../common/http';

export const SESSION_COOKIE = 'pd_session';

/**
 * Guard global: toda rota é privada, exceto as marcadas com @Public().
 * A sessão é um JWT em cookie httpOnly; a cada requisição o usuário é recarregado do banco
 * (usuário desativado ou papel alterado perde o acesso imediatamente).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: Db,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token: string | undefined = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException('Faça login para continuar.');

    let sub: string;
    try {
      const payload = jwt.verify(token, this.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'pavidez-docs' }) as jwt.JwtPayload;
      sub = String(payload.sub);
    } catch {
      throw new UnauthorizedException('Sessão expirada. Faça login novamente.');
    }

    const user = await this.db.maybe<SessionUser & { active: boolean }>(
      `select u.id, u.name, u.email::text as email, r.code as role, r.permissions, u.active
         from users u join roles r on r.id = u.role_id where u.id = $1`,
      [sub],
    );
    if (!user || !user.active) throw new UnauthorizedException('Usuário inativo.');
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role, permissions: user.permissions };

    const needed = this.reflector.getAllAndOverride<string[]>(PERMISSIONS, targets);
    if (needed?.length && !needed.some((p) => hasPermission(req.user, p))) {
      throw new ForbiddenException('Você não tem permissão para esta ação.');
    }
    return true;
  }
}
