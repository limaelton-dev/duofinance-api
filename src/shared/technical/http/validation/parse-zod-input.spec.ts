import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
    RecordIncomePipe,
    RecordIncomeReceiptPipe,
} from '../../../../modules/finances/http/dto/record-income.dto.js';
import {
    RecordCreditCardPurchasePipe,
    RecordExternalLiabilityPipe,
} from '../../../../modules/finances/http/dto/record-credit-card-purchase.dto.js';
import { RecordExpenseDisbursementPipe } from '../../../../modules/finances/http/dto/record-expense-disbursement.dto.js';
import { SettleExternalLiabilityPipe } from '../../../../modules/finances/http/dto/settle-external-liability.dto.js';

function errors(pipe: { transform(input: unknown): unknown }, input: unknown) {
    try {
        pipe.transform(input);
        throw new Error('Expected validation error');
    } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        return (error as BadRequestException).getResponse() as {
            details: { fields: { field: string; messages: string[] }[] };
        };
    }
}
const base = {
    amountInCents: 100,
    factDate: '2026-10-14',
    expectedCommitmentVersion: 1,
};
describe('Financial input validation in Portuguese', () => {
    it.each([
        [
            new RecordIncomePipe(),
            {
                description: 'Salário',
                amountInCents: '100',
                expectedReceiptDate: '2026-10-15',
                receipt: null,
            },
        ],
        [new RecordIncomeReceiptPipe(), { ...base, amountInCents: 0 }],
        [
            new RecordCreditCardPurchasePipe(),
            {
                description: 'Compra',
                amountInCents: '100',
                factDate: '2026-10-14',
                externalLiability: {},
            },
        ],
        [new RecordExternalLiabilityPipe(), { ...base, amountInCents: 0 }],
        [
            new RecordExpenseDisbursementPipe(),
            { ...base, amountInCents: '100', method: 'PIX' },
        ],
        [new SettleExternalLiabilityPipe(), { ...base, amountInCents: 0 }],
    ])(
        'identifies the invalid amount without exposing Zod English errors',
        (pipe, input) => {
            expect(errors(pipe, input).details.fields).toEqual([
                {
                    field: 'amountInCents',
                    messages: ['Informe um valor válido para este campo.'],
                },
            ]);
        },
    );
    it('keeps the shared branch and nested path when one shared input is wrong', () => {
        const member = '00000000-0000-4000-8000-000000000001';
        const result = errors(new RecordIncomePipe(), {
            description: 'Renda',
            amountInCents: 100,
            expectedReceiptDate: '2026-10-15',
            expectedSpaceVersion: 1,
            expectedRecipientMemberId: null,
            participationSplit: {
                mode: 'AMOUNTS',
                shares: [{ memberId: member, amountInCents: 100 }],
            },
            receipt: {
                factDate: '2026-10-14',
                recipientMemberId: member,
                amountInCents: '100',
                settlement: { mode: 'NONE' },
            },
        });
        expect(result.details.fields).toEqual([
            {
                field: 'receipt.amountInCents',
                messages: ['Informe um valor válido para este campo.'],
            },
        ]);
    });
    it('reports forbidden keys and preserves the civil date explanation', () => {
        const result = errors(new SettleExternalLiabilityPipe(), {
            ...base,
            factDate: '2026-02-30',
            injected: true,
        });
        expect(result.details.fields).toEqual(
            expect.arrayContaining([
                {
                    field: 'injected',
                    messages: ['Este campo não é permitido.'],
                },
                {
                    field: 'factDate',
                    messages: ['Informe uma data civil válida.'],
                },
            ]),
        );
    });
    it('gives an addressable body error for null input', () => {
        expect(errors(new RecordIncomePipe(), null).details.fields).toEqual([
            {
                field: 'body',
                messages: ['Informe um valor válido para este campo.'],
            },
        ]);
    });
});
