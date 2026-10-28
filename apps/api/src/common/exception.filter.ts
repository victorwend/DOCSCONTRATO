import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Respostas de erro padronizadas: { statusCode, message }. Erros internos não vazam detalhes. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      let message = typeof body === 'string' ? body : (body as any)?.message ?? exception.message;
      if (Array.isArray(message)) message = message.join('; ');
      if (status === HttpStatus.PAYLOAD_TOO_LARGE || /File too large/i.test(String(message))) {
        message = `Arquivo maior que o limite de ${process.env.MAX_UPLOAD_MB ?? 20} MB.`;
      }
      if (/Too many files|Unexpected field/i.test(String(message))) message = 'Quantidade de arquivos acima do permitido.';
      if (status === HttpStatus.TOO_MANY_REQUESTS) message = 'Muitas tentativas. Aguarde um minuto e tente novamente.';
      res.status(status).json({ statusCode: status, message, ...(typeof body === 'object' && (body as any).issues ? { issues: (body as any).issues } : {}) });
      return;
    }
    // multer
    const code = (exception as { code?: string })?.code;
    if (code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ statusCode: 413, message: `Arquivo maior que o limite de ${process.env.MAX_UPLOAD_MB ?? 20} MB.` });
      return;
    }
    this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
    res.status(500).json({ statusCode: 500, message: 'Erro interno. Tente novamente; se persistir, contate o administrador.' });
  }
}
