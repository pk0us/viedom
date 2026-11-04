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
    const body: ApiErrorResponse = {
      error: {
        code:
          status === 404 ? 'NOT_FOUND' : status === 400 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR',
        message:
          status === 404
            ? 'Resource not found.'
            : status === 400
              ? 'Some fields are invalid.'
              : 'The request could not be completed.',
        requestId: randomUUID()
      }
    };
    response.status(status).json(body);
  }
}
