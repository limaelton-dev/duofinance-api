import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { CsrfService } from './csrf.service.js';

function createContext(
    environment = 'test',
    initialCookies: Record<string, unknown> = {},
) {
    const service = new CsrfService(
        new ConfigService({
            NODE_ENV: environment,
            CSRF_SECRET: 'secret-used-only-in-csrf-tests',
        }),
    );

    const cookies = { ...initialCookies };
    const request = { cookies } as Request;

    const cookie = vi.fn(
        (_name: string, _value: unknown, _options?: CookieOptions): Response =>
            response,
    );

    const response = { cookie } as unknown as Response;

    return { service, cookies, request, response, cookie };
}

const environments = [
    { environment: 'development', prefix: '', secure: false },
    { environment: 'test', prefix: '', secure: false },
    { environment: 'production', prefix: '__Host-', secure: true },
];

describe('CsrfService: generation and cookies', () => {
    it.each(environments)(
        'issues the correct cookies in $environment',
        ({ environment, prefix, secure }) => {
            const context = createContext(environment);

            const token = context.service.generateToken(
                context.request,
                context.response,
            );

            const options = {
                httpOnly: true,
                secure,
                sameSite: 'lax',
                path: '/',
            };

            expect(token).toEqual(expect.any(String));
            expect(token.length).toBeGreaterThan(0);

            expect(context.cookie.mock.calls).toEqual([
                [
                    `${prefix}csrf-context`,
                    expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
                    options,
                ],
                [`${prefix}csrf`, token, options],
            ]);
        },
    );

    it('reuses the valid context and token', () => {
        const first = createContext();
        const token = first.service.generateToken(
            first.request,
            first.response,
        );
        const contextId = first.cookies['csrf-context'];

        const second = createContext('test', {
            'csrf-context': contextId,
            csrf: token,
        });

        const reusedToken = second.service.generateToken(
            second.request,
            second.response,
        );

        expect(reusedToken).toBe(token);
        expect(second.cookies['csrf-context']).toBe(contextId);
        expect(second.cookie).toHaveBeenCalledTimes(1);
        expect(second.cookie.mock.calls[0]?.[0]).toBe('csrf');
    });

    it.each(environments)(
        'preserves the session without requiring an anonymous context in $environment',
        ({ environment, prefix }) => {
            const sessionCookie = `${prefix}session`;

            const context = createContext(environment, {
                [sessionCookie]: 'authenticated-session-token',
            });

            const token = context.service.generateToken(
                context.request,
                context.response,
            );

            expect(context.cookies[sessionCookie]).toBe(
                'authenticated-session-token',
            );

            expect(context.cookies[`${prefix}csrf-context`]).toBeUndefined();
            expect(context.cookie).toHaveBeenCalledTimes(1);
            expect(context.cookie.mock.calls[0]?.[0]).toBe(`${prefix}csrf`);
            expect(context.cookie.mock.calls[0]?.[1]).toBe(token);
        },
    );

    it.each([
        { label: 'invalid text', value: 'invalid-token' },
        { label: 'a number', value: 123 },
        { label: 'an object', value: { unexpected: true } },
    ])('replaces a CSRF cookie containing $label', ({ value }) => {
        const context = createContext('test', {
            'csrf-context': 'existing-anonymous-context',
            csrf: value,
        });

        const token = context.service.generateToken(
            context.request,
            context.response,
        );

        expect(token).toEqual(expect.any(String));
        expect(token.length).toBeGreaterThan(0);
        expect(token).not.toEqual(value);

        expect(context.cookies['csrf-context']).toBe(
            'existing-anonymous-context',
        );

        expect(context.cookie).toHaveBeenCalledTimes(1);
        expect(context.cookie.mock.calls[0]?.[1]).toBe(token);
    });

    it('generates different contexts and tokens for distinct visitors', () => {
        const first = createContext();
        const second = createContext();

        const firstToken = first.service.generateToken(
            first.request,
            first.response,
        );

        const secondToken = second.service.generateToken(
            second.request,
            second.response,
        );

        expect(first.cookies['csrf-context']).not.toBe(
            second.cookies['csrf-context'],
        );

        expect(firstToken).not.toBe(secondToken);
    });
});

