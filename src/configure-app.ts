import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import { CsrfService } from './modules/identity/http/services/csrf.service.js';
import { createValidationException } from './shared/technical/http/validation/create-validation-exception.js';
import { createApiOpenApiDocument } from './composition/http/create-api-openapi-document.js';

export function configureApp(app: INestApplication): void {
    const config = app.get(ConfigService);
    const csrf = app.get(CsrfService);
    const isProduction = config.getOrThrow<string>('NODE_ENV') === 'production';

    app.setGlobalPrefix('v2');

    if (isProduction) {
        app.getHttpAdapter().getInstance().set('trust proxy', 1);
    }

    app.use(helmet());
    app.use(cookieParser());

    app.enableCors({
        origin: config.getOrThrow<string>('WEB_ORIGIN'),
        credentials: true,
        exposedHeaders: ['Retry-After', 'Location'],
    });

    app.use(csrf.protection);

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            validationError: { target: false, value: false },
            exceptionFactory: createValidationException,
        }),
    );

    SwaggerModule.setup('docs', app, createApiOpenApiDocument(isProduction), {
        useGlobalPrefix: true,
        jsonDocumentUrl: 'openapi.json',
        yamlDocumentUrl: 'openapi.yaml',
        swaggerOptions: {
            withCredentials: true,
            persistAuthorization: false,
        },
    });
}
