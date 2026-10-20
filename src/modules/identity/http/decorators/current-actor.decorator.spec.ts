import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';

import { PersonId } from '../../../spaces/domain/person/person-id.js';
import type { AuthenticatedActor } from '../../application/models/authenticated-actor.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.js';
import { CurrentActor } from './current-actor.decorator.js';

class TestController {
    handle(@CurrentActor() actor: AuthenticatedActor) {
        return actor;
    }
}

type ParameterMetadata = {
    data: unknown;
    factory: (data: unknown, context: ExecutionContext) => AuthenticatedActor;
};

function extractActor(request: Pick<AuthenticatedRequest, 'actor'>) {
    const metadata = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        TestController,
        'handle',
    ) as Record<string, ParameterMetadata>;

    const parameter = Object.values(metadata)[0];

    const context = new ExecutionContextHost(
        [request],
        TestController,
        TestController.prototype.handle,
    );

    return parameter.factory(parameter.data, context);
}

describe('CurrentActor', () => {
    it('returns the actor attached to the request by the guard', () => {
        const actor: AuthenticatedActor = {
            personId: PersonId.create(),
            sessionId: 'current-session-id',
        };

        expect(extractActor({ actor })).toBe(actor);
    });

    it('rejects a request with no authenticated actor', () => {
        expect(() => extractActor({})).toThrow(UnauthorizedException);
    });
});
