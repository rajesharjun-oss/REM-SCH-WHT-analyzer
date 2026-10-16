import React, { useState } from 'react';
import { extractReceiptCandidatesWithSummary } from './receiptSegmentation.ts';
import {
    assemblePdfText,
    extractFallbackAmount,
    extractFallbackReceiptNumber,
    hasRecoverableReceiptData
} from './receiptRecovery.ts';
import {
    assessReceiptReview,
    createReceiptDeduplicationKey,
    detectIdentifierType,
    normalizeTaxDetails,
    type ConfidenceLevel,
    type IdentifierType,
    type PeriodSource
} from './receiptReview.ts';

type MessageType = 'error' | 'success' | 'warning';

interface ScannerResult {
    identityKey: string;
    companyName: string;
    paymentDate: string;
    paymentDateDisplay: string;
    paymentPeriod: string;
    paymentPeriodSource: PeriodSource;
    receiptNumber: string;
    identifierType: IdentifierType;
    taxType: string;
    amount: number;
    remarks: string;
    state: string;
    sourceFile: string;
    confidence: ConfidenceLevel;
    confidenceScore: number;
    reviewIssues: string[];
    reviewed: boolean;
}

const monthLookup: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11
};

const monthShortNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const appBasePath = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
const ocrAssetBasePath = `${appBasePath}ocr`;

const nigerianStates = [
    'Abia',
    'Adamawa',
    'Akwa Ibom',
    'Anambra',
    'Bauchi',
    'Bayelsa',
    'Benue',
    'Borno',
    'Cross River',
    'Delta',
    'Ebonyi',
    'Edo',
    'Ekiti',
    'Enugu',
    'FCT',
    'Federal',
    'Gombe',
    'Imo',
    'Jigawa',
    'Kaduna',
    'Kano',
    'Katsina',
    'Kebbi',
    'Kogi',
    'Kwara',
    'Lagos',
    'Nasarawa',
    'Niger',
    'Ogun',
    'Ondo',
    'Osun',
    'Oyo',
    'Plateau',
    'Rivers',
    'Sokoto',
    'Taraba',
    'Yobe',
    'Zamfara'
];

const commonTaxTypes = ['PAYE', 'WHT', 'VAT', 'WVAT', 'Development Levy', 'Stamp Duty'];
const identifierTypes: IdentifierType[] = [
    'Receipt Number',
    'PRN',
    'RRR',
    'Payment Reference',
    'Transaction Reference',
    'Deposit Slip Number',
    'CBS Reference',
    'Session ID',
    'Other',
    'Missing'
];


