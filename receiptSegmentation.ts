export interface ReceiptCandidate {
    text: string;
    identityKey: string;
}

export interface ReceiptCandidateSummary {
    candidates: ReceiptCandidate[];
    duplicateCount: number;
}

const samePageReceiptStartPatterns = [
    /(?:FIRS\s+TAXPROMAX\s+)?PAYMENT\s+RECEIPT\b/gi,
    /Payment\s+Reference\s+Number\s*(?:\(\s*PRN\s*\))?\s*[:#=-]?/gi,
    /REMITA\s+(?:PAYMENT\s+)?RECEIPT\b/gi,
    /REMITA\s+RETRIEVAL\s+REFERENCE\s*(?:\(\s*RRR\s*\))?\s*[:#=-]?/gi
];

const normalizeForSegmentation = (value: string) =>
    value
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

const collectMatchIndexes = (text: string, pattern: RegExp) => {
    const indexes: number[] = [];
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        indexes.push(match.index);
        if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }

    return indexes;
};

const splitAtIndexes = (text: string, indexes: number[]) => {
    const chunks = indexes
        .map((start, index) => {
            const prefix = index === 0 ? text.slice(0, start).trim() : '';
            const end = indexes[index + 1] ?? text.length;
            const body = text.slice(start, end).trim();
            return prefix ? `${prefix}\n${body}` : body;
        })
        .filter(chunk => chunk.length > 30);

    return chunks.length > 1 ? chunks : [text];
};

const splitPageReceiptChunks = (pageText: string) => {
    for (const pattern of samePageReceiptStartPatterns) {
        const indexes = collectMatchIndexes(pageText, pattern);
        if (indexes.length < 2) continue;

        const chunks = splitAtIndexes(pageText, indexes);
        if (chunks.length > 1) return chunks;
    }

    return [pageText];
};

const isReceiptStartChunk = (text: string) => {
    const hasLagosTopReference = /^\s*\d{6,10}\/[A-Z0-9]{6,}\b/im.test(text);
    const hasRemitaReference = /\b(?:RRR|Remita\s+Retrieval\s+Reference)\b/i.test(text);
    const hasStrongReceiptDetails =
        /\b(?:Payment\s+Date|Date\s+of\s+Payment|Total\s+Amount\s+Paid|Customer\s+Name|Taxpayer\s+Name|Payer\s+Name|Payment\s+Ref(?:erence)?\.?\s*Number|CBS\s*Reference)\b/i.test(text);
    const hasReceiptNumberLabel = /\bReceipt\s*(?:No\.?|Number|#|ID)\b/i.test(text);
    const hasReceiptHeading = /\bPAYMENT\s+RECEIPT\b/i.test(text);

    return hasLagosTopReference || hasRemitaReference || hasStrongReceiptDetails || hasReceiptNumberLabel || hasReceiptHeading;
};

const groupContinuationChunks = (chunks: string[]) => {
    const grouped: string[] = [];

    for (const chunk of chunks) {
        if (grouped.length === 0 || isReceiptStartChunk(chunk)) {
            grouped.push(chunk);
            continue;
        }

        grouped[grouped.length - 1] = `${grouped[grouped.length - 1]}\n${chunk}`;
    }

    return grouped;
};

const cleanIdentityValue = (value: string) =>
    value
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/^[|:/#=-]+|[|:/#=-]+$/g, '');

export const extractReceiptIdentity = (text: string) => {
    const identityPatterns: Array<[string, RegExp]> = [
        ['receipt', /Receipt\s*(?:No\.?|Number|#|ID)\s*[:#=-]?\s*([A-Z0-9][A-Z0-9|/_-]{5,})/i],
        ['prn', /Payment\s+Reference\s+Number\s*\(\s*PRN\s*\)\s*[:#=-]?\s*([A-Z0-9][A-Z0-9|/_-]{5,})/i],
        ['payment-ref', /Payment\s+Ref(?:erence)?\.?\s+Number\s*[:#=-]?\s*([A-Z0-9][A-Z0-9|/_-]{5,})/i],
        ['rrr', /(?:Remita\s+Retrieval\s+Reference|RRR)\s*(?:Number|No\.?)?\s*[:#=-]?\s*([A-Z0-9][A-Z0-9|/_-]{5,})/i],
        ['lagos-ref', /^\s*(\d{6,10}\/[A-Z0-9]{6,})\b/im]
    ];

    for (const [kind, pattern] of identityPatterns) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;

        const value = cleanIdentityValue(match[1]);
        if (value.length >= 6) return `${kind}:${value}`;
    }

    return '';
};

const fingerprintText = (text: string) => {
    const normalized = text.toUpperCase().replace(/\s+/g, ' ').trim();
    let hash = 2166136261;

    for (let index = 0; index < normalized.length; index += 1) {
        hash ^= normalized.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return `content:${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

export const extractReceiptCandidatesWithSummary = (text: string): ReceiptCandidateSummary => {
    const normalizedText = normalizeForSegmentation(text);
    if (!normalizedText) return { candidates: [], duplicateCount: 0 };

    const pages = normalizedText
        .split(/\n*\f\n*/g)
        .map(page => page.trim())
        .filter(page => page.length > 5);
    const pageChunks = (pages.length ? pages : [normalizedText]).flatMap(splitPageReceiptChunks);
    const groupedChunks = groupContinuationChunks(pageChunks);
    const seen = new Set<string>();
    const candidates: ReceiptCandidate[] = [];
    let duplicateCount = 0;

    for (const candidateText of groupedChunks) {
        const identityKey = extractReceiptIdentity(candidateText) || fingerprintText(candidateText);
        if (seen.has(identityKey)) {
            duplicateCount += 1;
            continue;
        }

        seen.add(identityKey);
        candidates.push({ text: candidateText, identityKey });
    }

    return { candidates, duplicateCount };
};

export const extractUniqueReceiptCandidates = (text: string): ReceiptCandidate[] =>
    extractReceiptCandidatesWithSummary(text).candidates;
