import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { sanitizeLog } from '../logging/log-sanitizer';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status: number =
      exception instanceof HttpException ? exception.getStatus() : 500;

    const exceptionResponse =
      exception instanceof HttpException
        ? exception.getResponse()
        : { message: 'Internal server error' };

    let message = 'Internal server error';
    if (typeof exceptionResponse === 'string') {
      message = exceptionResponse;
    } else if (
      typeof exceptionResponse === 'object' &&
      exceptionResponse !== null &&
      'message' in exceptionResponse
    ) {
      const maybeMessage = (exceptionResponse as Record<string, unknown>)
        .message;
      if (typeof maybeMessage === 'string') {
        message = maybeMessage;
      } else if (Array.isArray(maybeMessage)) {
        message = maybeMessage.join('; ');
      }
    }

    const isProduction = process.env.NODE_ENV === 'production';

    this.logger.error(
      `HTTP ${status} [${request.method}] ${request.url} - ${JSON.stringify(
        sanitizeLog({
          message,
          error:
            exception instanceof Error ? exception.message : String(exception),
          ...(isProduction
            ? {}
            : {
                stack: exception instanceof Error ? exception.stack : undefined,
              }),
        }),
      )}`,
    );

    const errorPayload: Record<string, unknown> = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message:
        status === 500 && isProduction ? 'Internal server error' : message,
    };

    if (!isProduction && exception instanceof Error) {
      errorPayload.stack = exception.stack;
    }

    response.status(status).json(errorPayload);
  }
}