describe('CsrfService: request protection', () => {
    function createProtectedContext(
        environment = 'test',
        initialCookies: Record<string, unknown> = {},
    ) {
        const context = createContext(environment, initialCookies);

        const token = context.service.generateToken(
            context.request,
            context.response,
        );

        const cookieName =
            environment === 'production' ? '__Host-csrf' : 'csrf';

        // Simulate the browser returning the cookie and header.
        context.cookies[cookieName] = token;
        context.request.method = 'POST';
        context.request.headers = { 'x-csrf-token': token };

        return { ...context, token };
    }

    function protect(context: ReturnType<typeof createContext>) {
        const next = vi.fn();

        context.service.protection(context.request, context.response, next);

        return next;
    }

    const invalidCsrf = expect.objectContaining({
        statusCode: 403,
        code: 'INVALID_CSRF_TOKEN',
        message:
            'Não foi possível validar esta solicitação. Atualize a página e tente novamente.',
    });

    it.each(['GET', 'HEAD', 'OPTIONS'])(
        'allows %s without a token',
        (method) => {
            const context = createContext();
            context.request.method = method;
            context.request.headers = {};

            expect(protect(context)).toHaveBeenCalledExactlyOnceWith();
        },
    );

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
        'rejects %s without the CSRF header',
        (method) => {
            const context = createProtectedContext();
            context.request.method = method;
            delete context.request.headers['x-csrf-token'];

            expect(protect(context)).toHaveBeenCalledExactlyOnceWith(
                invalidCsrf,
            );
        },
    );

    it.each(environments)(
        'accepts a valid anonymous token in $environment',
        ({ environment }) => {
            const context = createProtectedContext(environment);

            expect(protect(context)).toHaveBeenCalledExactlyOnceWith();
        },
    );

    it.each(environments)(
        'accepts a session-bound token in $environment',
        ({ environment, prefix }) => {
            const context = createProtectedContext(environment, {
                [`${prefix}session`]: 'authenticated-session',
            });

            expect(protect(context)).toHaveBeenCalledExactlyOnceWith();
        },
    );

    it.each([
        { label: 'incorrect', value: 'wrong-token' },
        { label: 'multi-value', value: ['first', 'second'] },
    ])('rejects a $label header', ({ value }) => {
        const context = createProtectedContext();

        Object.assign(context.request.headers, {
            'x-csrf-token': value,
        });

        expect(protect(context)).toHaveBeenCalledExactlyOnceWith(invalidCsrf);
    });

    it('rejects a token in the body or query without the header', () => {
        const context = createProtectedContext();
        context.request.headers = {};
        context.request.body = { csrfToken: context.token };
        context.request.query = { csrfToken: context.token };

        expect(protect(context)).toHaveBeenCalledExactlyOnceWith(invalidCsrf);
    });

    it('rejects a valid header without the CSRF cookie', () => {
        const context = createProtectedContext();
        delete context.cookies.csrf;

        expect(protect(context)).toHaveBeenCalledExactlyOnceWith(invalidCsrf);
    });

    it('rejects matching cookie and header values when the signature was tampered with', () => {
        const context = createProtectedContext();

        const forgedToken =
            (context.token.startsWith('0') ? '1' : '0') +
            context.token.slice(1);

        context.cookies.csrf = forgedToken;
        context.request.headers['x-csrf-token'] = forgedToken;

        expect(protect(context)).toHaveBeenCalledExactlyOnceWith(invalidCsrf);
    });

    it('rejects a token issued for another anonymous context', () => {
        const context = createProtectedContext();
        context.cookies['csrf-context'] = 'another-anonymous-context';

        expect(protect(context)).toHaveBeenCalledExactlyOnceWith(invalidCsrf);
    });

    it('throws the CSRF error when the anonymous identifier disappears', () => {
        const context = createProtectedContext();
        delete context.cookies['csrf-context'];

        expect(() => protect(context)).toThrow(invalidCsrf);
    });

    it.each([
        {
            label: 'login',
            before: undefined,
            after: 'session-b',
        },
        {
            label: 'a session change',
            before: 'session-a',
            after: 'session-b',
        },
        {
            label: 'logout',
            before: 'session-a',
            after: undefined,
        },
    ])('requires a new token after $label', ({ before, after }) => {
        const context = createProtectedContext('test', {
            'csrf-context': 'anonymous-context',
            session: before,
        });

        if (after === undefined) {
            delete context.cookies.session;
        } else {
            context.cookies.session = after;
        }

        expect(protect(context)).toHaveBeenCalledExactlyOnceWith(invalidCsrf);

        const newToken = context.service.generateToken(
            context.request,
            context.response,
        );

        expect(newToken).not.toBe(context.token);

        context.cookies.csrf = newToken;
        context.request.headers['x-csrf-token'] = newToken;

        expect(protect(context)).toHaveBeenCalledExactlyOnceWith();
    });
});
