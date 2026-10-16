import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assessReceiptReview,
    createReceiptDeduplicationKey,
    detectIdentifierType,
    normalizeTaxDetails
} from './receiptReview.ts';

test('normalizes detailed WHT descriptions while preserving remarks', () => {
    assert.deepEqual(
        normalizeTaxDetails('Withholding Tax on Professional Fees'),
        { taxType: 'WHT', remarks: 'WHT on Professional Fees' }
    );
});

test('keeps WVAT separate from VAT and WHT', () => {
    assert.deepEqual(
        normalizeTaxDetails('', 'Revenue Item: Withholding VAT'),
        { taxType: 'WVAT', remarks: 'WVAT' }
    );
});

test('identifies an RRR used as the alternative receipt identifier', () => {
    assert.equal(
        detectIdentifierType('Remita Retrieval Reference (RRR): 1014-3223-3272', '1014-3223-3272'),
        'RRR'
    );
});

test('does not label a payment reference as a receipt number when the receipt field is blank', () => {
    const text = 'Receipt Number:\nPayment Ref. Number: ABP|BRH|ABIA|17-04-2026|148695';
    assert.equal(
        detectIdentifierType(text, 'ABP|BRH|ABIA|17-04-2026|148695'),
        'Payment Reference'
    );
});

test('flags inferred fields and alternative identifiers for review', () => {
    const assessment = assessReceiptReview({
        paymentDate: '2026-02-18',
        paymentPeriod: 'Jan-26',
        paymentPeriodSource: 'payment-date',
        receiptNumber: '1014-3223-3272',
        identifierType: 'RRR',
        taxType: 'WHT',
        amount: 7355.32
    });

    assert.equal(assessment.confidence, 'medium');
    assert.deepEqual(assessment.reviewIssues, [
        'Payment period was inferred from the payment date',
        'Using rrr because a receipt number was not identified'
    ]);
});

test('deduplicates formatting variations of the same identifier', () => {
    const first = createReceiptDeduplicationKey({
        identityKey: 'content:first',
        receiptNumber: '1014-3223-3272',
        paymentDate: '2026-02-18',
        amount: 7355.32,
        taxType: 'WHT'
    });
    const second = createReceiptDeduplicationKey({
        identityKey: 'content:second',
        receiptNumber: '1014 3223 3272',
        paymentDate: '2026-02-18',
        amount: 7355.32,
        taxType: 'WHT'
    });

    assert.equal(first, second);
});
