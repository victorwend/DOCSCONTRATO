import { Controller, Get, Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ENV, Env, loadEnv } from './config/env';
import { createPool, Db } from './db/pool';
import { STORAGE } from './core/tokens';
import { createStorageDriver } from './storage/storage';
import { AuditService } from './audit/audit.service';
import { EmailService } from './email/email.service';
import { AnalysisService } from './analysis/analysis.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { UsersController } from './users/users.controller';
import { ModelsService } from './models/models.service';
import { ModelsController } from './models/models.controller';
import { RequestsService } from './requests/requests.service';
import { ReviewService } from './requests/review.service';
import { RequestsController } from './requests/requests.controller';
import { FilesService } from './files/files.service';
import { FilesController } from './files/files.controller';
import { FinalPdfService } from './pdf/final-pdf.service';
import { PortalService } from './portal/portal.service';
import { PortalController } from './portal/portal.controller';
import { JobsService } from './jobs/jobs.service';
import { AllExceptionsFilter } from './common/exception.filter';
import { Public } from './common/http';

@Controller('health')
class HealthController {
  constructor(private readonly db: Db, @Inject(ENV) private readonly env: Env) {}
  @Public()
  @Get()
  async health() {
    await this.db.one('select 1 as ok');
    return { ok: true, storage: this.env.STORAGE_DRIVER, auth: this.env.AUTH_PROVIDER, email: this.env.EMAIL_DRIVER };
  }
}

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: loadEnv },
    { provide: Db, useFactory: (env: Env) => new Db(createPool(env.DATABASE_URL, env.DATABASE_SSL)), inject: [ENV] },
    { provide: STORAGE, useFactory: (env: Env) => createStorageDriver(env), inject: [ENV] },
    AuditService,
    EmailService,
    AnalysisService,
  ],
  exports: [ENV, Db, STORAGE, AuditService, EmailService, AnalysisService],
})
class CoreModule implements OnModuleDestroy {
  constructor(private readonly db: Db) {}
  async onModuleDestroy() {
    await this.db.pool.end();
  }
}

@Module({
  imports: [CoreModule, ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }])],
  controllers: [HealthController, AuthController, UsersController, ModelsController, RequestsController, FilesController, PortalController],
  providers: [
    AuthService,
    ModelsService,
    RequestsService,
    ReviewService,
    FilesService,
    FinalPdfService,
    PortalService,
    JobsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
