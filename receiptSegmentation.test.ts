import assert from 'node:assert/strict';
import test from 'node:test';

import { extractReceiptIdentity, extractUniqueReceiptCandidates } from './receiptSegmentation.ts';

const firsReceipt = (prn: string, receiptNumber: string, amount: string) => `
FIRS TAXPROMAX
PAYMENT RECEIPT
Payment Reference Number (PRN): ${prn}
Customer Name: FIRST CITY MONUMENT BANK LIMITED
Total Amount Paid: N ${amount}
Payment Date: 18-Jul-25 17:30:54
Payment Ref. Number: FCMB|BRH|TAXP|18-07-2025|763061
Receipt Number: ${receiptNumber}
`;

test('extracts multiple unique receipts across pages and removes duplicate print copies', () => {
    const firstReceipt = firsReceipt('1752838076-10591066', '2538588903', '106,892,056.70');
    const secondReceipt = firsReceipt('1752837458-10591060', '2538588909', '207,465,190.91');
    const thirdReceipt = firsReceipt('1752838371-10591070', '2538588913', '45,705,747.10');
    const pdfText = `${firstReceipt}\n${firstReceipt}\n\f\n${secondReceipt}\n${secondReceipt}\n\f\n${thirdReceipt}`;

    const candidates = extractUniqueReceiptCandidates(pdfText);

    assert.equal(candidates.length, 3);
    assert.deepEqual(
        candidates.map(candidate => candidate.identityKey),
        [
            'prn:1752838076-10591066',
            'prn:1752837458-10591060',
            'prn:1752838371-10591070'
        ]
    );
});

test('extracts two unique receipts printed on the same PDF page', () => {
    const pdfText = [
        firsReceipt('1752838076-10591066', '2538588903', '106,892,056.70'),
        firsReceipt('1752838371-10591070', '2538588913', '45,705,747.10')
    ].join('\n');

    const candidates = extractUniqueReceiptCandidates(pdfText);

    assert.equal(candidates.length, 2);
    assert.notEqual(candidates[0].identityKey, candidates[1].identityKey);
});

test('keeps continuation pages attached to the preceding receipt', () => {
    const pdfText = `${firsReceipt('1752838076-10591066', '2538588903', '106,892,056.70')}\n\f\nBank Teller: abdullahi, bakare`;

    const candidates = extractUniqueReceiptCandidates(pdfText);

    assert.equal(candidates.length, 1);
    assert.match(candidates[0].text, /Bank Teller: abdullahi, bakare/);
});

test('uses receipt number when a payment reference is unavailable', () => {
    const identity = extractReceiptIdentity('PAYMENT RECEIPT\nReceipt Number: 2538588913');

    assert.equal(identity, 'receipt:2538588913');
});
