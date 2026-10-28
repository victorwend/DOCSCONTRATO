import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import { ENV, Env } from '../config/env';
import { CurrentUser, parse, Public, SessionUser } from '../common/http';
import { AuthService } from './auth.service';
import { SESSION_COOKIE } from './auth.guard';

const loginSchema = z.object({
  email: z.string().email('E-mail inválido').max(200),
  password: z.string().min(1, 'Informe a senha').max(200),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, @Inject(ENV) private readonly env: Env) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(loginSchema, body);
    const user = await this.auth.validate(email, password);
    res.cookie(SESSION_COOKIE, this.auth.sign(user), {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: 'lax',
      path: '/',
      maxAge: this.env.SESSION_HOURS * 3600 * 1000,
    });
    return { user };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: SessionUser) {
    return { user };
  }
}
