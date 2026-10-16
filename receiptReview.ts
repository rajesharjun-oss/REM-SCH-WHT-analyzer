export type IdentifierType =
    | 'Receipt Number'
    | 'PRN'
    | 'RRR'
    | 'Payment Reference'
    | 'Transaction Reference'
    | 'Deposit Slip Number'
    | 'CBS Reference'
    | 'Session ID'
    | 'Other'
    | 'Missing';

export type PeriodSource = 'receipt' | 'filename' | 'payment-date' | 'missing';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ReviewableReceipt {
    paymentDate: string;
    paymentPeriod: string;
    paymentPeriodSource: PeriodSource;
    receiptNumber: string;
    identifierType: IdentifierType;
    taxType: string;
    amount: number;
}

export interface ReceiptReviewAssessment {
    confidence: ConfidenceLevel;
    confidenceScore: number;
    reviewIssues: string[];
}

const cleanValue = (value: unknown) =>
    String(value ?? '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s:;#=-]+|[\s:;#=-]+$/g, '')
        .trim();

const normalizeIdentifier = (value: string) => cleanValue(value).toUpperCase().replace(/[^A-Z0-9]/g, '');

export const detectIdentifierType = (text: string, identifier: string): IdentifierType => {
    if (!cleanValue(identifier)) return 'Missing';

    const normalizedText = cleanValue(text);
    const patterns: Array<[IdentifierType, RegExp]> = [
        ['Receipt Number', /\b(?:official\s+)?(?:e-?\s*)?receipt\s*(?:no\.?|number|#|id)\b/i],
        ['RRR', /\b(?:remita\s+retrieval\s+reference|rrr)\b/i],
        ['PRN', /\b(?:payment\s+reference\s+number\s*\(\s*prn\s*\)|payment\s+registration\s+number|prn)\b/i],
        ['Deposit Slip Number', /\bdeposit\s+slip\s*(?:no\.?|number)?\b/i],
        ['CBS Reference', /\bcbs\s*(?:ref(?:erence)?|no\.?|number)\b/i],
        ['Transaction Reference', /\btransaction\s*(?:id|ref(?:erence)?|no\.?)\b/i],
        ['Session ID', /\bsession\s*id\b/i],
        ['Payment Reference', /\bpayment\s*(?:ref(?:erence)?|no\.?|number|id|code)\b/i]
    ];

    const normalizedIdentifier = normalizeIdentifier(identifier);
    const lines = text.split(/\r?\n/).map(line => cleanValue(line)).filter(Boolean);
    const matchingLineIndex = lines.findIndex(line => normalizeIdentifier(line).includes(normalizedIdentifier));

    if (matchingLineIndex >= 0) {
        const matchingLine = lines[matchingLineIndex];
        for (const [type, pattern] of patterns) {
            if (pattern.test(matchingLine)) return type;
        }

        const previousLine = lines[matchingLineIndex - 1] ?? '';
        if (!/:\s*$/.test(previousLine)) {
            for (const [type, pattern] of patterns) {
                if (pattern.test(previousLine)) return type;
            }
        }
        if (/^\d{4}-?\d{4}-?\d{4}$/.test(cleanValue(identifier))) return 'RRR';
        return 'Other';
    }

    for (const [type, pattern] of patterns) {
        if (pattern.test(normalizedText)) return type;
    }

    if (/^\d{4}-?\d{4}-?\d{4}$/.test(cleanValue(identifier))) return 'RRR';
    return 'Other';
};

const detailLabels: Array<[RegExp, string]> = [
    [/\brents?\b/i, 'Rent'],
    [/\bprofessional\s+(?:fee|fees|service|services)\b/i, 'Professional Fees'],
    [/\btechnical\s+(?:fee|fees|service|services)\b/i, 'Technical Fees'],
    [/\bdirectors?\s+(?:fee|fees)\b/i, 'Directors Fees'],
    [/\bcontracts?\b/i, 'Contract'],
    [/\bcommissions?\b/i, 'Commission'],
    [/\bdividends?\b/i, 'Dividend'],
    [/\binterest\b/i, 'Interest']
];

export const normalizeTaxDetails = (rawTaxType: string, text = '') => {
    const rawValue = cleanValue(rawTaxType);
    const searchArea = `${rawValue}\n${text}`;

    if (/\b(?:withholding\s+vat|wvat)\b/i.test(searchArea)) {
        return { taxType: 'WVAT', remarks: 'WVAT' };
    }
    if (/\b(?:pay[-\s]*as[-\s]*you[-\s]*earn|paye)\b/i.test(searchArea)) {
        return { taxType: 'PAYE', remarks: 'PAYE' };
    }
    if (/\b(?:withholding\s+tax|wht)\b/i.test(searchArea)) {
        const detail = detailLabels.find(([pattern]) => pattern.test(searchArea))?.[1];
        return { taxType: 'WHT', remarks: detail ? `WHT on ${detail}` : 'WHT' };
    }
    if (/\b(?:value\s+added\s+tax|vat)\b/i.test(searchArea)) {
        return { taxType: 'VAT', remarks: 'VAT' };
    }
    if (/\bdevelopment\s+levy\b/i.test(searchArea)) {
        return { taxType: 'Development Levy', remarks: 'Development Levy' };
    }
    if (/\bstamp\s+dut(?:y|ies)\b/i.test(searchArea)) {
        return { taxType: 'Stamp Duty', remarks: 'Stamp Duty' };
    }

    return { taxType: rawValue, remarks: rawValue };
};

export const assessReceiptReview = (receipt: ReviewableReceipt): ReceiptReviewAssessment => {
    const reviewIssues: string[] = [];

    if (!receipt.paymentDate) reviewIssues.push('Payment date is missing');
    if (!receipt.paymentPeriod) reviewIssues.push('Payment period is missing');
    if (!receipt.taxType) reviewIssues.push('Tax type is missing');
    if (!receipt.receiptNumber) reviewIssues.push('Receipt or alternative identifier is missing');
    if (!(receipt.amount > 0)) reviewIssues.push('Amount is missing or invalid');

    if (receipt.paymentPeriod && receipt.paymentPeriodSource === 'filename') {
        reviewIssues.push('Payment period was inferred from the filename');
    }
    if (receipt.paymentPeriod && receipt.paymentPeriodSource === 'payment-date') {
        reviewIssues.push('Payment period was inferred from the payment date');
    }
    if (receipt.receiptNumber && receipt.identifierType !== 'Receipt Number') {
        reviewIssues.push(`Using ${receipt.identifierType.toLowerCase()} because a receipt number was not identified`);
    }
    if (/^(?:tax|other|revenue payment|revenue receipt)$/i.test(cleanValue(receipt.taxType))) {
        reviewIssues.push('Tax type is generic and needs confirmation');
    }

    const missingIssueCount = reviewIssues.filter(issue => /missing|invalid/i.test(issue)).length;
    const confidenceScore = Math.max(0, 100 - (missingIssueCount * 20) - ((reviewIssues.length - missingIssueCount) * 8));
    const confidence: ConfidenceLevel = confidenceScore >= 90 ? 'high' : confidenceScore >= 70 ? 'medium' : 'low';

    return { confidence, confidenceScore, reviewIssues };
};

export const createReceiptDeduplicationKey = (receipt: {
    identityKey: string;
    receiptNumber: string;
    paymentDate: string;
    amount: number;
    taxType: string;
}) => {
    const identifier = normalizeIdentifier(receipt.receiptNumber);
    if (identifier.length >= 6) return `identifier:${identifier}`;
    if (receipt.identityKey) return receipt.identityKey;

    return [
        'fallback',
        receipt.paymentDate,
        Number(receipt.amount || 0).toFixed(2),
        cleanValue(receipt.taxType).toUpperCase()
    ].join(':');
};
