import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../db/pool';
import { AuthService } from '../auth/auth.service';
import { assertUuid, CurrentUser, parse, RequirePermission, SessionUser } from '../common/http';

const passwordSchema = z
  .string()
  .min(8, 'A senha deve ter ao menos 8 caracteres')
  .max(200)
  .regex(/[A-Za-z]/, 'A senha deve conter letras')
  .regex(/[0-9]/, 'A senha deve conter números');

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.string().regex(/^[A-Z_]+$/),
  password: passwordSchema,
});

const updateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.string().regex(/^[A-Z_]+$/).optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(),
});

@Controller('users')
export class UsersController {
  constructor(private readonly db: Db, private readonly auth: AuthService) {}

  /** Lista resumida para seleção de responsável (qualquer usuário interno). */
  @Get('options')
  options() {
    return this.db.many(
      `select u.id, u.name, r.code as role from users u join roles r on r.id = u.role_id where u.active order by u.name`,
    );
  }

  @Get('roles')
  @RequirePermission('users.manage')
  roles() {
    return this.db.many('select id, code, name, description, permissions from roles order by id');
  }

  @Get()
  @RequirePermission('users.manage')
  list() {
    return this.db.many(
      `select u.id, u.name, u.email::text as email, u.active, u.last_login_at, u.created_at, r.code as role, r.name as role_name
         from users u join roles r on r.id = u.role_id order by u.active desc, u.name`,
    );
  }

  @Post()
  @RequirePermission('users.manage')
  async create(@Body() body: unknown) {
    const dto = parse(createSchema, body);
    const role = await this.db.maybe<{ id: number }>('select id from roles where code = $1', [dto.role]);
    if (!role) throw new BadRequestException('Papel inválido');
    const exists = await this.db.maybe('select 1 from users where email = $1', [dto.email]);
    if (exists) throw new ConflictException('Já existe um usuário com este e-mail.');
    const user = await this.db.one<{ id: string }>(
      'insert into users (name, email, role_id) values ($1, $2, $3) returning id',
      [dto.name, dto.email, role.id],
    );
    await this.auth.setPassword(user.id, dto.email, dto.password);
    return { id: user.id };
  }

  @Patch(':id')
  @RequirePermission('users.manage')
  async update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() me: SessionUser) {
    assertUuid(id);
    const dto = parse(updateSchema, body);
    const user = await this.db.maybe<{ id: string; email: string }>('select id, email::text as email from users where id = $1', [id]);
    if (!user) throw new NotFoundException('Usuário não encontrado');
    if (id === me.id && (dto.active === false || (dto.role && dto.role !== me.role))) {
      throw new BadRequestException('Você não pode desativar ou alterar o próprio papel.');
    }
    let roleId: number | null = null;
    if (dto.role) {
      const role = await this.db.maybe<{ id: number }>('select id from roles where code = $1', [dto.role]);
      if (!role) throw new BadRequestException('Papel inválido');
      roleId = role.id;
    }
    await this.db.exec(
      `update users set name = coalesce($2, name), role_id = coalesce($3, role_id), active = coalesce($4, active) where id = $1`,
      [id, dto.name ?? null, roleId, dto.active ?? null],
    );
    if (dto.password) await this.auth.setPassword(id, user.email, dto.password);
    return { ok: true };
  }
}
