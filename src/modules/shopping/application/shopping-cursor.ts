import { createHash } from 'node:crypto';
import { ShoppingError } from '../domain/shopping-error.js';

export function cursorScope(value: object): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function encodeCursor(scope: string, key: unknown) {
    return Buffer.from(JSON.stringify({ scope, key })).toString('base64url');
}
export function decodeCursor(
    scope: string,
    value: string | undefined,
): unknown {
    if (!value) return null;
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 3000)
            throw new Error();
        const parsed: unknown = JSON.parse(
            Buffer.from(value, 'base64url').toString(),
        );
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            !('scope' in parsed) ||
            parsed.scope !== scope ||
            !('key' in parsed)
        )
            throw new Error();
        return parsed.key;
    } catch {
        throw new ShoppingError('VALIDATION_ERROR', 'cursor');
    }
}
