import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assemblePdfText,
    extractFallbackAmount,
    extractFallbackReceiptNumber,
    hasRecoverableReceiptData
} from './receiptRecovery.ts';

test('reconstructs PDF text items without splitting every field onto a new line', () => {
    const text = assemblePdfText([
        { str: 'Amount' },
        { str: 'NGN' },
        { str: '4,483,197.15', hasEOL: true },
        { str: '58463725/GAWAMAEU', hasEOL: true }
    ]);

    assert.equal(text, 'Amount NGN 4,483,197.15\n58463725/GAWAMAEU');
});

test('recovers a Lagos receipt number fragmented by PDF extraction', () => {
    const text = 'REVENUE RECEIPT\n5 8 4 6 3 7 2 5 / G A W A M A E U\nLagos State Government';
    assert.equal(extractFallbackReceiptNumber(text), '58463725/GAWAMAEU');
});

test('recovers an amount whose punctuation is separated by whitespace', () => {
    const text = 'Amount\nNGN 4 , 483 , 197 . 15\nPayment Details';
    assert.equal(extractFallbackAmount(text), 4483197.15);
});

test('retains incomplete receipts for user review instead of silently dropping them', () => {
    assert.equal(hasRecoverableReceiptData({
        receiptNumber: '58463725/GAWAMAEU',
        amount: 0,
        paymentDate: '',
        paymentPeriod: '',
        taxType: ''
    }), true);
});
