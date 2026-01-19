
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { GoogleGenAI, Type } from "@google/genai";

// --- Type Definitions ---
interface ScannerResult {
    companyName: string;
    paymentDate: string; // YYYY-MM-DD
    paymentDateDisplay: string; // DD/MM/YYYY
    paymentPeriod: string;
    receiptNumber: string;
    taxType: string;
    amount: number;
}

interface WHTExpense {
    id: string;
    description: string;
    amount: number;
    recipientType: 'company' | 'individual';
    isLiable: boolean;
    firsAmount: number;
    sirsAmount: number;
    exemptAmount: number;
    notes: string;
    category: string;
    createdAt: string;
}

interface WHTSummary {
    [category: string]: {
        exempted: number;
        dueToSirs: number;
        dueToFirs: number;
    };
}

// Fix: Add WHTTotals interface for explicit typing
interface WHTTotals {
    exempted: number;
    dueToSirs: number;
    dueToFirs: number;
}

// New interfaces for gross amount summary
interface WHTGrossSummary {
    [category: string]: {
        notLiable: number;
        liableToSirs: number;
        liableToFirs: number;
    };
}

interface WHTGrossTotals {
    notLiable: number;
    liableToSirs: number;
    liableToFirs: number;
}


// --- Helper Functions ---
const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
};

const fileToArrayBuffer = (file: File): Promise<ArrayBuffer> => {
     return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = (e) => resolve(e.target?.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: 'NGN',
        minimumFractionDigits: 2
    }).format(amount || 0);
};

