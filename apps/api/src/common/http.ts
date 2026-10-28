import { BadRequestException, createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { z, ZodError, ZodTypeAny } from 'zod';
import type { Actor } from '../audit/audit.service';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

export type AuthedRequest = Request & { user?: SessionUser };

export const IS_PUBLIC = 'pd:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const PERMISSIONS = 'pd:permissions';
/** Exige ao menos uma das permissões informadas. */
export const RequirePermission = (...perms: string[]) => SetMetadata(PERMISSIONS, perms);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

export function clientIp(req: Request): string | null {
  return (req.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '') || null;
}

export function userActor(req: AuthedRequest): Actor {
  const u = req.user!;
  return { type: 'USER', userId: u.id, name: u.name, ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

export function applicantActor(req: Request, name?: string): Actor {
  return { type: 'APPLICANT', name, ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

export function hasPermission(user: SessionUser | undefined, perm: string): boolean {
  return !!user && (user.permissions.includes('*') || user.permissions.includes(perm));
}

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new BadRequestException({
        message: e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; '),
        issues: e.issues,
      });
    }
    throw e;
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(id: string, what = 'id') {
  if (!UUID_RE.test(id)) throw new BadRequestException(`${what} inválido`);
}
