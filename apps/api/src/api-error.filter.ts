import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { ApiErrorResponse } from '@viedom/contracts';

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const errors: Record<number, [string, string]> = {
      400: ['VALIDATION_FAILED', 'Some fields are invalid.'],
      401: ['UNAUTHENTICATED', 'Authentication is required.'],
      403: ['FORBIDDEN', 'This action is not permitted.'],
      404: ['NOT_FOUND', 'Resource not found.'],
      409: ['CONFLICT', 'The request conflicts with the current state.'],
      413: ['PAYLOAD_TOO_LARGE', 'The request is too large.'],
      429: ['RATE_LIMITED', 'Too many requests. Try again later.'],
      503: ['SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.']
    };
    const [code, message] = errors[status] ?? [
      'INTERNAL_ERROR',
      'The request could not be completed.'
    ];
    if (status === 429) {
      const details = exception instanceof HttpException ? exception.getResponse() : null;
      const delay =
        typeof details === 'object' &&
        details !== null &&
        'retryAfter' in details &&
        typeof details.retryAfter === 'number' &&
        Number.isFinite(details.retryAfter)
          ? details.retryAfter
          : 1;
      response.setHeader('Retry-After', String(Math.max(1, Math.min(900, Math.ceil(delay)))));
    }
    const body: ApiErrorResponse = {
      error: {
        code,
        message,
        requestId: randomUUID()
      }
    };
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json(body);
  }
}
