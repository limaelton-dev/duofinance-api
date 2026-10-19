import { QueryFailedError } from 'typeorm';

export function isPostgresqlUnavailable(error: unknown): boolean {
    const cause = error instanceof QueryFailedError ? error.driverError : error;
    const code =
        typeof cause === 'object' && cause !== null && 'code' in cause
            ? cause.code
            : null;
    return (
        typeof code === 'string' &&
        (code.startsWith('08') ||
            [
                '53000',
                '53100',
                '53200',
                '53300',
                '53400',
                '57014',
                '57P01',
                '57P02',
                '57P03',
                'ECONNREFUSED',
                'ECONNRESET',
                'ETIMEDOUT',
                'EPIPE',
            ].includes(code))
    );
}
