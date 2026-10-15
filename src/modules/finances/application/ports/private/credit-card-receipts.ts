import type {
    CreditCardCommand,
    CreditCardResult,
} from '../../models/credit-card-purchase.js';
export const CREDIT_CARD_RECEIPTS = Symbol('CREDIT_CARD_RECEIPTS');
export interface CreditCardReceipts {
    find(command: CreditCardCommand): Promise<CreditCardResult | null>;
    save(
        command: CreditCardCommand,
        result: CreditCardResult,
        now: string,
    ): Promise<void>;
}
