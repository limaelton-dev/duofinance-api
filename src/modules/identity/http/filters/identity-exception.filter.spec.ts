import 'reflect-metadata';
import {
    ForbiddenException,
    HttpException,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import { ThrottlerException } from '@nestjs/throttler';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmailAlreadyInUseError } from '../../application/errors/email-already-in-use.error.js';
import { InvalidCredentialsError } from '../../application/errors/invalid-credentials.error.js';
import { UnauthenticatedError } from '../../application/errors/unauthenticated.error.js';
import { createValidationException } from '../../../../shared/technical/http/validation/create-validation-exception.js';
import { ApiExceptionFilter } from '../../../../shared/technical/http/api-exception.filter.js';
import { mapIdentityError } from './identity-error.mapper.js';

function execute(exception: unknown, headersSent = false) {
    const headers = new Map<string, string>([['Retry-After', '60']]);
    const response = {
        headersSent,
        setHeader: vi.fn((name: string, value: string) => {
            headers.set(name, value);
        }),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        end: vi.fn(),
    };

    const host = new ExecutionContextHost([{}, response]);
    new ApiExceptionFilter([mapIdentityError]).catch(exception, host);

    return { response, headers };
}

afterEach(() => vi.restoreAllMocks());

describe('Identity integration with ApiExceptionFilter', () => {
    it.each([
        {
            label: 'duplicate email',
            error: new EmailAlreadyInUseError(),
            status: 409,
        },
        {
            label: 'invalid credentials',
            error: new InvalidCredentialsError(),
            status: 401,
        },
        {
            label: 'unauthenticated session',
            error: new UnauthenticatedError(),
            status: 401,
        },
    ] as const)('maps $label to HTTP $status', ({ error, status }) => {
        const { response, headers } = execute(error);

        expect(response.status).toHaveBeenCalledWith(status);
        expect(response.json).toHaveBeenCalledWith({
            code: error.code,
            message: error.message,
            details: {},
        });
        expect(headers.get('Cache-Control')).toBe('no-store');
    });

    it('maps the CSRF error', () => {
        const error = Object.assign(new Error('Library message'), {
            code: 'INVALID_CSRF_TOKEN',
            statusCode: 403,
        });
        const { response } = execute(error);

        expect(response.status).toHaveBeenCalledWith(403);
        expect(response.json).toHaveBeenCalledWith({
            code: 'INVALID_CSRF_TOKEN',
            message:
                'Não foi possível validar esta solicitação. Atualize a página e tente novamente.',
            details: {},
        });
    });

    it('preserves Retry-After when mapping the rate limiter', () => {
        const { response, headers } = execute(new ThrottlerException());

        expect(response.status).toHaveBeenCalledWith(429);
        expect(response.json).toHaveBeenCalledWith({
            code: 'TOO_MANY_REQUESTS',
            message: 'Muitas tentativas. Tente novamente em alguns instantes.',
            details: {},
        });
        expect(headers.get('Retry-After')).toBe('60');
    });

    it('preserves safe validation details', () => {
        const error = createValidationException([
            {
                property: 'email',
                constraints: { isEmail: 'email must be an email' },
                target: { password: 'segredo' },
                value: 'entrada privada',
            },
        ]);
        const { response } = execute(error);

        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith({
            code: 'VALIDATION_ERROR',
            message: 'Verifique os dados informados.',
            details: {
                fields: [
                    {
                        field: 'email',
                        messages: ['email must be an email'],
                    },
                ],
            },
        });
    });

    it.each([
        {
            label: 'forbidden request',
            error: new ForbiddenException('Private detail'),
            status: 403,
        },
        {
            label: 'missing route',
            error: new NotFoundException('Internal route'),
            status: 404,
        },
        {
            label: 'invalid JSON',
            error: Object.assign(new Error('Invalid JSON'), {
                statusCode: 400,
            }),
            status: 400,
        },
        {
            label: 'oversized body',
            error: Object.assign(new Error('Private body'), {
                statusCode: 413,
            }),
            status: 413,
        },
    ] as const)('normalizes other HTTP errors: $label', ({ error, status }) => {
        const { response, headers } = execute(error);

        expect(response.status).toHaveBeenCalledWith(status);
        expect(response.json).toHaveBeenCalledWith({
            code: 'HTTP_ERROR',
            message: 'Não foi possível processar esta solicitação.',
            details: {},
        });
        expect(headers.get('Cache-Control')).toBe('no-store');
    });

    it.each([
        {
            label: 'unexpected error',
            error: new Error('Database password'),
            status: 500,
        },
        { label: 'null error', error: null, status: 500 },
        {
            label: 'invalid HTTP status',
            error: Object.assign(new Error('Invalid status'), {
                statusCode: 200,
            }),
            status: 500,
        },
        {
            label: 'unavailable service',
            error: new HttpException('Private service', 503),
            status: 503,
        },
    ] as const)(
        'hides internal failure details: $label',
        ({ error, status }) => {
            const log = vi
                .spyOn(Logger.prototype, 'error')
                .mockImplementation(() => {});
            const { response, headers } = execute(error);

            expect(response.status).toHaveBeenCalledWith(status);
            expect(response.json).toHaveBeenCalledWith({
                code: 'INTERNAL_ERROR',
                message: 'Ocorreu um erro interno. Tente novamente mais tarde.',
                details: {},
            });
            expect(log).toHaveBeenCalledWith(error);
            expect(headers.get('Cache-Control')).toBe('no-store');
        },
    );

    it('does not write again after sending headers', () => {
        const { response } = execute(new NotFoundException(), true);

        expect(response.end).toHaveBeenCalledOnce();
        expect(response.setHeader).not.toHaveBeenCalled();
        expect(response.status).not.toHaveBeenCalled();
        expect(response.json).not.toHaveBeenCalled();
    });
});
