import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  app.setGlobalPrefix('api');
  // o Next.js repassa /api com X-Forwarded-For; TRUST_PROXY_HOPS define quantos proxies são confiáveis
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-origin' } }));
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });

  // Proteção CSRF: requisições que alteram dados devem vir da própria aplicação (APP_URL)
  const allowed = new URL(env.APP_URL).origin;
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== allowed && env.NODE_ENV === 'production') {
      res.status(403).json({ statusCode: 403, message: 'Origem não permitida.' });
      return;
    }
    next();
  });
  // nenhuma resposta da API deve ser guardada em cache por proxies/navegador
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
  Logger.log(`PAVIDEZ DOCS API em http://localhost:${env.API_PORT}/api (storage=${env.STORAGE_DRIVER}, auth=${env.AUTH_PROVIDER}, email=${env.EMAIL_DRIVER})`, 'Bootstrap');
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