// --- Main App Component ---
const App: React.FC = () => {
    // --- Global State ---
    const [isLoggedIn, setIsLoggedIn] = useState(false);
    const [accessCode, setAccessCode] = useState('');
    const [loginError, setLoginError] = useState('');
    const [activeTool, setActiveTool] = useState<'scanner' | 'analyzer'>('scanner');
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    const [ai, setAi] = useState<GoogleGenAI | null>(null);

    useEffect(() => {
        if (process.env.API_KEY) {
            setAi(new GoogleGenAI({ apiKey: process.env.API_KEY }));
        }
    }, []);
    
    // --- Scanner State ---
    const [scannerIsLoading, setScannerIsLoading] = useState(false);
    const [scannerResults, setScannerResults] = useState<ScannerResult[]>([]);
    const [scannerMessages, setScannerMessages] = useState<{ text: string, type: 'error' | 'success' | 'warning' }[]>([]);
    const [showDownloadModal, setShowDownloadModal] = useState(false);
    
    // --- WHT Analyzer State ---
    const [whtIsLoading, setWhtIsLoading] = useState(false);
    const [whtLoadingMessage, setWhtLoadingMessage] = useState('Analyzing file(s)... please wait.');
    const [whtErrors, setWhtErrors] = useState<string[]>([]);
    const [whtExpenses, setWhtExpenses] = useState<WHTExpense[]>([]);
    const [whtManualForm, setWhtManualForm] = useState({ description: '', amount: '', recipientType: 'company' as 'company' | 'individual' });


    // --- Handlers & Logic ---
    const handleLogin = () => {
        if (accessCode === '382699') {
            setIsLoggedIn(true);
            setLoginError('');
        } else {
            setLoginError('Invalid access code. Please try again.');
        }
    };
    
    const handleFileChange = (files: FileList | null) => {
        if (!files) return;
        setSelectedFiles(Array.from(files));
        setScannerResults([]);
        setScannerMessages([]);
        setWhtExpenses([]);
        setWhtErrors([]);
    };
    
    const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        handleFileChange(e.dataTransfer.files);
    };

    const switchTool = (tool: 'scanner' | 'analyzer') => {
        setActiveTool(tool);
        setSelectedFiles([]);
        setScannerResults([]);
        setScannerMessages([]);
        setWhtExpenses([]);
        setWhtErrors([]);
    };

    const processFiles = () => {
        if (activeTool === 'scanner') {
            processReceipts();
        } else if (activeTool === 'analyzer') {
            processWHTFile();
        }
    };
    
    // --- Scanner Logic ---
    const processReceipts = async () => {
        if (!ai) {
            setScannerMessages([{ text: "AI client not initialized.", type: 'error' }]);
            return;
        }
        setScannerIsLoading(true);
        setScannerMessages([]);
        setScannerResults([]);

        // Deduplication Set: Stores keys formatted as "receiptNumber-amount"
        const uniqueKeys = new Set<string>();
        const results: ScannerResult[] = [];

        for (const file of selectedFiles) {
            const maxSize = 19 * 1024 * 1024; // 19MB
            if (file.size > maxSize) {
                setScannerMessages(prev => [...prev, { text: `File skipped (too large): ${file.name}`, type: 'warning' }]);
                continue;
            }

            const mimeType = file.type;
            if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(mimeType)) {
                setScannerMessages(prev => [...prev, { text: `Skipped: ${file.name}. Scanner accepts PNG, JPG, WebP, or PDF.`, type: 'warning' }]);
                continue;
            }

            try {
                const base64Data = await fileToBase64(file);
                const result = await callScannerGeminiAPI(ai, base64Data, mimeType);
                if (result && result.companyName) {
                    const uniqueKey = `${result.receiptNumber.trim()}-${result.amount}`;
                    
                    if (uniqueKeys.has(uniqueKey)) {
                         setScannerMessages(prev => [...prev, { text: `Duplicate Receipt skipped: ${result.receiptNumber} in ${file.name}`, type: 'warning' }]);
                    } else {
                        uniqueKeys.add(uniqueKey);
                        results.push(result);
                        setScannerMessages(prev => [...prev, { text: `Successfully processed: ${file.name}`, type: 'success' }]);
                    }
                } else {
                    throw new Error("AI did not return valid data.");
                }
            } catch (error: any) {
                 setScannerMessages(prev => [...prev, { text: `Failed to process file: ${file.name}. ${error.message}`, type: 'error' }]);
            }
        }
        
        results.sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());
        setScannerResults(results);
        setScannerIsLoading(false);
    };
    
    const callScannerGeminiAPI = async (ai: GoogleGenAI, base64Data: string, mimeType: string): Promise<ScannerResult> => {
        const systemPrompt = `You are an expert accountant. Extract ONLY the following fields from this receipt file.
        - companyName: The name of the company that made the payment.
        - paymentDate: The date the payment was made (e.g., "21/01/2025"). Use ISO format YYYY-MM-DD.
        - paymentPeriod: The month/year the payment covers (e.g., "Jan-25"). If not explicitly stated, infer it as the month PRIOR to the paymentDate. For a payment in "January 2024", the period is "Dec-23".
        - receiptNumber: The unique receipt or transaction number. Do NOT use the "AssessRef" or "Assessment Reference". Prioritize the "Transaction" number.
        - taxType: The specific type of tax paid. Look closely at "Agency - Rev Code", "Service Description", or "Payment Details". Examples: "Development Levy", "WHT ON DIRECTOR'S FEES", "PAYE", "Business Premises". Do NOT use generic terms like "Lagos Revenue Payment" or "Revenue Receipt" if a specific tax name (like "Development Levy") is visible.
        - amount: The FINAL TOTAL amount paid. If the receipt has multiple amount fields (like 'Amount', 'Charges', 'VAT', 'Total'), you MUST select the 'Total', 'Total Paid', or 'Total Amount'. For example, if 'Amount' is 900 and 'Total' is 950, return 950.
        Return ONLY a single valid JSON object. Do not add markdown or any other text.`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [{ text: "Extract receipt data as JSON." }, { inlineData: { mimeType, data: base64Data } }] },
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        "companyName": { "type": Type.STRING },
                        "paymentDate": { "type": Type.STRING, "description": "Date in YYYY-MM-DD format" },
                        "paymentPeriod": { "type": Type.STRING, "description": "Period in Mon-YY format (e.g., Jan-25)" },
                        "receiptNumber": { "type": Type.STRING },
                        "taxType": { "type": Type.STRING },
                        "amount": { "type": Type.NUMBER }
                    },
                    required: ["companyName", "paymentDate", "paymentPeriod", "receiptNumber", "taxType", "amount"]
                }
            }
        });

        let data = JSON.parse(response.text);
        if (!data.paymentPeriod && data.paymentDate) {
            const date = new Date(data.paymentDate);
            date.setMonth(date.getMonth() - 1);
            data.paymentPeriod = `${date.toLocaleString('default', { month: 'short' })}-${date.getFullYear().toString().slice(-2)}`;
        }
        if (data.paymentDate) {
            const date = new Date(data.paymentDate);
            data.paymentDateDisplay = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
        }
        return data;
    };
    
    const handleDownloadClick = () => {
        setShowDownloadModal(true);
    };

    const handleDownloadConfirm = (type: 'standard' | 'upload') => {
        setShowDownloadModal(false);
        downloadScannerExcel(type);
    };

    const downloadScannerExcel = (templateType: 'standard' | 'upload') => {
        const XLSX = (window as any).XLSX;
        if (!XLSX) {
            alert("Excel library not found!");
            return;
        }

        const wb = XLSX.utils.book_new();

        if (templateType === 'upload') {
            // --- Upload Template Logic (Single Sheet, Plain/Raw Data) ---
            const headers = ["REVENUE ITEM", "DATE OF PAYMENT", "AMOUNT PAID", "RECEIPT NUMBER", "PERIOD OF PAYMENT"];
            
            const sortedResults = [...scannerResults].sort((a,b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());

            const dataRows = sortedResults.map(row => {
                let displayTaxType = row.taxType;
                const upperTax = displayTaxType.toUpperCase();
                
                // Normalize "Lagos Revenue Payment" or similar generic terms to "PAYE"
                if (upperTax.includes("LAGOS REVENUE PAYMENT") || upperTax === "REVENUE PAYMENT" || upperTax === "REVENUE RECEIPT") {
                    displayTaxType = "PAYE";
                }

                const isPaye = displayTaxType.toUpperCase().includes("PAYE");
                let periodVal = row.paymentPeriod;

                // Parse "Jan-25" -> Month: "JANUARY", Year: "2025"
                const parts = row.paymentPeriod.split('-');
                if (parts.length === 2) {
                    const monthMap: {[key:string]: string} = {
                        'Jan': 'JANUARY', 'Feb': 'FEBRUARY', 'Mar': 'MARCH', 'Apr': 'APRIL', 'May': 'MAY', 'Jun': 'JUNE',
                        'Jul': 'JULY', 'Aug': 'AUGUST', 'Sep': 'SEPTEMBER', 'Oct': 'OCTOBER', 'Nov': 'NOVEMBER', 'Dec': 'DECEMBER',
                        // Add lowercase handling just in case
                        'jan': 'JANUARY', 'feb': 'FEBRUARY', 'mar': 'MARCH', 'apr': 'APRIL', 'may': 'MAY', 'jun': 'JUNE',
                        'jul': 'JULY', 'aug': 'AUGUST', 'sep': 'SEPTEMBER', 'oct': 'OCTOBER', 'nov': 'NOVEMBER', 'dec': 'DECEMBER'
                    };
                    const m = parts[0];
                    // Ensure year is 4 digits
                    const y = parts[1].length === 2 ? '20' + parts[1] : parts[1];
                    
                    if (isPaye) {
                        // For PAYE: "JANUARY"
                        periodVal = monthMap[m] || monthMap[m.toLowerCase()] || m.toUpperCase();
                    } else {
                        // For Others (Levy, etc): "2025"
                        periodVal = y;
                    }
                } else {
                    // Fallback
                    const d = new Date(row.paymentDate);
                     if (isPaye) periodVal = d.toLocaleString('default', { month: 'long' }).toUpperCase();
                     else periodVal = d.getFullYear().toString();
                }

                return [
                    displayTaxType,
                    new Date(row.paymentDate),
                    row.amount,
                    row.receiptNumber,
                    periodVal
                ];
            });

            // Create sheet directly with headers and data, no styles applied
            const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);

            // Apply basic date formatting so it appears as DD/MM/YYYY
            const range = XLSX.utils.decode_range(ws['!ref'] || "A1");
            for(let R = range.s.r; R <= range.e.r; ++R) {
                 const C = 1; // Column B (Date)
                 const cellRef = XLSX.utils.encode_cell({c: C, r: R});
                 // Skip header row
                 if (ws[cellRef] && R > 0) { 
                     ws[cellRef].z = 'dd/mm/yyyy';
                 }
            }

             // Column Widths (for readability)
            ws['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 25 }, { wch: 20 }];
            
            XLSX.utils.book_append_sheet(wb, ws, "Upload");
            XLSX.writeFile(wb, "Lagos_State_Upload_Schedule.xlsx");

        } else {
            // --- Standard Template Logic (Styled with Borders & Colors) ---
            const dataByYear: { [key: string]: ScannerResult[] } = {};
            const getYearFromPeriod = (period?: string) => {
                if (!period) return "Unknown";
                const match = period.match(/(\d{2,4})$/);
                return match ? (match[1].length === 2 ? `20${match[1]}` : match[1]) : "Unknown";
            };

            scannerResults.forEach(row => {
                const year = getYearFromPeriod(row.paymentPeriod);
                if (!dataByYear[year]) dataByYear[year] = [];
                dataByYear[year].push(row);
            });

            // Variables for filename generation
            const companyFrequency: Record<string, number> = {};
            const extractedTaxTypes = new Set<string>();

            scannerResults.forEach(row => {
                if (row.companyName) {
                    companyFrequency[row.companyName] = (companyFrequency[row.companyName] || 0) + 1;
                }
                if (row.taxType) {
                    const t = row.taxType.toUpperCase();
                    if (t.includes("WHT") || t.includes("WITHHOLDING")) extractedTaxTypes.add("WHT");
                    else if (t.includes("VAT") || t.includes("VALUE ADDED")) extractedTaxTypes.add("VAT");
                    else if (t.includes("PAYE") || t.includes("PAY AS YOU EARN")) extractedTaxTypes.add("PAYE");
                    else if (t.includes("CIT") || t.includes("COMPANY INCOME")) extractedTaxTypes.add("CIT");
                    else if (t.includes("EDT") || t.includes("EDUCATION")) extractedTaxTypes.add("EDT");
                    else extractedTaxTypes.add("TAX");
                }
            });

            // Common styles
            const thinBorder = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
            const headerStyle = { font: { bold: true, sz: 11 }, border: thinBorder, alignment: { horizontal: "center", vertical: "center" }, fill: { fgColor: { rgb: "EEEEEE" } } };
            const dataStyle = { border: thinBorder, font: { sz: 11 } };
            const titleStyle = { font: { bold: true, sz: 14 } };

            for (const year in dataByYear) {
                const sheetData = dataByYear[year].sort((a,b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());
                
                // Determine dominant company name for the title
                const companyCounts = sheetData.reduce((acc, row) => {
                    const name = row.companyName || "Unknown";
                    acc[name] = (acc[name] || 0) + 1;
                    return acc;
                }, {} as Record<string, number>);
                const titleName = Object.keys(companyCounts).reduce((a, b) => companyCounts[a] > companyCounts[b] ? a : b, "NASD PLC");
                const total = sheetData.reduce((sum, row) => sum + (row.amount || 0), 0);
                
                // Build Worksheet Data manually to apply styles
                const ws = XLSX.utils.aoa_to_sheet([]);
                
                // -- Row 0: Company Title --
                XLSX.utils.sheet_add_aoa(ws, [[titleName]], { origin: "A1" });
                if(ws['A1']) ws['A1'].s = titleStyle;

                // -- Row 1: Period Title --
                XLSX.utils.sheet_add_aoa(ws, [[`REMITTANCE SCHEDULE FOR ${year}`]], { origin: "A2" });
                if(ws['A2']) ws['A2'].s = { font: { bold: true, sz: 12 } };

                // -- Row 3: Headers -- (Skipping row 2 as spacer)
                const headers = ["PAYMENT DATE", "PERIOD", "RECEIPT NUMBER", "TAX TYPE", "AMOUNT [N]"];
                XLSX.utils.sheet_add_aoa(ws, [headers], { origin: "A4" });
                
                // Apply header styles (A4:E4)
                ['A4', 'B4', 'C4', 'D4', 'E4'].forEach(ref => {
                    if (ws[ref]) ws[ref].s = headerStyle;
                });

                // -- Rows 4+: Data --
                const dataRows = sheetData.map(row => [
                    row.paymentDate ? new Date(row.paymentDate) : undefined,
                    row.paymentPeriod,
                    row.receiptNumber,
                    row.taxType,
                    row.amount
                ]);
                
                XLSX.utils.sheet_add_aoa(ws, dataRows, { origin: "A5" });

                // Apply styles and formats to data cells
                const startRow = 4; // 0-indexed relative to sheet, so row 5
                dataRows.forEach((row, idx) => {
                    const r = startRow + idx;
                    
                    // Date Cell (A)
                    const dateRef = XLSX.utils.encode_cell({c: 0, r});
                    if (ws[dateRef]) {
                        ws[dateRef].z = 'dd/mm/yyyy';
                        ws[dateRef].s = { ...dataStyle, alignment: { horizontal: "center" } };
                    }
                    
                    // Period (B), Receipt (C), Tax Type (D)
                    [1, 2, 3].forEach(c => {
                        const ref = XLSX.utils.encode_cell({c, r});
                        if(ws[ref]) ws[ref].s = dataStyle;
                    });

                    // Amount Cell (E)
                    const amtRef = XLSX.utils.encode_cell({c: 4, r});
                    if (ws[amtRef]) {
                        ws[amtRef].z = '#,##0.00';
                        ws[amtRef].s = dataStyle;
                    }
                });

                // -- Total Row --
                const totalRowIndex = startRow + dataRows.length + 1; // +1 for spacer
                XLSX.utils.sheet_add_aoa(ws, [["", "", "", "Total", total]], { origin: { r: totalRowIndex, c: 0 } });
                
                const totalLabelRef = XLSX.utils.encode_cell({c: 3, r: totalRowIndex});
                const totalValRef = XLSX.utils.encode_cell({c: 4, r: totalRowIndex});

                if(ws[totalLabelRef]) ws[totalLabelRef].s = { font: { bold: true } };
                if(ws[totalValRef]) {
                    ws[totalValRef].z = '#,##0.00';
                    ws[totalValRef].s = { font: { bold: true }, border: { bottom: { style: "double" } } };
                }

                // Column Widths
                ws['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 30 }, { wch: 30 }, { wch: 20 }];

                XLSX.utils.book_append_sheet(wb, ws, `Remittance ${year}`);
            }
            
            // Generate Dynamic Filename
            let dominantCompany = "Unknown_Company";
            const companyNames = Object.keys(companyFrequency);
            if (companyNames.length > 0) {
                dominantCompany = companyNames.reduce((a, b) => companyFrequency[a] > companyFrequency[b] ? a : b);
            }
            
            const safeCompanyName = dominantCompany.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "_");
            const taxTypesStr = Array.from(extractedTaxTypes).sort().join("_") || "Remittance";
            
            const filename = `${safeCompanyName}_${taxTypesStr}_Schedule.xlsx`;
            
            XLSX.writeFile(wb, filename);
        }
    };

    // --- WHT Analyzer Logic ---
    const processWHTFile = async () => {
        if (!ai) {
            setWhtErrors(["AI client not initialized."]);
            return;
        }
        if (selectedFiles.length === 0) return;

        setWhtIsLoading(true);
        setWhtErrors([]);
        setWhtExpenses([]);
        
        const allExpenses: WHTExpense[] = [];
        const currentErrors: string[] = [];
        const XLSX = (window as any).XLSX;

        for (const [index, file] of selectedFiles.entries()) {
            try {
                setWhtLoadingMessage(`Analyzing file ${index + 1} of ${selectedFiles.length}: ${file.name}...`);
                
                let csvData = '';
                if (file.name.endsWith('.csv')) {
                    const text = await file.text();
                    csvData = text;
                } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
                     if (!XLSX) throw new Error("Excel library (SheetJS) not found. It might be blocked by your network.");
                     const arrayBuffer = await fileToArrayBuffer(file);
                     const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                     
                     const allCsvParts: string[] = [];
                     workbook.SheetNames.forEach((sheetName, sheetIndex) => {
                         const worksheet = workbook.Sheets[sheetName];
                         // For the first sheet of the workbook, include headers. For subsequent sheets, skip them.
                         const sheetCsv = XLSX.utils.sheet_to_csv(worksheet, { skipHeader: sheetIndex > 0 });
                         // Trim to remove potential trailing newlines to avoid blank rows between concatenated sheets.
                         if (sheetCsv.trim()) {
                            allCsvParts.push(sheetCsv);
                         }
                     });
                     csvData = allCsvParts.join('');

                } else {
                    throw new Error("Unsupported file type. Only CSV or XLSX are accepted.");
                }

                if (!csvData.trim()) {
                    console.warn(`Skipping empty file: ${file.name}`);
                    continue; // Skip to the next file if there's no data
                }

                const results = await callWHTGeminiAPI(ai, csvData);
                
                // Safeguard: Filter out any provisions the AI might have mistakenly included.
                const filteredResults = results.filter(expense => 
                    !expense.category.toLowerCase().includes('provision') &&
                    !expense.description.toLowerCase().includes('provision')
                );

                const processedResults = filteredResults.map(r => ({
                    ...r,
                    id: `${file.name}-${Math.random().toString(36).substring(2, 9)}`,
                    createdAt: new Date().toISOString()
                }));
                allExpenses.push(...processedResults);

            } catch (error: any) {
                currentErrors.push(`Error processing ${file.name}: ${error.message || "An unknown error occurred."}`);
            }
        }

        setWhtExpenses(allExpenses);
        setWhtErrors(currentErrors);
        setWhtIsLoading(false);
    };

    const callWHTGeminiAPI = async (ai: GoogleGenAI, csvData: string): Promise<Omit<WHTExpense, 'id' | 'createdAt'>[]> => {
        const systemPrompt = `You are an expert Nigerian Tax Analyst AI. Your primary and most critical function is to filter a list of financial transactions from a General Ledger (provided as CSV text) to isolate ONLY WHT-liable expenses, and then categorize them.

### Rule 1: Master Filtering (Apply This First)

Before you categorize anything, you MUST filter the input data. You will IGNORE AND COMPLETELY DISCARD any line item that is:

*   **NOT an Expense:** This includes all Income lines (e.g., "Income - Investment Income"), Asset lines (e.g., "Motor Vehicles"), or Liability/Equity lines.
*   **An Internal Provision:** This includes all lines explicitly named "Provision" (e.g., "Provision - Training Expenses"). Provisions are internal estimates and are NEVER subject to WHT.
*   **A Non-Cash Entry:** This includes "Accruals," "Depreciation," "Amortization," or "Recognition" entries.
*   **A Statutory Payment:** This includes "Fines Expenses," tax payments, or pension remittances.
*   **An Exempt Subscription:** This includes "Professional Membership Subscription."
*   **A CSR Expense:** All "CSR Expenses" are to be ignored.
*   **Other Exclusions:** Also ignore any row with descriptions like 'Beginning Balance', 'Ending Balance', or 'Current Period Change'.

Your final JSON output must *only* contain rows for actual, paid expenses that have been analyzed for WHT liability. **Do not include any of the discarded rows in the output.**

### Rule 2: Core Categorization Rules (Apply to Filtered List)

After you have filtered the list using Rule 1, you will apply these rules to the *remaining* expenses to populate the JSON fields.

#### 1. Not Liable / Exempt Amount
This is for payments that are expenses but are exempt from WHT. For these, the \`exemptAmount\` should be the full transaction \`amount\`, and WHT amounts should be 0.
*   **VAT Payments:** Any transaction explicitly described as "Being VAT on..."
*   **Purchase of Goods:** Payments for physical goods, stock, or inventory. Bank charges are also exempt.

#### 2. Liable to SIRS
This applies ONLY for payments made to **individuals, sole proprietors, or partnerships**. The WHT rate is 5%. For these, \`sirsAmount\` should be 5% of the \`amount\`, and other WHT fields are 0.
*   **Directors' Fees:** All payments for "Directors Fees" or "Directors Sitting Allowances."
*   **Auditor's Remuneration:** All payments for "Auditor's remuneration."
*   **Payments to Individuals:** Any payment for services (rent, printing, professional) where the vendor is clearly an individual (e.g., "Payment to John Bako") or a business name (e.g., "John Bako & Sons").

#### 3. Liable to FIRS
This applies for payments made to **incorporated companies (Plc, Ltd, Limited)** for WHT-liable services. The WHT rate is 10%. For these, \`firsAmount\` should be 10% of the \`amount\`, and other WHT fields are 0.
*   **Services to Companies:** Any payment for a service where the vendor name in the description includes "Plc," "Ltd," or "Limited."
*   **Liable Service Categories:** This is the default for most service-based expenses if the vendor is a company, including:
    *   \`Hosting Fees & Web Security\`
    *   \`Training Expenses\` (Note: This is for *actual payments*, not provisions)
    *   \`Service Charge\`
    *   \`Public Forum Expenses\`
    *   \`Trading Expenses\` (if they are for services, not VAT or goods)
    *   \`Rent\` (if paid to a company)
    *   \`Professional Fee Expense\` (if paid to a company)

### Input & Output Instructions

1.  **Input Format**: The input is raw CSV text from a General Ledger. Be flexible with column names for debit amount and description. Identify all rows with a positive numerical value in the debit column as a payment.
2.  **Output Field Mapping**: For each row that PASSES the filter in Rule 1, create a JSON object with the following fields:
    *   \`description\`: The full text from the 'Trans Description' column.
    *   \`category\`: The EXACT text from the 'Account Description' column. Do not change it.
    *   \`amount\`: The numerical value from the debit column.
    *   \`recipientType\`: 'company' or 'individual' based on your analysis.
    *   \`isLiable\`: \`true\` if \`firsAmount\` or \`sirsAmount\` > 0, otherwise \`false\`.
    *   \`firsAmount\`: Calculated WHT for FIRS (10% of \`amount\`). 0 if not liable to FIRS.
    *   \`sirsAmount\`: Calculated WHT for SIRS (5% of \`amount\`). 0 if not liable to SIRS.
    *   \`exemptAmount\`: The full transaction \`amount\` if it's exempt. Otherwise, 0.
    *   \`notes\`: A brief explanation for your decision (e.g., "Exempt - Purchase of Goods", "SIRS - Payment to individual", "FIRS - Service to company").
3.  **Final Output**: Return ONLY a single valid JSON array of objects. Do not add markdown, explanations, or any other text outside the JSON array.`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: { parts: [{ text: `Analyze this General Ledger data:\n\n${csvData}` }] },
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            description: { type: Type.STRING },
                            category: { type: Type.STRING },
                            amount: { type: Type.NUMBER },
                            recipientType: { type: Type.STRING },
                            isLiable: { type: Type.BOOLEAN },
                            firsAmount: { type: Type.NUMBER },
                            sirsAmount: { type: Type.NUMBER },
                            exemptAmount: { type: Type.NUMBER },
                            notes: { type: Type.STRING },
                        },
                        required: ["description", "category", "amount", "recipientType", "isLiable", "firsAmount", "sirsAmount", "exemptAmount", "notes"]
                    }
                }
            }
        });
        // FIX: Explicitly cast the result of JSON.parse to the expected return type.
        // This prevents the `any` type from propagating and causing cascading type errors downstream.
        return JSON.parse(response.text) as Omit<WHTExpense, 'id' | 'createdAt'>[];
    };
    
    const handleManualWHTAdd = () => {
        const amount = parseFloat(whtManualForm.amount);
        if (!whtManualForm.description || isNaN(amount) || amount <= 0) {
            alert("Please enter a valid description and amount.");
            return;
        }

        let firsAmount = 0;
        let sirsAmount = 0;
        const recipientType = whtManualForm.recipientType;
        
        if (recipientType === 'company') {
            firsAmount = amount * 0.10;
        } else {
            sirsAmount = amount * 0.05;
        }

        const newExpense: WHTExpense = {
            id: `manual-${Date.now()}`,
            description: whtManualForm.description,
            amount,
            recipientType,
            isLiable: true,
            firsAmount,
            sirsAmount,
            exemptAmount: 0,
            notes: "Manual Entry",
            category: "Manual Entry",
            createdAt: new Date().toISOString()
        };

        setWhtExpenses(prev => [newExpense, ...prev]);
        setWhtManualForm({ description: '', amount: '', recipientType: 'company' });
    };

    // FIX: Explicitly type the accumulator in the reduce function to prevent type inference issues,
    // which caused `whtSummary` to be incorrectly typed and led to errors in the render method.
    const whtSummary = useMemo<WHTSummary>(() => {
        return whtExpenses.reduce((acc: WHTSummary, expense) => {
            if (!acc[expense.category]) {
                acc[expense.category] = { exempted: 0, dueToSirs: 0, dueToFirs: 0 };
            }
            acc[expense.category].exempted += expense.exemptAmount;
            acc[expense.category].dueToSirs += expense.sirsAmount;
            acc[expense.category].dueToFirs += expense.firsAmount;
            return acc;
        }, {} as WHTSummary);
    }, [whtExpenses]);
    
    const whtTotals = useMemo<WHTTotals>(() => {
        return whtExpenses.reduce((totals: WHTTotals, item) => {
            totals.exempted += item.exemptAmount;
            totals.dueToSirs += item.sirsAmount;
            totals.dueToFirs += item.firsAmount;
            return totals;
        }, { exempted: 0, dueToSirs: 0, dueToFirs: 0 });
    }, [whtExpenses]);

    const whtGrossSummary = useMemo<WHTGrossSummary>(() => {
        return whtExpenses.reduce((acc: WHTGrossSummary, expense) => {
            if (!acc[expense.category]) {
                acc[expense.category] = { notLiable: 0, liableToSirs: 0, liableToFirs: 0 };
            }
            if (expense.exemptAmount > 0) {
                acc[expense.category].notLiable += expense.amount;
            } else if (expense.sirsAmount > 0) {
                acc[expense.category].liableToSirs += expense.amount;
            } else if (expense.firsAmount > 0) {
                acc[expense.category].liableToFirs += expense.amount;
            }
            return acc;
        }, {} as WHTGrossSummary);
    }, [whtExpenses]);

    const whtGrossTotals = useMemo<WHTGrossTotals>(() => {
        const values = Object.values(whtGrossSummary) as { notLiable: number; liableToSirs: number; liableToFirs: number }[];
        return values.reduce((totals: WHTGrossTotals, item) => {
            totals.notLiable += item.notLiable;
            totals.liableToSirs += item.liableToSirs;
            totals.liableToFirs += item.liableToFirs;
            return totals;
        }, { notLiable: 0, liableToSirs: 0, liableToFirs: 0 });
    }, [whtGrossSummary]);


    const downloadWHTExcel = () => {
        const XLSX = (window as any).XLSX;
        if (!XLSX) {
            alert("Excel library not found!");
            return;
        }

        const wb = XLSX.utils.book_new();
        const numberFormat = '#,##0.00';

        // --- 1. Summary Sheet ("WHT") ---
        const summaryAOA = [
            [], [], [], // rows 1-3 for spacing
            ["SUMMARY OF TAX LIABILITY"], // A4
            [null, null, "Amount Not Liable", "Amount Due to SIRS", "Amount Liable to WHT (FIRS)"], // Headers in C5, D5, E5
            [null, null, "₦", "₦", "₦"], // Currency in C6, D6, E6
            // FIX: Cast the result of Object.entries to a typed array.
            // This prevents a `map does not exist on type unknown` error by ensuring TypeScript
            // correctly recognizes the result as an array that can be sorted and mapped.
            ...(Object.entries(whtGrossSummary) as [string, { notLiable: number; liableToSirs: number; liableToFirs: number }][])
                .sort(([catA], [catB]) => catA.localeCompare(catB))
                .map(([category, data]) => [
                    category, // Col A
                    null,     // Col B (empty)
                    data.notLiable || 0, // Col C
                    data.liableToSirs || 0, // Col D
                    data.liableToFirs || 0, // Col E
                ]),
            [], // spacer row
            ["Total", null, whtGrossTotals.notLiable, whtGrossTotals.liableToSirs, whtGrossTotals.liableToFirs]
        ];

        const wsSummary = XLSX.utils.aoa_to_sheet(summaryAOA);
        
        wsSummary['!cols'] = [{ wch: 40 }, { wch: 5 }, { wch: 20 }, { wch: 20 }, { wch: 30 }];
        wsSummary['!merges'] = [{ s: { r: 3, c: 0 }, e: { r: 3, c: 4 } }]; // Merge A4:E4

        const dataStartRow = 6;
        // FIX: Cast Object.keys to a string array to access the .length property safely.
        const keys = Object.keys(whtGrossSummary) as string[];
        const numDataRows = keys.length;
        const totalRowIndex = dataStartRow + numDataRows + 1;

        // Format data rows
        for (let r = dataStartRow; r < dataStartRow + numDataRows; r++) {
            for (let c = 2; c <= 4; c++) {
                const cellRef = XLSX.utils.encode_cell({ r, c });
                if (wsSummary[cellRef] && typeof wsSummary[cellRef].v === 'number') {
                    wsSummary[cellRef].z = numberFormat;
                }
            }
        }
        // Format total row
        for (let c = 2; c <= 4; c++) {
            const cellRef = XLSX.utils.encode_cell({ r: totalRowIndex, c });
            if (wsSummary[cellRef] && typeof wsSummary[cellRef].v === 'number') {
                wsSummary[cellRef].z = numberFormat;
            }
        }
        XLSX.utils.book_append_sheet(wb, wsSummary, "WHT");


        // --- 2. Individual Category Sheets ---
        // FIX: Cast whtExpenses to WHTExpense[] to avoid 'reduce does not exist on type unknown' error.
        const expensesByCategory = (whtExpenses as WHTExpense[]).reduce((acc: Record<string, WHTExpense[]>, expense) => {
            if (!acc[expense.category]) acc[expense.category] = [];
            acc[expense.category].push(expense);
            return acc;
        }, {} as Record<string, WHTExpense[]>);

        const sanitizeSheetName = (name: string) => {
          const sanitized = name.replace(/[/\\?*[\]]/g, '');
          return sanitized.substring(0, 31);
        };

        // FIX: Cast Object.entries result to ensure 'expenses' is typed as WHTExpense[] for map/length operations.
        for (const [category, expenses] of Object.entries(expensesByCategory) as [string, WHTExpense[]][]) {
            const sheetName = sanitizeSheetName(category);

            const categoryTotals = expenses.reduce((acc, ex) => {
                acc.amount += ex.amount;
                acc.firsAmount += ex.firsAmount;
                acc.sirsAmount += ex.sirsAmount;
                acc.exemptAmount += ex.exemptAmount;
                return acc;
            }, { amount: 0, firsAmount: 0, sirsAmount: 0, exemptAmount: 0 });

            const detailAOA = [
                [`WHT Details for: ${category}`],
                [],
                ["Description", "Amount", "WHT (FIRS)", "WHT (SIRS)", "Exempt", "Notes"],
                ...expenses.map(ex => [
                    ex.description,
                    ex.amount,
                    ex.firsAmount,
                    ex.sirsAmount,
                    ex.exemptAmount,
                    ex.notes
                ]),
                [],
                ["Total", categoryTotals.amount, categoryTotals.firsAmount, categoryTotals.sirsAmount, categoryTotals.exemptAmount, ""]
            ];
            
            const wsDetail = XLSX.utils.aoa_to_sheet(detailAOA);
            wsDetail['!cols'] = [{ wch: 50 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 40 }];
            
            const detailDataStartRow = 3;
            const detailNumDataRows = expenses.length;
            const detailTotalRowIndex = detailDataStartRow + detailNumDataRows + 1;

            for(let r = detailDataStartRow; r < detailTotalRowIndex; r++) {
                 for (let c = 1; c <= 4; c++) {
                    const cellRef = XLSX.utils.encode_cell({ r, c });
                    if (wsDetail[cellRef] && typeof wsDetail[cellRef].v === 'number') {
                        wsDetail[cellRef].z = numberFormat;
                    }
                }
            }
             for (let c = 1; c <= 4; c++) {
                const cellRef = XLSX.utils.encode_cell({ r: detailTotalRowIndex, c });
                if (wsDetail[cellRef] && typeof wsDetail[cellRef].v === 'number') {
                    wsDetail[cellRef].z = numberFormat;
                }
            }
            XLSX.utils.book_append_sheet(wb, wsDetail, sheetName);
        }
        
        XLSX.writeFile(wb, "WHT_Analysis.xlsx");
    };
    
    
    // --- Render Logic ---
    if (!isLoggedIn) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="w-full max-w-sm mx-auto bg-slate-900/50 backdrop-blur-sm rounded-2xl shadow-2xl shadow-violet-500/10 p-8 glow-border">
                    <h1 className="text-3xl font-bold text-center text-slate-100 mb-2">THE VIRUS AI</h1>
                    <p className="text-center text-slate-400 mb-8">Exclusive Access</p>
                    <div className="space-y-4">
                        <input
                            type="password"
                            value={accessCode}
                            onChange={(e) => setAccessCode(e.target.value)}
                            onKeyPress={(e) => e.key === 'Enter' && handleLogin()}
                            placeholder="Enter Access Code"
                            className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 text-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-violet-500 transition"
                        />
                         {loginError && <p className="text-red-400 text-sm text-center">{loginError}</p>}
                        <button
                            onClick={handleLogin}
                            className="w-full text-white font-bold py-3 px-4 rounded-lg transition duration-300 shadow-lg btn-glow"
                        >
                            Login
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const isLoading = scannerIsLoading || whtIsLoading;

    return (
        <div className="w-full max-w-7xl mx-auto relative">
            {showDownloadModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className="bg-slate-900 border border-white/10 rounded-xl p-6 max-w-md w-full shadow-2xl glow-border">
                        <h3 className="text-xl font-bold text-white mb-4">Select Schedule Format</h3>
                        <p className="text-slate-400 mb-6">How do you intend to use this schedule?</p>
                        <div className="space-y-3">
                            <button
                                onClick={() => handleDownloadConfirm('upload')}
                                className="w-full py-3 px-4 bg-violet-600 hover:bg-violet-700 text-white rounded-lg font-medium transition-colors flex items-center justify-center"
                            >
                                <span className="mr-2">📤</span> For Portal Upload
                            </button>
                            <button
                                onClick={() => handleDownloadConfirm('standard')}
                                className="w-full py-3 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors flex items-center justify-center"
                            >
                                <span className="mr-2">📎</span> As Attachment (Standard)
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
            
            <header className="mb-8 text-center border-b border-white/10 pb-6">
                <h1 className="text-4xl font-bold text-slate-100 tracking-wider">THE VIRUS AI</h1>
                <p className="text-slate-400 mt-2">Your personal AI-powered toolkit.</p>
            </header>

            <div className="border-b border-white/10 mb-6">
                <nav className="-mb-px flex space-x-8 justify-center">
                     <button
                        onClick={() => switchTool('scanner')}
                        className={`py-4 px-1 font-medium text-sm transition-colors ${
                            activeTool === 'scanner' 
                            ? 'tab-active' 
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        Remittance Schedule
                    </button>
                    <button
                        onClick={() => switchTool('analyzer')}
                        className={`py-4 px-1 font-medium text-sm transition-colors ${
                            activeTool === 'analyzer' 
                            ? 'tab-active' 
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                    >
                        WHT Analyzer
                    </button>
                </nav>
            </div>
            
            <main>
                <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg p-6 mb-8 glow-border">
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
                                Drag & drop files here or <span className="text-violet-400">click to browse</span>
                            </span>
                            <span className="mt-1 block text-xs text-slate-500">
                                {activeTool === 'scanner' ? 'PDF, PNG, JPG, WebP' : 'XLSX, CSV'}
                            </span>
                        </label>
                        <input id="file-upload" name="file-upload" type="file" className="sr-only" multiple accept={activeTool === 'scanner' ? '.pdf,.png,.jpg,.jpeg,.webp' : '.xlsx,.xls,.csv'} onChange={(e) => handleFileChange(e.target.files)} />
                    </div>

                    {selectedFiles.length > 0 && (
                        <div className="mt-4">
                            <h4 className="font-medium text-slate-300">Selected Files:</h4>
                            <ul className="list-disc list-inside text-sm text-slate-400 mt-2">
                                {selectedFiles.map(file => <li key={file.name}>{file.name}</li>)}
                            </ul>
                        </div>
                    )}
                    
                    <div className="mt-6 text-center">
                        <button
                            onClick={processFiles}
                            disabled={selectedFiles.length === 0 || isLoading}
                            className="inline-flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md shadow-lg text-white disabled:bg-slate-700 disabled:text-slate-400 disabled:cursor-not-allowed btn-glow"
                        >
                            {isLoading && <div className='wht-spinner mr-3'></div>}
                            Process Files
                        </button>
                    </div>
                </div>

                {activeTool === 'scanner' && (
                    <div className="space-y-6">
                        {scannerIsLoading && (
                            <div className="flex flex-col items-center justify-center bg-slate-900/50 backdrop-blur-sm p-8 rounded-xl shadow-lg glow-border">
                                <div className="spinner"></div>
                                <p className="mt-4 text-slate-400">Processing receipts...</p>
                            </div>
                        )}
                        {scannerMessages.length > 0 && (
                            <div className="space-y-2">
                                {scannerMessages.map((msg, index) => (
                                    <div key={index} className={`p-4 rounded-md text-sm border ${
                                        msg.type === 'success' ? 'bg-teal-900/50 text-teal-200 border-teal-500/30' :
                                        msg.type === 'error' ? 'bg-red-900/50 text-red-200 border-red-500/30' :
                                        'bg-yellow-900/50 text-yellow-200 border-yellow-500/30'
                                    }`}>
                                        {msg.text}
                                    </div>
                                ))}
                            </div>
                        )}

                        {scannerResults.length > 0 && (
                             <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden glow-border">
                                <div className="px-6 py-4 bg-slate-900/70 border-b border-white/10 flex justify-between items-center">
                                    <h2 className="text-lg font-semibold text-violet-300">Scanner Results</h2>
                                    <button
                                        onClick={handleDownloadClick}
                                        className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-teal-600 hover:bg-teal-700 transition-colors"
                                    >
                                        Download Schedule
                                    </button>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="min-w-full">
                                        <thead className="bg-slate-900/70">
                                            <tr>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Payment Date</th>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Period</th>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Receipt No.</th>
                                                <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Tax Type</th>
                                                <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">Amount</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/10">
                                            {scannerResults.map((result, index) => (
                                                <tr key={result.receiptNumber + index} className="hover:bg-slate-800/40 transition-colors">
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.paymentDateDisplay}</td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.paymentPeriod}</td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.receiptNumber}</td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.taxType}</td>
                                                    <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(result.amount)}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                )}
                
                {activeTool === 'analyzer' && (
                    <div className="space-y-8">
                         {whtIsLoading && (
                            <div className="flex flex-col items-center justify-center bg-slate-900/50 backdrop-blur-sm p-8 rounded-xl shadow-lg glow-border">
                                <div className="wht-spinner"></div>
                                <p className="mt-4 text-slate-400">{whtLoadingMessage}</p>
                            </div>
                        )}
                        {whtErrors.length > 0 && (
                            <div className="space-y-2">
                                {whtErrors.map((error, index) => (
                                    <div key={index} className="p-4 bg-red-900/50 text-red-200 border border-red-500/30 rounded-lg">
                                        <strong>Error:</strong> {error}
                                    </div>
                                ))}
                            </div>
                        )}

                        {!whtIsLoading && whtExpenses.length === 0 && selectedFiles.length > 0 && whtErrors.length === 0 && (
                             <div className="flex flex-col items-center justify-center bg-slate-900/50 backdrop-blur-sm p-8 rounded-xl shadow-lg glow-border">
                                <p className="text-slate-400">Analysis complete. No WHT-liable transactions were found in the selected file(s).</p>
                            </div>
                        )}

                        {!whtIsLoading && whtExpenses.length > 0 && (
                            <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg glow-border">
                                <div className="px-6 py-4 bg-slate-900/70 border-b border-white/10">
                                    <h3 className="text-lg font-semibold text-slate-200">Manual WHT Entry</h3>
                                </div>
                                <div className="p-6 grid grid-cols-1 md:grid-cols-6 gap-4 items-end">
                                    <div className="md:col-span-3">
                                        <label htmlFor="wht-desc" className="block text-sm font-medium text-slate-400 mb-1">Description</label>
                                        <input type="text" id="wht-desc" value={whtManualForm.description} onChange={e => setWhtManualForm({...whtManualForm, description: e.target.value})} className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500" placeholder="e.g., Legal Consultation" />
                                    </div>
                                    <div>
                                        <label htmlFor="wht-amount" className="block text-sm font-medium text-slate-400 mb-1">Amount (NGN)</label>
                                        <input type="number" id="wht-amount" value={whtManualForm.amount} onChange={e => setWhtManualForm({...whtManualForm, amount: e.target.value})} className="w-full px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500" placeholder="50000" />
                                    </div>
                                    <div className="md:col-span-1">
                                        <label className="block text-sm font-medium text-slate-400 mb-1">Recipient</label>
                                        <select value={whtManualForm.recipientType} onChange={e => setWhtManualForm({...whtManualForm, recipientType: e.target.value as 'company' | 'individual'})} className="w-full h-[42px] px-3 py-2 bg-slate-800/50 border border-slate-700 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500">
                                            <option value="company">Company</option>
                                            <option value="individual">Individual</option>
                                        </select>
                                    </div>
                                    <button onClick={handleManualWHTAdd} className="w-full h-[42px] bg-violet-600 text-white font-bold py-2 px-4 rounded-md hover:bg-violet-700 transition duration-300 shadow-sm">
                                        Add
                                    </button>
                                </div>
                            </div>
                        )}
                        
                        {whtExpenses.length > 0 && (
                            <>
                                <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden glow-border">
                                    <div className="px-6 py-4 bg-slate-900/70 border-b border-white/10 flex justify-between items-center">
                                         <h2 className="text-lg font-semibold text-violet-300">WHT Summary</h2>
                                         <button
                                            onClick={downloadWHTExcel}
                                            className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-teal-600 hover:bg-teal-700 transition-colors"
                                        >
                                            Download Analysis
                                        </button>
                                    </div>
                                     <div className="overflow-x-auto">
                                        <table className="min-w-full">
                                            <thead className="bg-slate-900/70">
                                                <tr>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Category</th>
                                                    <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">Exempted</th>
                                                    <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">Due to SIRS</th>
                                                    <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">Due to FIRS</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-white/10">
                                                {Object.entries(whtSummary).sort(([catA], [catB]) => catA.localeCompare(catB)).map(([category, data]: [string, WHTSummary[string]]) => (
                                                    <tr key={category} className="hover:bg-slate-800/40 transition-colors">
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-slate-200">{category}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(data.exempted)}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(data.dueToSirs)}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(data.dueToFirs)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                            <tfoot className="bg-slate-800/60 font-semibold">
                                                <tr>
                                                    <td className="px-6 py-3 text-left text-sm text-violet-300 uppercase">Total</td>
                                                    <td className="px-6 py-3 text-right text-sm text-slate-200">{formatCurrency(whtTotals.exempted)}</td>
                                                    <td className="px-6 py-3 text-right text-sm text-slate-200">{formatCurrency(whtTotals.dueToSirs)}</td>
                                                    <td className="px-6 py-3 text-right text-sm text-slate-200">{formatCurrency(whtTotals.dueToFirs)}</td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                     </div>
                                </div>

                                <div className="bg-slate-900/50 backdrop-blur-sm rounded-xl shadow-lg overflow-hidden glow-border">
                                    <div className="px-6 py-4 bg-slate-900/70 border-b border-white/10">
                                         <h2 className="text-lg font-semibold text-violet-300">Detailed Analysis</h2>
                                    </div>
                                     <div className="overflow-x-auto">
                                        <table className="min-w-full">
                                            <thead className="bg-slate-900/70">
                                                <tr>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider w-2/5">Description</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Category</th>
                                                    <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">Amount</th>
                                                    <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">WHT (FIRS)</th>
                                                    <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">WHT (SIRS)</th>
                                                    <th className="px-6 py-3 text-right text-xs font-medium text-violet-300 uppercase tracking-wider">Exempt</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">Notes</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-white/10">
                                                {whtExpenses.map((expense) => (
                                                    <tr key={expense.id} className="hover:bg-slate-800/40 transition-colors">
                                                        <td className="px-6 py-4 text-sm text-slate-300">{expense.description}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{expense.category}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(expense.amount)}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(expense.firsAmount)}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(expense.sirsAmount)}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300 text-right">{formatCurrency(expense.exemptAmount)}</td>
                                                        <td className="px-6 py-4 text-sm text-slate-400">{expense.notes}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                     </div>
                                </div>
                            </>
                        )}
                    </div>
                )}
                
            </main>
        </div>
    );
};

export default App;
