export interface PdfTextItemLike {
    str?: unknown;
    hasEOL?: boolean;
}

const cleanReference = (value: string) =>
    value
        .replace(/\s+/g, '')
        .replace(/^[|:/#=-]+|[|:/#=-]+$/g, '');

export const assemblePdfText = (items: PdfTextItemLike[]) =>
    items
        .map(item => {
            const value = String(item.str ?? '').trim();
            if (!value) return item.hasEOL ? '\n' : '';
            return `${value}${item.hasEOL ? '\n' : ' '}`;
        })
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

export const extractFallbackReceiptNumber = (text: string) => {
    const patterns = [
        /(?:^|\n)[ \t]*(\d(?:[ \t]*\d){5,9}[ \t]*\/[ \t]*[A-Z0-9](?:[ \t]*[A-Z0-9]){5,})[ \t]*(?=\n|$)/im,
        />[ \t]*(\d(?:[ \t]*\d){5,9}[ \t]*\/[ \t]*[A-Z0-9](?:[ \t]*[A-Z0-9]){5,})[ \t]*\/\//i,
        /Receipt\s*(?:No\.?|Number|#|ID)\s*[:#=-]?\s*([A-Z0-9](?:\s*[A-Z0-9/_-]){5,})/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        const candidate = cleanReference(match[1]);
        if (/\d/.test(candidate) && candidate.length >= 6) return candidate;
    }

    return '';
};

export const extractFallbackAmount = (text: string) => {
    const amountNumber = String.raw`([0-9]{1,3}(?:\s*,\s*[0-9]{3})+(?:\s*\.\s*[0-9]{1,2})?|[0-9]{4,}(?:\s*\.\s*[0-9]{1,2})?)`;
    const patterns = [
        new RegExp(`(?:Total\\s+Amount\\s+Paid|Grand\\s+Total|Amount\\s+Paid|Payment\\s+Amount|Amount)[\\s\\S]{0,100}?(?:NGN\\.?|₦|=N=|\\bN\\.?\\b)?\\s*${amountNumber}`, 'i'),
        new RegExp(`(?:NGN\\.?|₦|=N=|\\bN\\.?\\b)\\s*${amountNumber}`, 'i')
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        const amount = Number(match[1].replace(/[\s,]/g, ''));
        if (Number.isFinite(amount) && amount > 0) return amount;
    }

    return 0;
};

export const hasRecoverableReceiptData = (row: {
    receiptNumber: string;
    amount: number;
    paymentDate: string;
    paymentPeriod: string;
    taxType: string;
}) =>
    Boolean(
        row.receiptNumber ||
        row.amount > 0 ||
        row.paymentDate ||
        row.paymentPeriod ||
        row.taxType
    );