const cleanValue = (value: unknown) =>
    String(value ?? '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s:;#=-]+|[\s:;#=-]+$/g, '')
        .trim();

const normalizeWhitespace = (value: string) =>
    value
        .replace(/\r/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const trimAtNextLabel = (value: string) => {
    const labelBreak = value.search(
        /\b(?:tin|address|payer|taxpayer|company|receipt|transaction|payment|period|date|state|authority|revenue|amount|total|phone|email)\b\s*(?:name|number|no|id|reference|ref|date|type|period|paid|item)?\s*[:#=-]/i
    );
    if (labelBreak > 0) {
        return value.slice(0, labelBreak).trim();
    }
    return value.trim();
};

const formatDateDisplay = (isoDate: string) => {
    const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '';
    return `${match[3]}/${match[2]}/${match[1]}`;
};

const toFourDigitYear = (yearText: string) => {
    const year = Number(yearText);
    if (yearText.length === 2) return year > 40 ? 1900 + year : 2000 + year;
    return year;
};

const toIsoDate = (year: number, monthIndex: number, day: number) => {
    const date = new Date(Date.UTC(year, monthIndex, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== monthIndex ||
        date.getUTCDate() !== day
    ) {
        return '';
    }
    return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const parseDateToIso = (rawValue: string) => {
    const value = cleanValue(rawValue);
    if (!value) return '';

    const isoMatch = value.match(/\b(20\d{2}|19\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (isoMatch) {
        return toIsoDate(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    }

    const numericMatch = value.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/);
    if (numericMatch) {
        const day = Number(numericMatch[1]);
        const month = Number(numericMatch[2]);
        return toIsoDate(toFourDigitYear(numericMatch[3]), month - 1, day);
    }

    const namedDayFirst = value.match(
        /\b(\d{1,2})(?:st|nd|rd|th)?[-\s/]+([A-Za-z]{3,9})[-\s,/]+(\d{2,4})\b/i
    );
    if (namedDayFirst) {
        const monthIndex = monthLookup[namedDayFirst[2].toLowerCase()];
        if (monthIndex !== undefined) {
            return toIsoDate(toFourDigitYear(namedDayFirst[3]), monthIndex, Number(namedDayFirst[1]));
        }
    }

    const namedMonthFirst = value.match(
        /\b([A-Za-z]{3,9})[-\s/]+(\d{1,2})(?:st|nd|rd|th)?[-\s,/]+(\d{2,4})\b/i
    );
    if (namedMonthFirst) {
        const monthIndex = monthLookup[namedMonthFirst[1].toLowerCase()];
        if (monthIndex !== undefined) {
            return toIsoDate(toFourDigitYear(namedMonthFirst[3]), monthIndex, Number(namedMonthFirst[2]));
        }
    }

    return '';
};

const derivePreviousPeriod = (isoDate: string) => {
    const match = isoDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!match) return '';
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    date.setUTCMonth(date.getUTCMonth() - 1);
    return `${monthShortNames[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)}`;
};

const normalizePeriod = (rawValue: string, fallbackDate = '') => {
    const value = cleanValue(rawValue);
    if (!value) return derivePreviousPeriod(fallbackDate);

    const dateLikePeriod = parseDateToIso(value);
    if (dateLikePeriod) {
        const [, year, month] = dateLikePeriod.match(/^(\d{4})-(\d{2})-\d{2}$/) ?? [];
        if (year && month) return `${monthShortNames[Number(month) - 1]}-${year.slice(-2)}`;
    }

    const monthYear = value.match(
        /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\w*[-\s,/]*(\d{2,4})\b/i
    );
    if (monthYear) {
        const monthIndex = monthLookup[monthYear[1].toLowerCase()];
        return `${monthShortNames[monthIndex]}-${String(toFourDigitYear(monthYear[2])).slice(-2)}`;
    }

    const numericPeriod = value.match(/\b(\d{1,2})[-/.](\d{2,4})\b/);
    if (numericPeriod) {
        const monthIndex = Number(numericPeriod[1]) - 1;
        if (monthIndex >= 0 && monthIndex < 12) {
            return `${monthShortNames[monthIndex]}-${String(toFourDigitYear(numericPeriod[2])).slice(-2)}`;
        }
    }

    const yearOnly = value.match(/\b(20\d{2}|19\d{2})\b/);
    if (yearOnly) return yearOnly[1];

    return value;
};

const isNormalizedMonthPeriod = (value: string) => /^[A-Z][a-z]{2}-\d{2}$/.test(value);

const normalizeSourceFilePeriod = (sourceFile: string, fallbackDate = '') => {
    const fileStem = sourceFile.replace(/\.[^.]+$/, '');
    const normalized = normalizePeriod(fileStem, fallbackDate);
    if (isNormalizedMonthPeriod(normalized)) return normalized;

    const monthOnly = fileStem.match(
        /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b/i
    );
    const dateMatch = fallbackDate.match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (monthOnly && dateMatch) {
        const sourceMonthIndex = monthLookup[monthOnly[1].toLowerCase()];
        const paymentMonthIndex = Number(dateMatch[2]) - 1;
        const inferredYear = Number(dateMatch[1]) - (sourceMonthIndex > paymentMonthIndex ? 1 : 0);
        return `${monthShortNames[sourceMonthIndex]}-${String(inferredYear).slice(-2)}`;
    }

    return '';
};

const isUnusablePaymentPeriod = (value: string) => !value || /^(?:covered|period|month|year)$/i.test(cleanValue(value));

const parseAmount = (rawValue: string) => {
    const value = cleanValue(rawValue).replace(/[,\s]/g, '');
    const match = value.match(/-?\d+(?:\.\d{1,2})?/);
    if (!match) return null;
    const amount = Number(match[0]);
    return Number.isFinite(amount) ? amount : null;
};

const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: 'NGN',
        minimumFractionDigits: 2
    }).format(amount || 0);
};

const findLabelValue = (text: string, labels: string[]) => {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

    for (const label of labels) {
        const labelPattern = new RegExp(`\\b${escapeRegExp(label)}\\b\\s*(?:[:#=-]|is)?\\s*(.*)$`, 'i');

        for (let index = 0; index < lines.length; index += 1) {
            const match = lines[index].match(labelPattern);
            if (!match) continue;

            const sameLineValue = trimAtNextLabel(cleanValue(match[1]));
            if (sameLineValue && sameLineValue.length > 1) return sameLineValue;

            const nextLine = cleanValue(lines[index + 1] ?? '');
            if (nextLine && nextLine.length > 1) return trimAtNextLabel(nextLine);
        }
    }

    return '';
};

const normalizeCompanyName = (rawValue: string) => {
    const value = cleanValue(rawValue)
        .replace(/\s*\/\s*<[^>]*>?$/i, '')
        .replace(/\s*<[^>]*>?$/i, '')
        .replace(/\s*(?:\/|-)\s*(?:RC|TIN|TAX|ID|NO\.?).*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return value || 'Unknown Company';
};

const isValidReceiptNumber = (rawValue: string) => {
    const value = cleanValue(rawValue).replace(/\s+/g, '');
    if (!value) return false;
    if (nigerianStates.some(state => state.toLowerCase() === value.toLowerCase())) return false;
    if (/^(?:federal|unknown|receipt|payment|transaction|lagos|successful|completed|pending|approved|original|customer)$/i.test(value)) return false;
    if (/[.]/.test(value) || /\b(?:https?|www|view|details|json|receiptprint|login|aboutblank)\b/i.test(value)) return false;
    if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(value) || /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value)) return false;

    const hasDigit = /\d/.test(value);
    const hasKnownPrefix = /^(?:LGS|LIRS|LASG|CBS|FIRS|RRR|R-|PAY|TXN|PRN|KRN|TPM|E-TAX|ETAX|EIRS|EDSG|RIRS|RIVIRS|OGIRS|OGSG|DBIR|DIRS|KADIRS|KDIRS|BIRS|BIR|KGIRS|KWIRS|OIRS|ODIRS|OYIRS|PSIRS|JGIRS|NIRS|NSIRS|BSIRS|AKIRS|AIRS|ABIRS|ANIRS|ESIRS|KTSIRS|YIRS|ZIRS)/i.test(value);
    const looksReferenceLike = /^[A-Z0-9][A-Z0-9/_-]{5,}$/i.test(value);

    return hasDigit && (hasKnownPrefix || looksReferenceLike);
};

const cleanReceiptNumberCandidate = (rawValue: string) =>
    cleanValue(rawValue)
        .replace(/^[/\\:\s._#=-]+/, '')
        .replace(/[/\\:\s._#=-]+$/, '')
        .replace(/\s+/g, '');

const cleanRrrCandidate = (rawValue: string) => {
    const digits = cleanValue(rawValue).replace(/\D/g, '');
    if (digits.length === 12) {
        return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`;
    }
    return cleanReceiptNumberCandidate(rawValue);
};

const hasRemitaRrrLabel = (text: string) =>
    /\bRemita\s+Retrieval\s+Reference\b/i.test(text) ||
    (/\bRemita\s+Retrieval\b/i.test(text) && /\bReference\s*\(?RRR\)?\b/i.test(text)) ||
    /(?:^|\n)\s*RRR\b/i.test(text);

const extractRemitaRrr = (text: string) => {
    if (!hasRemitaRrrLabel(text)) return '';

    const rrrNumber = text.match(/\b(\d{4}[-\s]?\d{4}[-\s]?\d{4}|\d{12})\b/);
    if (!rrrNumber?.[1]) return '';

    const candidate = cleanRrrCandidate(rrrNumber[1]);
    return isValidReceiptNumber(candidate) ? candidate : '';
};

type ReceiptPattern = {
    regex: RegExp;
    cleaner?: (rawValue: string) => string;
    allowForLagos?: boolean;
    allowForPaydirect?: boolean;
};

const findReceiptPattern = (
    text: string,
    patterns: ReceiptPattern[],
    context: { isLagosReceipt: boolean; isPaydirectReceipt: boolean }
) => {
    for (const { regex, cleaner = cleanReceiptNumberCandidate, allowForLagos = true, allowForPaydirect = true } of patterns) {
        if (context.isLagosReceipt && !allowForLagos) continue;
        if (context.isPaydirectReceipt && !allowForPaydirect) continue;
        const match = text.match(regex);
        if (!match?.[1]) continue;
        const candidate = cleaner(match[1]);
        if (isValidReceiptNumber(candidate)) return candidate;
    }

    return '';
};

const extractCompanyName = (text: string) => {
    const labelled = findLabelValue(text, [
        'Taxpayer Name',
        'Payer Name',
        'Company Name',
        'Name of Taxpayer',
        'Customer Name',
        'Remitter Name',
        'Paid By',
        'Taxpayer'
    ]);
    if (labelled) return normalizeCompanyName(labelled);

    const likelyCompanyLine = text
        .split('\n')
        .map(line => cleanValue(line))
        .find(line =>
            /\b(?:limited|ltd|plc|llc|inc|enterprise|enterprises|company|nigeria)\b/i.test(line) &&
            !/\b(?:revenue|receipt|payment|service|internal|federal|state|tax|amount)\b/i.test(line)
        );

    return normalizeCompanyName(likelyCompanyLine || '');
};

const extractReceiptNumber = (text: string, stateHint = '') => {
    const receiptContextText = `${stateHint}\n${text}`;
    const context = {
        isLagosReceipt: /\blagos\b/i.test(receiptContextText),
        isPaydirectReceipt: /\bpay\s*direct|paydirect|paydirect[_\s-]*new|edo[_\s-]*state[_\s-]*paydirect/i.test(receiptContextText)
    };

    const highestPriorityPatterns: ReceiptPattern[] = [
        { regex: /^\s*(\d{6,10}\/[A-Z0-9]{6,})\b/im },
        { regex: /(?:^|\n)\s*(?:Official\s+)?(?:e-?\s*)?Receipt\s*(?:No\.?|Number|#|ID)\s*[:#=-]?\s*([A-Z0-9][A-Z0-9/_-]{4,30})/im },
        { regex: /(?:^|\n)\s*Receipt\s*[:#=-]\s*([A-Z0-9][A-Z0-9/_-]{4,30})/im },
        { regex: /(?:^|\n)\s*(?:Payment|Tax)\s+Receipt\s*(?:No\.?|Number|#|ID)\s*[:#=-]?\s*([A-Z0-9][A-Z0-9/_-]{4,30})/im },
        {
            regex: /(?:Remita\s+Retrieval\s+Reference(?:\s*\(?RRR\)?)?|RRR)\s*[:#=-]*\s*(\d{4}[-\s]?\d{4}[-\s]?\d{4}|\d{12})/i,
            cleaner: cleanRrrCandidate
        },
        { regex: /(?:^|\n)\s*KRN\s*[:#=-]?\s*(\d{12})/im, cleaner: cleanRrrCandidate, allowForPaydirect: false },
        { regex: /(?:Session\s*ID)\s*[:#=-]?\s*([0-9]{10,40})/i, allowForPaydirect: false }
    ];
    const highestPriorityReceiptNumber = findReceiptPattern(text, highestPriorityPatterns, context);
    if (highestPriorityReceiptNumber) return highestPriorityReceiptNumber;

    const remitaRrr = extractRemitaRrr(text);
    if (remitaRrr) return remitaRrr;

    if (context.isPaydirectReceipt) return '';

    const stateSpecificPatterns: ReceiptPattern[] = [
        { regex: /(?:CBS\s*(?:Ref|Reference|No\.?|Number)?\s*[:#=-]*\s*)([A-Z0-9][A-Z0-9/_-]{5,30})/i },
        { regex: /(?:Payment\s*(?:Ref\.?|Reference|No\.?|Number|ID|Code)\s*[:#=-]*\s*)([A-Z0-9][A-Z0-9/_-]{5,30})/i, allowForPaydirect: false },
        { regex: /(?:Bill\s*(?:Ref|Reference|No\.?|Number)\s*[:#=-]*\s*)([A-Z0-9][A-Z0-9/_-]{5,30})/i },
        { regex: /\b((?:LGS|LIRS|LASG|CBS)[-_]?(?:REC|PAY|REF)?[-_]?[A-Z0-9][A-Z0-9/_-]{5,30})\b/i },
        { regex: /(?:TaxPro\s*Max|Document\s*No\.?|Doc\s*No\.?)\s*[:#=-]*\s*([A-Z0-9][A-Z0-9/_-]{5,30})/i },
        { regex: /(?:PRN|Payment\s*Registration\s*Number|Payment\s*Reference\s*Number)\s*[:#=-]*\s*([A-Z0-9][A-Z0-9/_-]{5,30})/i },
        { regex: /(?:FIRS|Assessment)\s*(?:No\.?|Number|Receipt\s*No\.?)\s*[:#=-]*\s*([A-Z0-9][A-Z0-9/_-]{5,30})/i, allowForLagos: false },
        { regex: /\b((?:EIRS|EDSG|RIRS|RIVIRS|OGIRS|OGSG|DBIR|DIRS|KADIRS|KDIRS|BIRS|BIR|KGIRS|KWIRS|OIRS|ODIRS|OYIRS|PSIRS|JGIRS|NIRS|NSIRS|BSIRS|AKIRS|AIRS|ABIRS|ANIRS|ESIRS|KTSIRS|YIRS|ZIRS)[-_]?(?:REC|RCPT|REF|PAY|TXN)?[-_]?[A-Z0-9][A-Z0-9/_-]{5,30})\b/i },
        { regex: /(?:Agency\s*Ref|Tracking\s*(?:Ref|ID|No\.?))\s*[:#=-]*\s*([A-Z0-9][A-Z0-9/_-]{5,30})/i }
    ];

    const stateSpecificReceiptNumber = findReceiptPattern(text, stateSpecificPatterns, context);
    if (stateSpecificReceiptNumber) return stateSpecificReceiptNumber;

    const genericPatterns: ReceiptPattern[] = [
        { regex: /(?:Receipt\s*(?:No\.?|Number|#|ID)?\s*[:#=-]*\s*)([A-Z0-9][A-Z0-9/_-]{4,30})/i },
        { regex: /(?:Transaction\s*(?:ID|Ref|Reference|No\.?|#)?\s*[:#=-]*\s*)([A-Z0-9][A-Z0-9/_-]{5,35})/i },
        { regex: /(?:e-?Receipt|Slip\s*(?:No\.?|Number)?\s*[:#=-]*\s*)([A-Z0-9][A-Z0-9/_-]{4,30})/i },
        { regex: /(?:Teller\s*(?:No\.?|Number)|Bank\s*Ref)\s*[:#=-]*\s*([A-Z0-9][A-Z0-9/_-]{4,30})/i },
        { regex: /(?:Ref(?:erence)?\s*(?:No\.?|Number|#)?\s*[:#=-]*\s*)([A-Z0-9][A-Z0-9/_-]{5,30})/i }
    ];

    const genericReceiptNumber = findReceiptPattern(text, genericPatterns, context);
    if (genericReceiptNumber) return genericReceiptNumber;

    const lowConfidenceFallbackPatterns: ReceiptPattern[] = [
        { regex: /(?:Assessment\s*(?:Ref|Reference|No\.?|Number)?\s*[:#=-]*)([A-Z0-9][A-Z0-9/_-]{5,30})/i, allowForLagos: false, allowForPaydirect: false },
        { regex: /\b((?:LGS|CBS|FIRS|TPM|PRN|RRR|EIRS|EDSG|RIRS|OGIRS|OGSG|DBIR|KADIRS|KDIRS|BIRS|R-)[A-Z0-9\-/]{5,35})\b/i, allowForPaydirect: false }
    ];
    const fallbackReceiptNumber = findReceiptPattern(text, lowConfidenceFallbackPatterns, context);
    if (fallbackReceiptNumber) return fallbackReceiptNumber;

    const standalone = text.match(/\b(?:LGS|CBS|FIRS|TPM|PRN|RRR|EIRS|EDSG|RIRS|OGIRS|OGSG|DBIR|KADIRS|KDIRS|BIRS|R-)[A-Z0-9\-/]{5,}\b/i);
    const standaloneCandidate = standalone ? cleanReceiptNumberCandidate(standalone[0]) : '';
    return isValidReceiptNumber(standaloneCandidate) ? standaloneCandidate : '';
};

const extractPaymentDate = (text: string) => {
    const labelled = findLabelValue(text, [
        'Payment Date',
        'Date of Payment',
        'Transaction Date',
        'Receipt Date',
        'Value Date',
        'Date Paid',
        'Date'
    ]);
    const labelledDate = parseDateToIso(labelled);
    if (labelledDate) return labelledDate;

    const lines = text.split('\n');
    for (const line of lines) {
        const parsed = parseDateToIso(line);
        if (parsed) return parsed;
    }

    return '';
};

const extractPaymentPeriod = (text: string) => {
    const periodValuePattern =
        /(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\w*[-\s,/]*(?:20\d{2}|\d{2})(?:\s*\[[^\]]+\])?|\d{1,2}[-/.](?:20\d{2}|\d{2})|20\d{2})/i;

    const directPatterns = [
        new RegExp(`(?:Period\\s*Covered|Covered\\s*Period|Payment\\s*Period|Tax\\s*Period|Assessment\\s*Period|Revenue\\s*Period)\\s*[:#=-]?\\s*${periodValuePattern.source}`, 'i'),
        new RegExp(`(?:For\\s*the\\s*Month|Month\\s*of|Tax\\s*Month)\\s*[:#=-]?\\s*${periodValuePattern.source}`, 'i')
    ];

    for (const pattern of directPatterns) {
        const match = text.match(pattern);
        if (match?.[1]) return cleanValue(match[1]);
    }

    const labelled = findLabelValue(text, [
        'Period Covered',
        'Covered Period',
        'Payment Period',
        'Tax Period',
        'Period of Payment',
        'Assessment Period',
        'Revenue Period',
        'Month'
    ]);

    const cleanedLabelled = cleanValue(labelled).replace(/^covered\b\s*[:#=-]?\s*/i, '');
    return isUnusablePaymentPeriod(cleanedLabelled) ? '' : cleanedLabelled;
};

const extractTaxType = (text: string) => {
    const labelled = findLabelValue(text, [
        'Revenue Item',
        'Tax Type',
        'Type of Tax',
        'Description',
        'Payment Description',
        'Revenue Description',
        'Purpose'
    ]);

    const searchArea = `${labelled}\n${text}`;
    if (/\b(?:withholding\s+vat|wvat)\b/i.test(searchArea)) return 'WVAT';
    if (/\b(?:pay[-\s]*as[-\s]*you[-\s]*earn|paye)\b/i.test(searchArea)) return 'PAYE';
    if (/\bdevelopment\s+levy\b/i.test(searchArea)) return 'Development Levy';

    const whtLine = searchArea
        .split('\n')
        .map(line => cleanValue(line))
        .find(line => /\b(?:withholding\s+tax|wht)\b/i.test(line));

    if (whtLine) {
        const detailMatch = whtLine.match(/\bwithholding\s+tax\s+(?:on|for)?\s*(.{3,60})$/i);
        if (detailMatch) return `WHT on ${cleanValue(detailMatch[1])}`;
        return 'WHT';
    }

    if (/\bvat\b/i.test(searchArea)) return 'VAT';
    if (searchArea.split('\n').some(line => /^taxes?$/i.test(cleanValue(line)))) return 'Tax';
    if (labelled) return labelled;
    return '';
};

const normalizeTaxTypeForSource = (rawValue: string, sourceFile: string) => {
    const value = cleanValue(rawValue);
    const source = sourceFile.replace(/[_-]+/g, ' ');

    if (/\b(?:dev(?:elopment)?\s+levy)\b/i.test(source)) return 'Development Levy';
    if ((value === '' || /^vat$/i.test(value) || /^igr tax$/i.test(value)) && /\bpaye\b/i.test(source)) return 'PAYE';
    if (!value && /\bwvat\b/i.test(source)) return 'WVAT';
    if (!value && /\bwht\b/i.test(source)) return 'WHT';

    return value;
};

const inferStateFromTaxContext = (taxType: string, receiptNumber: string) => {
    const normalizedTaxType = cleanValue(taxType);
    const normalizedReceiptNumber = cleanReceiptNumberCandidate(receiptNumber);

    if (/^W(?:HT|VAT)\b/i.test(normalizedTaxType) && /^\d{12}$/.test(normalizedReceiptNumber)) {
        return 'Federal';
    }

    return '';
};

const normalizeState = (rawValue: string, fullText = '') => {
    const value = cleanValue(rawValue);
    const combined = `${value}\n${fullText}`;

    if (/\b(?:fct|fctirs|fstirs|federal\s+capital\s+territory|abuja\s+internal\s+revenue)\b/i.test(combined)) {
        return 'FCT';
    }

    if (/\b(?:firs|federal\s+inland\s+revenue|federal\s+govt|federal government)\b/i.test(combined)) {
        return 'Federal';
    }

    if (/\b(?:cross\s*river|crossrivers?|cirs|crirs)\b/i.test(combined)) {
        return 'Cross River';
    }

    if (/\b(?:kirs|kano\s+internal\s+revenue|kano\s+state\s+electronic\s+revenue|kano\s+state\s+revenue)\b/i.test(combined)) {
        return 'Kano';
    }

    for (const state of nigerianStates) {
        const statePattern = escapeRegExp(state).replace(/\\ /g, '[\\s_-]+');
        const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${statePattern}(?:[\\s_-]+state)?(?=$|[^A-Za-z0-9])`, 'i');
        if (pattern.test(combined)) {
            return state === 'FCT' ? 'FCT' : state;
        }
    }

    return value.replace(/\s+state$/i, '') || '';
};

const extractState = (text: string) => {
    const labelled = findLabelValue(text, [
        'State',
        'Tax Authority',
        'Revenue Authority',
        'Receiving State',
        'Authority'
    ]);
    return normalizeState(labelled, text);
};

const extractAmount = (text: string) => {
    const amountNumberPattern = /([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d{1,2})?|[0-9]{4,}(?:\.\d{1,2})?)/;
    const collectAmounts = (pattern: RegExp) => {
        const amounts: number[] = [];
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const rawAmount = match[1];
            const compactAmount = cleanValue(rawAmount).replace(/[,\s]/g, '');
            if (!/[,.]/.test(rawAmount) && /^\d{8,}$/.test(compactAmount)) {
                if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
                continue;
            }
            const amount = parseAmount(rawAmount);
            if (amount !== null) amounts.push(amount);
            if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
        }
        return amounts;
    };
    const labelledAmountPatterns = [
        new RegExp(`(?:Total\\s+Amount\\s+Paid|Grand\\s+Total|Amount\\s*To\\s*Pay|Amount\\s+Paid|Payment\\s+Amount|Total)\\s*(?:\\([^)]*\\))?\\s*[:#=-]?[\\s\\S]{0,50}?${amountNumberPattern.source}`, 'gi'),
        new RegExp(`\\bAmount\\s*(?:\\([^)]*\\))?\\s*[:#=-]?[\\s\\S]{0,80}?${amountNumberPattern.source}`, 'gi')
    ];

    const labelledCandidates = labelledAmountPatterns
        .flatMap(pattern => collectAmounts(pattern))
        .filter(amount => amount > 0);
    if (labelledCandidates.length) return Math.max(...labelledCandidates);

    const labelled = findLabelValue(text, [
        'Total Amount Paid',
        'Total Amount',
        'Amount Paid',
        'Amount Remitted',
        'Payment Amount',
        'Amount'
    ]);
    const labelledAmount = parseAmount(labelled);
    if (labelledAmount !== null) return labelledAmount;

    const matches = collectAmounts(/(?:NGN\.?|₦|=N=|=|\bN\.?\b)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi);

    if (matches.length === 0) {
        const plainAmounts = collectAmounts(/\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.\d{1,2})?)\b/g);
        return plainAmounts.length ? Math.max(...plainAmounts) : 0;
    }

    return Math.max(...matches);
};

const normalizeResult = (raw: Partial<ScannerResult>, sourceFile: string, receiptText = ''): ScannerResult => {
    const paymentDate = parseDateToIso(raw.paymentDate ?? '') || cleanValue(raw.paymentDate);
    const rawPaymentPeriod = cleanValue(raw.paymentPeriod);
    const sourceFilePeriod = normalizeSourceFilePeriod(sourceFile, paymentDate);
    let paymentPeriodSource: PeriodSource = 'missing';
    let paymentPeriod = '';

    if (rawPaymentPeriod && !isUnusablePaymentPeriod(rawPaymentPeriod)) {
        paymentPeriod = normalizePeriod(rawPaymentPeriod, paymentDate);
        paymentPeriodSource = 'receipt';
    } else if (sourceFilePeriod) {
        paymentPeriod = sourceFilePeriod;
        paymentPeriodSource = 'filename';
    } else if (paymentDate) {
        paymentPeriod = derivePreviousPeriod(paymentDate);
        paymentPeriodSource = paymentPeriod ? 'payment-date' : 'missing';
    }

    const amount =
        typeof raw.amount === 'number'
            ? raw.amount
            : parseAmount(String(raw.amount ?? '')) ?? 0;
    const receiptNumber = cleanValue(raw.receiptNumber);
    const normalizedTaxType = normalizeTaxTypeForSource(raw.taxType ?? '', sourceFile);
    const taxDetails = normalizeTaxDetails(normalizedTaxType, receiptText);
    const taxType = taxDetails.taxType;
    const identifierType = raw.identifierType ?? detectIdentifierType(receiptText, receiptNumber);
    const state = normalizeState(raw.state ?? '', sourceFile) || inferStateFromTaxContext(taxType, receiptNumber);
    const assessment = assessReceiptReview({
        paymentDate,
        paymentPeriod,
        paymentPeriodSource,
        receiptNumber,
        identifierType,
        taxType,
        amount
    });

    return {
        identityKey: cleanValue(raw.identityKey),
        companyName: normalizeCompanyName(raw.companyName ?? ''),
        paymentDate,
        paymentDateDisplay: formatDateDisplay(paymentDate),
        paymentPeriod,
        paymentPeriodSource,
        receiptNumber,
        identifierType,
        taxType,
        amount,
        remarks: cleanValue(raw.remarks) || taxDetails.remarks,
        state,
        sourceFile,
        ...assessment,
        reviewed: Boolean(raw.reviewed)
    };
};

const parseReceiptText = (text: string, sourceFile: string) => {
    const { candidates, duplicateCount } = extractReceiptCandidatesWithSummary(normalizeWhitespace(text));

    const rows = candidates
        .map(candidate => {
            const state = extractState(candidate.text);

            const result = normalizeResult(
                {
                    identityKey: candidate.identityKey,
                    companyName: extractCompanyName(candidate.text),
                    paymentDate: extractPaymentDate(candidate.text),
                    paymentPeriod: extractPaymentPeriod(candidate.text),
                    receiptNumber: extractReceiptNumber(candidate.text, state) || extractFallbackReceiptNumber(candidate.text),
                    taxType: extractTaxType(candidate.text),
                    amount: extractAmount(candidate.text) || extractFallbackAmount(candidate.text),
                    state
                },
                sourceFile,
                candidate.text
            );

            return result;
        })
        .filter(hasRecoverableReceiptData);

    return { rows, duplicateCount };
};

interface OcrSession {
    recognize: (imageLike: File | HTMLCanvasElement, label: string) => Promise<string>;
    terminate: () => Promise<unknown>;
}

const createOcrSession = async (onProgress: (message: string) => void): Promise<OcrSession> => {
    const { createWorker } = await import('tesseract.js');
    let activeLabel = 'OCR';
    const worker = await createWorker('eng', 1, {
        workerPath: `${ocrAssetBasePath}/worker.min.js`,
        corePath: ocrAssetBasePath,
        langPath: `${ocrAssetBasePath}/lang`,
        gzip: true,
        logger: (message: any) => {
            if (message.status && typeof message.progress === 'number') {
                onProgress(`${activeLabel}: ${message.status} ${Math.round(message.progress * 100)}%`);
            }
        }
    } as any);

    return {
        recognize: async (imageLike, label) => {
            activeLabel = label;
            const result = await worker.recognize(imageLike as any);
            return result.data.text || '';
        },
        terminate: () => worker.terminate()
    };
};

const recognizeText = async (
    imageLike: File | HTMLCanvasElement,
    label: string,
    onProgress: (message: string) => void
) => {
    const session = await createOcrSession(onProgress);
    try {
        return await session.recognize(imageLike, label);
    } finally {
        await session.terminate();
    }
};

const scoreReceiptOcrText = (text: string) => {
    const signals: Array<[RegExp, number]> = [
        [/\bPAYMENT\s+RECEIPT\b/i, 25],
        [/Payment\s+Reference\s+Number|\bPRN\b/i, 30],
        [/\bReceipt\s*(?:No\.?|Number|#|ID)\b/i, 25],
        [/\bTotal\s+Amount\s+Paid\b|\bPayment\s+Amount\b/i, 20],
        [/\bPayment\s+Date\b|\bDate\s+of\s+Payment\b/i, 15],
        [/\bCustomer\s+Name\b|\bTaxpayer\s+Name\b|\bPayer\s+Name\b/i, 10]
    ];

    return signals.reduce((score, [pattern, weight]) => score + (pattern.test(text) ? weight : 0), 0) +
        Math.min(text.replace(/\s/g, '').length / 100, 10);
};

const rotateCanvas = (source: HTMLCanvasElement, degrees: 90 | -90) => {
    const target = document.createElement('canvas');
    const context = target.getContext('2d');
    if (!context) throw new Error('Could not initialize rotated PDF page renderer.');

    target.width = source.height;
    target.height = source.width;
    context.translate(target.width / 2, target.height / 2);
    context.rotate((degrees * Math.PI) / 180);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    return target;
};

const recognizePdfPage = async (
    canvas: HTMLCanvasElement,
    session: OcrSession,
    label: string
) => {
    const attempts: Array<{ label: string; getCanvas: () => HTMLCanvasElement }> = [
        { label, getCanvas: () => canvas },
        { label: `${label} (rotated right)`, getCanvas: () => rotateCanvas(canvas, 90) },
        { label: `${label} (rotated left)`, getCanvas: () => rotateCanvas(canvas, -90) }
    ];
    let bestText = '';
    let bestScore = -1;

    for (const attempt of attempts) {
        const text = await session.recognize(attempt.getCanvas(), attempt.label);
        const score = scoreReceiptOcrText(text);
        if (score > bestScore) {
            bestText = text;
            bestScore = score;
        }
        if (score >= 80) break;
    }

    return bestText;
};

const renderPageToCanvas = async (page: any) => {
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not initialize PDF page renderer.');

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas;
};

const extractPdfText = async (file: File, onProgress: (message: string) => void) => {
    const pdfjsLib = await import('pdfjs-dist');
    const pdfWorker = await import('pdfjs-dist/build/pdf.worker.mjs?url');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker.default;

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pageTexts: string[] = [];
    let ocrSession: OcrSession | null = null;

    try {
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            onProgress(`${file.name}: reading page ${pageNumber} of ${pdf.numPages}`);
            const page = await pdf.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const pageText = assemblePdfText(textContent.items as Array<{ str?: unknown; hasEOL?: boolean }>);

            if (pageText.length > 40) {
                pageTexts.push(pageText);
                continue;
            }

            const canvas = await renderPageToCanvas(page);
            ocrSession ??= await createOcrSession(onProgress);
            const ocrText = await recognizePdfPage(canvas, ocrSession, `${file.name} page ${pageNumber}`);
            pageTexts.push(ocrText);
        }
    } finally {
        await ocrSession?.terminate();
    }

    return pageTexts.join('\n\f\n');
};

const extractTextFromFile = async (file: File, onProgress: (message: string) => void) => {
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        return extractPdfText(file, onProgress);
    }
    return recognizeText(file, file.name, onProgress);
};

const normalizeStateKey = (state: string) => {
    let stateKey = state ? state.trim().toUpperCase() : 'UNKNOWN';
    stateKey = stateKey.replace(/\s+STATE$/i, '');
    if (stateKey === 'FIRS' || stateKey === 'FEDERAL GOVT' || stateKey === 'FEDERAL INLAND REVENUE') {
        stateKey = 'FEDERAL';
    }
    return stateKey || 'UNKNOWN';
};

const App: React.FC = () => {
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [scannerIsLoading, setScannerIsLoading] = useState(false);
    const [scannerResults, setScannerResults] = useState<ScannerResult[]>([]);
    const [scannerMessages, setScannerMessages] = useState<{ text: string; type: MessageType }[]>([]);
    const [showDownloadModal, setShowDownloadModal] = useState(false);
    const [progressText, setProgressText] = useState('');
    const [duplicateCount, setDuplicateCount] = useState(0);

    const handleFileChange = (files: FileList | null) => {
        if (!files) return;
        setSelectedFiles(Array.from(files));
        setScannerResults([]);
        setScannerMessages([]);
        setProgressText('');
        setDuplicateCount(0);
    };

    const handleDragOver = (event: React.DragEvent) => event.preventDefault();

    const handleDrop = (event: React.DragEvent) => {
        event.preventDefault();
        handleFileChange(event.dataTransfer.files);
    };

    const processFiles = async () => {
        setScannerIsLoading(true);
        setScannerMessages([]);
        setScannerResults([]);
        setProgressText('');
        setDuplicateCount(0);

        const uniqueKeys = new Set<string>();
        const results: ScannerResult[] = [];
        let duplicatesExcluded = 0;

        for (const file of selectedFiles) {
            if (file.size > 30 * 1024 * 1024) {
                setScannerMessages(previous => [
                    ...previous,
                    { text: `File skipped because it is larger than 30MB: ${file.name}`, type: 'warning' }
                ]);
                continue;
            }

            const isSupported =
                ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(file.type) ||
                /\.(pdf|png|jpe?g|webp)$/i.test(file.name);

            if (!isSupported) {
                setScannerMessages(previous => [
                    ...previous,
                    { text: `Skipped ${file.name}. Accepted files are PDF, PNG, JPG, and WebP.`, type: 'warning' }
                ]);
                continue;
            }

            try {
                const text = await extractTextFromFile(file, setProgressText);
                const parsed = parseReceiptText(text, file.name);
                const parsedRows = parsed.rows;
                duplicatesExcluded += parsed.duplicateCount;
                let addedCount = 0;
                let reviewCount = 0;

                for (const row of parsedRows) {
                    const key = createReceiptDeduplicationKey(row);
                    if (uniqueKeys.has(key)) {
                        duplicatesExcluded += 1;
                        continue;
                    }
                    uniqueKeys.add(key);
                    results.push(row);
                    addedCount += 1;
                    if (row.reviewIssues.length > 0) reviewCount += 1;
                }

                setScannerMessages(previous => [
                    ...previous,
                    {
                        text:
                            addedCount > 0
                                ? `Processed ${file.name}: ${addedCount} receipt(s) extracted.${reviewCount ? ` ${reviewCount} receipt(s) need review.` : ''}`
                                : `Processed ${file.name}: no new unique receipts found.`,
                        type: addedCount > 0 && reviewCount === 0 ? 'success' : 'warning'
                    }
                ]);
            } catch (error: any) {
                setScannerMessages(previous => [
                    ...previous,
                    { text: `Failed to process ${file.name}. ${error?.message || 'Review the file and try again.'}`, type: 'error' }
                ]);
            }
        }

        results.sort((a, b) => new Date(a.paymentDate || 0).getTime() - new Date(b.paymentDate || 0).getTime());
        setScannerResults(results);
        setDuplicateCount(duplicatesExcluded);
        setProgressText('');
        setScannerIsLoading(false);
    };

    const updateScannerResult = (
        index: number,
        field: 'paymentDate' | 'paymentPeriod' | 'state' | 'receiptNumber' | 'identifierType' | 'taxType' | 'amount' | 'remarks',
        value: string
    ) => {
        setScannerResults(previous => previous.map((row, rowIndex) => {
            if (rowIndex !== index) return row;

            const updated: ScannerResult = {
                ...row,
                [field]: field === 'amount' ? Number(value) : value,
                reviewed: false
            };

            if (field === 'paymentDate') updated.paymentDateDisplay = formatDateDisplay(value);
            if (field === 'paymentPeriod') updated.paymentPeriodSource = value ? 'receipt' : 'missing';
            if (field === 'receiptNumber' && row.identifierType === 'Missing' && value) updated.identifierType = 'Other';

            const assessment = assessReceiptReview(updated);
            return { ...updated, ...assessment };
        }));
    };

    const confirmScannerResult = (index: number) => {
        setScannerResults(previous => previous.map((row, rowIndex) => {
            if (rowIndex !== index) return row;
            const hasMissingRequiredField = row.reviewIssues.some(issue => /missing|invalid/i.test(issue));
            return hasMissingRequiredField ? row : { ...row, reviewed: true };
        }));
    };

    const receiptsNeedingReview = scannerResults.filter(row => row.reviewIssues.length > 0 && !row.reviewed).length;
    const readyReceiptCount = scannerResults.length - receiptsNeedingReview;
    const extractedTotal = scannerResults.reduce((sum, row) => sum + (row.amount || 0), 0);
    const canDownload = scannerResults.length > 0 && receiptsNeedingReview === 0;

    const handleDownloadClick = () => {
        if (!canDownload) return;
        setShowDownloadModal(true);
    };

    const handleDownloadConfirm = (type: 'standard' | 'upload') => {
        if (!canDownload) return;
        setShowDownloadModal(false);
        void downloadScannerExcel(type);
    };

    const downloadScannerExcel = async (templateType: 'standard' | 'upload') => {
        const XLSX = await import('xlsx-js-style');
        const wb = XLSX.utils.book_new();
        const sortedResults = [...scannerResults].sort(
            (a, b) => new Date(a.paymentDate || 0).getTime() - new Date(b.paymentDate || 0).getTime()
        );

        const dataByState: { [key: string]: ScannerResult[] } = {};
        sortedResults.forEach(row => {
            const stateKey = normalizeStateKey(row.state);
            if (!dataByState[stateKey]) dataByState[stateKey] = [];
            dataByState[stateKey].push(row);
        });

        if (templateType === 'upload') {
            const headers = ['REVENUE ITEM', 'DATE OF PAYMENT', 'AMOUNT PAID', 'RECEIPT NUMBER', 'PERIOD OF PAYMENT'];

            for (const [state, rows] of Object.entries(dataByState)) {
                const dataRows = rows.map(row => {
                    let displayTaxType = row.taxType;
                    const upperTax = displayTaxType.toUpperCase();

                    if (
                        upperTax.includes('LAGOS REVENUE PAYMENT') ||
                        upperTax === 'REVENUE PAYMENT' ||
                        upperTax === 'REVENUE RECEIPT' ||
                        upperTax.includes('PAY AS YOU EARN')
                    ) {
                        displayTaxType = 'PAYE';
                    }

                    const isPaye = displayTaxType.toUpperCase().includes('PAYE');
                    let periodVal = row.paymentPeriod;
                    const parts = row.paymentPeriod.split('-');

                    if (parts.length === 2) {
                        const monthMap: { [key: string]: string } = {
                            Jan: 'JANUARY',
                            Feb: 'FEBRUARY',
                            Mar: 'MARCH',
                            Apr: 'APRIL',
                            May: 'MAY',
                            Jun: 'JUNE',
                            Jul: 'JULY',
                            Aug: 'AUGUST',
                            Sep: 'SEPTEMBER',
                            Oct: 'OCTOBER',
                            Nov: 'NOVEMBER',
                            Dec: 'DECEMBER'
                        };
                        const month = parts[0];
                        const year = parts[1].length === 2 ? `20${parts[1]}` : parts[1];
                        periodVal = isPaye ? monthMap[month] || month.toUpperCase() : year;
                    } else {
                        const date = new Date(row.paymentDate);
                        if (!Number.isNaN(date.getTime())) {
                            periodVal = isPaye
                                ? date.toLocaleString('default', { month: 'long' }).toUpperCase()
                                : date.getFullYear().toString();
                        }
                    }

                    return [displayTaxType, row.paymentDate ? new Date(row.paymentDate) : undefined, row.amount, row.receiptNumber, periodVal];
                });

                const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
                const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
                for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
                    const cellRef = XLSX.utils.encode_cell({ c: 1, r: rowIndex });
                    if (ws[cellRef] && rowIndex > 0) ws[cellRef].z = 'dd/mm/yyyy';
                }

                ws['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 35 }, { wch: 20 }];
                XLSX.utils.book_append_sheet(wb, ws, `Upload - ${state}`.substring(0, 31));
            }

            XLSX.writeFile(wb, 'Combined_Upload_Schedule.xlsx');
            return;
        }

        const thinBorder = {
            top: { style: 'thin' },
            bottom: { style: 'thin' },
            left: { style: 'thin' },
            right: { style: 'thin' }
        };
        const headerStyle = {
            font: { bold: true, sz: 11 },
            border: thinBorder,
            alignment: { horizontal: 'center', vertical: 'center' },
            fill: { fgColor: { rgb: 'EEEEEE' } }
        };
        const dataStyle = { border: thinBorder, font: { sz: 11 } };
        const titleStyle = { font: { bold: true, sz: 14 } };

        const getYearFromPeriod = (period: string | undefined, paymentDate: string) => {
            const value = period ? period.trim() : '';
            const matchEnd = value.match(/(\d{2,4})$/);
            if (matchEnd) return matchEnd[1].length === 2 ? `20${matchEnd[1]}` : matchEnd[1];

            const matchAny = value.match(/(\d{4})/);
            if (matchAny) return matchAny[1];

            const date = new Date(paymentDate);
            if (!Number.isNaN(date.getTime())) return date.getFullYear().toString();
            return 'Unknown';
        };

        for (const [state, stateRows] of Object.entries(dataByState)) {
            const dataByYear: { [key: string]: ScannerResult[] } = {};
            stateRows.forEach(row => {
                const year = getYearFromPeriod(row.paymentPeriod, row.paymentDate);
                if (!dataByYear[year]) dataByYear[year] = [];
                dataByYear[year].push(row);
            });

            for (const year in dataByYear) {
                const sheetData = dataByYear[year];
                const companyCounts = sheetData.reduce((acc, row) => {
                    const name = row.companyName || 'Unknown';
                    acc[name] = (acc[name] || 0) + 1;
                    return acc;
                }, {} as Record<string, number>);
                const titleName = Object.keys(companyCounts).reduce(
                    (a, b) => (companyCounts[a] > companyCounts[b] ? a : b),
                    'NASD PLC'
                );

                const ws = XLSX.utils.aoa_to_sheet([]);
                XLSX.utils.sheet_add_aoa(ws, [[titleName]], { origin: 'A1' });
                if (ws['A1']) ws['A1'].s = titleStyle;

                XLSX.utils.sheet_add_aoa(ws, [[`${state.toUpperCase()} REMITTANCE SCHEDULE FOR ${year}`]], { origin: 'A2' });
                if (ws['A2']) ws['A2'].s = { font: { bold: true, sz: 12 } };

                const headers = ['PAYMENT DATE', 'PERIOD', 'RECEIPT NUMBER', 'TAX TYPE', 'AMOUNT [N]', 'REMARKS'];
                XLSX.utils.sheet_add_aoa(ws, [headers], { origin: 'A4' });
                ['A4', 'B4', 'C4', 'D4', 'E4', 'F4'].forEach(ref => {
                    if (ws[ref]) ws[ref].s = headerStyle;
                });

                const groups: Record<string, ScannerResult[]> = {};
                sheetData.forEach(row => {
                    const key = row.taxType ? row.taxType.trim().toUpperCase() : 'OTHER';
                    if (!groups[key]) groups[key] = [];
                    groups[key].push(row);
                });

                let currentWriteRow = 4;
                Object.keys(groups)
                    .sort()
                    .forEach(groupKey => {
                        const groupRows = groups[groupKey].sort(
                            (a, b) => new Date(a.paymentDate || 0).getTime() - new Date(b.paymentDate || 0).getTime()
                        );

                        XLSX.utils.sheet_add_aoa(ws, [[groupKey]], { origin: { r: currentWriteRow, c: 0 } });
                        if (!ws['!merges']) ws['!merges'] = [];
                        ws['!merges'].push({ s: { r: currentWriteRow, c: 0 }, e: { r: currentWriteRow, c: 5 } });

                        const sectionCell = XLSX.utils.encode_cell({ r: currentWriteRow, c: 0 });
                        if (ws[sectionCell]) {
                            ws[sectionCell].s = {
                                font: { bold: true, sz: 11, color: { rgb: 'FFFFFF' } },
                                fill: { fgColor: { rgb: '6D28D9' } },
                                alignment: { horizontal: 'left' },
                                border: thinBorder
                            };
                        }

                        currentWriteRow += 1;
                        const rowsToAdd = groupRows.map(row => [
                            row.paymentDate ? new Date(row.paymentDate) : undefined,
                            row.paymentPeriod,
                            row.receiptNumber,
                            row.taxType,
                            row.amount,
                            row.remarks
                        ]);

                        XLSX.utils.sheet_add_aoa(ws, rowsToAdd, { origin: { r: currentWriteRow, c: 0 } });
                        rowsToAdd.forEach((_, index) => {
                            const rowIndex = currentWriteRow + index;
                            const dateRef = XLSX.utils.encode_cell({ c: 0, r: rowIndex });
                            if (ws[dateRef]) {
                                ws[dateRef].z = 'dd/mm/yyyy';
                                ws[dateRef].s = { ...dataStyle, alignment: { horizontal: 'center' } };
                            }
                            [1, 2, 3, 5].forEach(columnIndex => {
                                const ref = XLSX.utils.encode_cell({ c: columnIndex, r: rowIndex });
                                if (ws[ref]) ws[ref].s = dataStyle;
                            });
                            const amountRef = XLSX.utils.encode_cell({ c: 4, r: rowIndex });
                            if (ws[amountRef]) {
                                ws[amountRef].z = '#,##0.00';
                                ws[amountRef].s = dataStyle;
                            }
                        });

                        currentWriteRow += rowsToAdd.length;
                        const subTotal = groupRows.reduce((sum, row) => sum + (row.amount || 0), 0);
                        XLSX.utils.sheet_add_aoa(ws, [['', '', '', 'Subtotal', subTotal]], {
                            origin: { r: currentWriteRow, c: 0 }
                        });

                        const subLabelRef = XLSX.utils.encode_cell({ c: 3, r: currentWriteRow });
                        const subValRef = XLSX.utils.encode_cell({ c: 4, r: currentWriteRow });
                        if (ws[subLabelRef]) ws[subLabelRef].s = { font: { italic: true, sz: 10 }, alignment: { horizontal: 'right' } };
                        if (ws[subValRef]) {
                            ws[subValRef].z = '#,##0.00';
                            ws[subValRef].s = { font: { italic: true, sz: 10 }, border: { top: { style: 'thin' } } };
                        }

                        currentWriteRow += 2;
                    });

                const total = sheetData.reduce((sum, row) => sum + (row.amount || 0), 0);
                XLSX.utils.sheet_add_aoa(ws, [['', '', '', 'GRAND TOTAL', total]], { origin: { r: currentWriteRow, c: 0 } });

                const totalLabelRef = XLSX.utils.encode_cell({ c: 3, r: currentWriteRow });
                const totalValRef = XLSX.utils.encode_cell({ c: 4, r: currentWriteRow });
                if (ws[totalLabelRef]) ws[totalLabelRef].s = { font: { bold: true } };
                if (ws[totalValRef]) {
                    ws[totalValRef].z = '#,##0.00';
                    ws[totalValRef].s = { font: { bold: true }, border: { bottom: { style: 'double' } } };
                }

                ws['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 35 }, { wch: 18 }, { wch: 20 }, { wch: 30 }];
                XLSX.utils.book_append_sheet(wb, ws, `${state} ${year}`.substring(0, 31));
            }
        }

        const companyNames = Object.keys(
            scannerResults.reduce((acc, row) => {
                if (row.companyName) acc[row.companyName] = (acc[row.companyName] || 0) + 1;
                return acc;
            }, {} as Record<string, number>)
        );
        const dominantCompany = companyNames[0] || 'Unknown_Company';
        const safeCompanyName = dominantCompany.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
        XLSX.writeFile(wb, `${safeCompanyName}_Remittance_Schedule.xlsx`);
    };

    const isLoading = scannerIsLoading;

    return (
        <div className="w-full max-w-7xl mx-auto relative">
            {showDownloadModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4">
                    <div className="bg-slate-900 border border-white/10 rounded-xl p-6 max-w-md w-full shadow-2xl glow-border">
                        <h3 className="text-xl font-bold text-white mb-4">Select Schedule Format</h3>
                        <p className="text-slate-400 mb-6">Choose the workbook layout to generate.</p>
                        <div className="space-y-3">
                            <button
                                onClick={() => handleDownloadConfirm('upload')}
                                className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-medium transition-colors"
                            >
                                Portal Upload
                            </button>
                            <button
                                onClick={() => handleDownloadConfirm('standard')}
                                className="w-full py-3 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors"
                            >
                                Attachment Schedule
                            </button>
                        </div>
                        <button
                            onClick={() => setShowDownloadModal(false)}
                            className="mt-4 w-full py-2 text-slate-500 hover:text-slate-300 text-sm"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            <header className="mb-8 text-center border-b border-white/10 pb-6 relative">
                <h1 className="text-4xl font-bold text-slate-100 tracking-wider">REMITTANCE SCHEDULE TOOL</h1>
                <p className="text-slate-400 mt-2">Client-side receipt extraction and schedule export.</p>
            </header>

            <main>
                <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg p-6 mb-8 glow-border max-w-2xl mx-auto">
                    <div
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        className="border-2 border-dashed border-slate-700 rounded-lg p-8 text-center hover:border-violet-500 transition-colors"
                    >
                        <label htmlFor="file-upload" className="cursor-pointer">
                            <svg className="mx-auto h-12 w-12 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l-3.75 3.75M12 9.75l3.75 3.75M3 13.5v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6m-16-4.5c0-1.1.9-2 2-2h14c1.1 0 2 .9 2 2v2.25M7.5 16.5v-3.75m9 3.75v-3.75" />
                            </svg>
                            <span className="mt-2 block text-sm font-medium text-slate-200">
                                Drag and drop files here or <span className="text-violet-400">click to browse</span>
                            </span>
                            <span className="mt-1 block text-xs text-slate-500">PDF, PNG, JPG, WebP</span>
                        </label>
                        <input
                            id="file-upload"
                            name="file-upload"
                            type="file"
                            className="sr-only"
                            multiple
                            accept=".pdf,.png,.jpg,.jpeg,.webp"
                            aria-label="Upload receipt files"
                            onChange={event => handleFileChange(event.target.files)}
                        />
                    </div>

                    {selectedFiles.length > 0 && (
                        <div className="mt-4">
                            <h4 className="font-medium text-slate-300">Selected Files</h4>
                            <ul className="list-disc list-inside text-sm text-slate-400 mt-2">
                                {selectedFiles.map(file => (
                                    <li key={`${file.name}-${file.size}`}>{file.name}</li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <div className="mt-6 text-center">
                        <button
                            onClick={processFiles}
                            disabled={selectedFiles.length === 0 || isLoading}
                            className="inline-flex min-w-40 items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md shadow-lg text-white disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed btn-glow"
                        >
                            {isLoading && <div className="wht-spinner mr-3"></div>}
                            Process Files
                        </button>
                    </div>
                </div>

                <div className="space-y-6">
                    {scannerIsLoading && (
                        <div className="flex flex-col items-center justify-center bg-slate-900/50 backdrop-blur-sm p-8 rounded-xl shadow-lg glow-border">
                            <div className="spinner"></div>
                            <p className="mt-4 text-slate-400">Processing receipts...</p>
                            {progressText && <p className="mt-2 max-w-2xl text-center text-xs text-slate-500">{progressText}</p>}
                        </div>
                    )}

                    {scannerMessages.length > 0 && (
                        <div className="space-y-2">
                            {scannerMessages.map((message, index) => (
                                <div
                                    key={`${message.text}-${index}`}
                                    className={`p-4 rounded-md text-sm border break-words ${
                                        message.type === 'success'
                                            ? 'bg-teal-900/50 text-teal-200 border-teal-500/30'
                                            : message.type === 'error'
                                                ? 'bg-red-900/50 text-red-200 border-red-500/30'
                                                : 'bg-yellow-900/50 text-yellow-200 border-yellow-500/30'
                                    }`}
                                >
                                    {message.text}
                                </div>
                            ))}
                        </div>
                    )}

                    {scannerResults.length > 0 && (
                        <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden glow-border">
                            <div className="px-6 py-4 bg-slate-900/70 border-b border-white/10 flex flex-col gap-4 lg:flex-row lg:justify-between lg:items-center">
                                <div>
                                    <h2 className="text-lg font-semibold text-violet-300">Receipt Review</h2>
                                    <p className="mt-1 text-sm text-slate-400">Confirm highlighted fields before generating the schedule.</p>
                                </div>
                                <button
                                    onClick={handleDownloadClick}
                                    disabled={!canDownload}
                                    title={canDownload ? 'Generate the remittance schedule' : 'Resolve or confirm every review item first'}
                                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-teal-600 hover:bg-teal-700 transition-colors disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed"
                                >
                                    Download Schedule
                                </button>
                            </div>
                            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 p-4 border-b border-white/10 bg-slate-950/40">
                                <div className="rounded-lg border border-white/10 p-3">
                                    <p className="text-xs uppercase tracking-wider text-slate-500">Files</p>
                                    <p className="mt-1 text-xl font-semibold text-slate-100">{selectedFiles.length}</p>
                                </div>
                                <div className="rounded-lg border border-white/10 p-3">
                                    <p className="text-xs uppercase tracking-wider text-slate-500">Receipts</p>
                                    <p className="mt-1 text-xl font-semibold text-slate-100">{scannerResults.length}</p>
                                </div>
                                <div className="rounded-lg border border-white/10 p-3">
                                    <p className="text-xs uppercase tracking-wider text-slate-500">Ready</p>
                                    <p className="mt-1 text-xl font-semibold text-teal-200">{readyReceiptCount}</p>
                                </div>
                                <div className="rounded-lg border border-white/10 p-3">
                                    <p className="text-xs uppercase tracking-wider text-slate-500">Needs Review</p>
                                    <p className="mt-1 text-xl font-semibold text-yellow-200">{receiptsNeedingReview}</p>
                                </div>
                                <div className="rounded-lg border border-white/10 p-3">
                                    <p className="text-xs uppercase tracking-wider text-slate-500">Total</p>
                                    <p className="mt-1 text-base font-semibold text-slate-100">{formatCurrency(extractedTotal)}</p>
                                    {duplicateCount > 0 && <p className="mt-1 text-xs text-slate-500">{duplicateCount} duplicate(s) excluded</p>}
                                </div>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="min-w-full text-sm">
                                    <thead className="bg-slate-900/70">
                                        <tr>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Date</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Period</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Tax Type</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Receipt / ID</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">ID Type</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Amount</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Remarks</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">State</th>
                                            <th className="px-3 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Review</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/10">
                                        {scannerResults.map((result, index) => {
                                            const needsReview = result.reviewIssues.length > 0 && !result.reviewed;
                                            const hasMissingRequiredField = result.reviewIssues.some(issue => /missing|invalid/i.test(issue));
                                            const inputClass = 'w-36 rounded-md border border-white/10 bg-slate-950/60 px-2 py-2 text-sm text-slate-200 focus:border-violet-400 focus:outline-none';

                                            return (
                                                <tr
                                                    key={`${result.identityKey}-${result.sourceFile}-${index}`}
                                                    className={`${needsReview ? 'bg-yellow-950/20' : 'hover:bg-slate-800/40'} transition-colors align-top`}
                                                >
                                                    <td className="px-3 py-3">
                                                        <input
                                                            type="date"
                                                            value={result.paymentDate}
                                                            onChange={event => updateScannerResult(index, 'paymentDate', event.target.value)}
                                                            aria-label={`Payment date for receipt ${index + 1}`}
                                                            className={inputClass}
                                                        />
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <input
                                                            value={result.paymentPeriod}
                                                            onChange={event => updateScannerResult(index, 'paymentPeriod', event.target.value)}
                                                            aria-label={`Payment period for receipt ${index + 1}`}
                                                            placeholder="Jan-26"
                                                            className={inputClass}
                                                        />
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <input
                                                            list="tax-type-options"
                                                            value={result.taxType}
                                                            onChange={event => updateScannerResult(index, 'taxType', event.target.value)}
                                                            aria-label={`Tax type for receipt ${index + 1}`}
                                                            className={inputClass}
                                                        />
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <input
                                                            value={result.receiptNumber}
                                                            onChange={event => updateScannerResult(index, 'receiptNumber', event.target.value)}
                                                            aria-label={`Receipt identifier for receipt ${index + 1}`}
                                                            className="w-52 rounded-md border border-white/10 bg-slate-950/60 px-2 py-2 text-sm text-slate-200 focus:border-violet-400 focus:outline-none"
                                                        />
                                                        <p className="mt-1 max-w-52 truncate text-xs text-slate-500" title={result.sourceFile}>{result.sourceFile}</p>
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <select
                                                            value={result.identifierType}
                                                            onChange={event => updateScannerResult(index, 'identifierType', event.target.value)}
                                                            aria-label={`Identifier type for receipt ${index + 1}`}
                                                            className="w-44 rounded-md border border-white/10 bg-slate-950/60 px-2 py-2 text-sm text-slate-200 focus:border-violet-400 focus:outline-none"
                                                        >
                                                            {identifierTypes.map(type => <option key={type} value={type}>{type}</option>)}
                                                        </select>
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <input
                                                            type="number"
                                                            min="0"
                                                            step="0.01"
                                                            value={result.amount || ''}
                                                            onChange={event => updateScannerResult(index, 'amount', event.target.value)}
                                                            aria-label={`Amount for receipt ${index + 1}`}
                                                            className={inputClass}
                                                        />
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <input
                                                            value={result.remarks}
                                                            onChange={event => updateScannerResult(index, 'remarks', event.target.value)}
                                                            aria-label={`Remarks for receipt ${index + 1}`}
                                                            className="w-48 rounded-md border border-white/10 bg-slate-950/60 px-2 py-2 text-sm text-slate-200 focus:border-violet-400 focus:outline-none"
                                                        />
                                                    </td>
                                                    <td className="px-3 py-3">
                                                        <input
                                                            value={result.state}
                                                            onChange={event => updateScannerResult(index, 'state', event.target.value)}
                                                            aria-label={`Optional state for receipt ${index + 1}`}
                                                            className={inputClass}
                                                        />
                                                    </td>
                                                    <td className="min-w-64 px-3 py-3">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`rounded-full px-2 py-1 text-xs font-medium ${
                                                                result.reviewed || result.reviewIssues.length === 0
                                                                    ? 'bg-teal-900/50 text-teal-200'
                                                                    : result.confidence === 'low'
                                                                        ? 'bg-red-900/50 text-red-200'
                                                                        : 'bg-yellow-900/50 text-yellow-200'
                                                            }`}>
                                                                {result.reviewed ? 'Confirmed' : `${result.confidenceScore}% ${result.confidence}`}
                                                            </span>
                                                        </div>
                                                        {needsReview && (
                                                            <ul className="mt-2 space-y-1 text-xs text-yellow-200">
                                                                {result.reviewIssues.map(issue => <li key={issue}>• {issue}</li>)}
                                                            </ul>
                                                        )}
                                                        {result.reviewIssues.length > 0 && (
                                                            <button
                                                                type="button"
                                                                onClick={() => confirmScannerResult(index)}
                                                                disabled={hasMissingRequiredField || result.reviewed}
                                                                className="mt-2 rounded-md border border-violet-400/40 px-3 py-1 text-xs text-violet-200 hover:bg-violet-900/40 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-500"
                                                            >
                                                                {result.reviewed ? 'Confirmed' : 'Confirm values'}
                                                            </button>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                                <datalist id="tax-type-options">
                                    {commonTaxTypes.map(type => <option key={type} value={type} />)}
                                </datalist>
                            </div>
                        </div>
                    )}
                </div>
            </main>

            <footer className="fixed bottom-4 right-4 text-xs text-slate-500 font-medium opacity-80 z-50">
                &copy; IBRAHIM O.
            </footer>
        </div>
    );
};

export default App;
