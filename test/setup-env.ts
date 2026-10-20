import 'reflect-metadata';

// Endereço exclusivo do PostgreSQL descartável de compose.test.yaml.
export const TEST_DATABASE_URL =
    'postgresql://test:test@127.0.0.1:55432/prospera_mais_test';

Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    WEB_ORIGIN: 'http://localhost:3000',
    CSRF_SECRET: 'csrf-secret-exclusivo-dos-testes-api',
    SESSION_TTL_SECONDS: '604800',
});
