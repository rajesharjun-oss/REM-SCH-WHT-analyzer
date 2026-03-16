import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Type } from "@google/genai";

// --- PRODUCTION CONFIGURATION ---
// To make this work for users without them entering keys, 
// fill in ONE of the following options directly in the code:

// OPTION 1: Server Mode (Secure - Recommended)
// Deploy the backend and paste the URL here.
const DEFAULT_BACKEND_URL = ""; 

// OPTION 2: Client Demo Mode (Easiest for testing)
// Paste your API Keys here. Add as many as you have to distribute the load.
// WARNING: These keys are visible to anyone who views the source code.
const HARDCODED_API_KEYS: string[] = [
    "AIzaSyBhW3bPcjbgp9EHQBoRZHseWTwPc_fW1N0", 
    "AIzaSyD9oGDnH8JoiI46x-5Nm6pk7ttBShripwc", 
    "AIzaSyBvFZZ04KdxSp2brJGR3uOB2jz0rV4lKz0"
]; 

// --------------------------------

// --- Type Definitions ---
interface ScannerResult {
    companyName: string;
    paymentDate: string; // YYYY-MM-DD
    paymentDateDisplay: string; // DD/MM/YYYY
    paymentPeriod: string;
    receiptNumber: string;
    taxType: string;
    amount: number;
    state: string; 
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
    const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
    
    // --- Config State (Derived from constants) ---
    // If a backend URL is provided, we prefer Server Mode.
    const useServerMode = !!DEFAULT_BACKEND_URL;
    
    // --- Scanner State ---
    const [scannerIsLoading, setScannerIsLoading] = useState(false);
    const [scannerResults, setScannerResults] = useState<ScannerResult[]>([]);
    const [scannerMessages, setScannerMessages] = useState<{ text: string, type: 'error' | 'success' | 'warning' }[]>([]);
    const [showDownloadModal, setShowDownloadModal] = useState(false);
    
    const abortControllerRef = useRef<AbortController | null>(null);

    // --- Handlers & Logic ---
    
    const handleFileChange = (files: FileList | null) => {
        if (!files) return;
        setSelectedFiles(Array.from(files));
        setScannerResults([]);
        setScannerMessages([]);
    };
    
    const handleDragOver = (e: React.DragEvent) => e.preventDefault();
    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        handleFileChange(e.dataTransfer.files);
    };

    const processFiles = () => {
        processReceipts();
    };
    
    // --- Scanner Logic ---
    const processReceipts = async () => {
        
        // 1. Setup API Access
        const envKey = (import.meta as any).env?.VITE_API_KEY || process.env.API_KEY;
        const availableKeys = [...HARDCODED_API_KEYS, envKey].filter(k => k && k.trim().length > 0);

        if (!useServerMode && availableKeys.length === 0) {
             setScannerMessages([{ text: "Setup Error: No API Keys configured. Please add keys to HARDCODED_API_KEYS in App.tsx.", type: 'error' }]);
             return;
        } else if (useServerMode && !DEFAULT_BACKEND_URL) {
             setScannerMessages([{ text: "Setup Error: Server Mode enabled but no URL configured.", type: 'error' }]);
             return;
        }

        setScannerIsLoading(true);
        setScannerMessages([]);
        setScannerResults([]);
        
        abortControllerRef.current = new AbortController();
        const uniqueKeys = new Set<string>();
        const results: ScannerResult[] = [];
        let criticalErrorOccurred = false;
        let attemptCounter = 0;

        // 2. Process Loop
        for (const file of selectedFiles) {
            if (criticalErrorOccurred) break;

            const maxSize = useServerMode ? 30 * 1024 * 1024 : 19 * 1024 * 1024; // Higher limit for server
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
                let fileResults: ScannerResult[] = [];

                if (useServerMode) {
                    // --- SERVER STRATEGY ---
                    const formData = new FormData();
                    formData.append('file', file);
                    
                    try {
                        const response = await fetch(DEFAULT_BACKEND_URL, {
                            method: 'POST',
                            body: formData,
                            signal: abortControllerRef.current.signal
                        });

                        if (!response.ok) {
                            throw new Error(`Server Error (${response.status})`);
                        }

                        const json = await response.json();
                        const rawData = Array.isArray(json) ? json : (json.results || [json]);
                        fileResults = processRawData(rawData);

                    } catch (serverErr: any) {
                        throw new Error(`Connection Failed: ${serverErr.message}.`);
                    }

                } else {
                    // --- CLIENT STRATEGY ---
                    const base64Data = await fileToBase64(file);
                    
                    // Round-Robin Key Selection
                    const currentKey = availableKeys[attemptCounter % availableKeys.length];
                    attemptCounter++;
                    const ai = new GoogleGenAI({ apiKey: currentKey });

                    // Retry Logic for 429 Errors
                    let retries = 3;
                    while (retries > 0) {
                        try {
                            // Reduced delay due to key rotation - Increased to 5s for stability
                            await new Promise(resolve => setTimeout(resolve, 5000));
                            fileResults = await callScannerGeminiAPI(ai, base64Data, mimeType);
                            break; // Success
                        } catch (err: any) {
                            const errMsg = err.message || "";
                            if (errMsg.includes("429") || errMsg.includes("quota")) {
                                retries--;
                                if (retries === 0) throw err;
                                setScannerMessages(prev => [...prev, { text: `Rate limit/Quota hit. Switching key & waiting 10s... (${file.name})`, type: 'warning' }]);
                                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait longer before retry
                            } else {
                                throw err; // Other errors, fail immediately
                            }
                        }
                    }
                }
                
                // 3. Merge Results
                let addedCount = 0;
                if (fileResults && fileResults.length > 0) {
                     for (const result of fileResults) {
                        if (result && result.companyName) {
                            const uniqueKey = `${result.receiptNumber.trim()}-${result.amount}`;
                            if (!uniqueKeys.has(uniqueKey)) {
                                uniqueKeys.add(uniqueKey);
                                results.push(result);
                                addedCount++;
                            }
                        }
                    }
                    
                    if (addedCount > 0) {
                         setScannerMessages(prev => [...prev, { text: `Processed ${file.name}: ${addedCount} receipt(s) extracted.`, type: 'success' }]);
                    } else {
                        setScannerMessages(prev => [...prev, { text: `Processed ${file.name}: No new unique receipts found.`, type: 'warning' }]);
                    }

                } else {
                     setScannerMessages(prev => [...prev, { text: `Processed ${file.name}: No valid receipts identified.`, type: 'warning' }]);
                }

            } catch (error: any) {
                 const rawErrorText = error.message || error.toString() || "";
                 const errorText = rawErrorText.toLowerCase();

                 if (errorText.includes("api_key") || errorText.includes("403")) {
                     setScannerMessages(prev => [...prev, { text: `Authentication Error: The API key is invalid or expired.`, type: 'error' }]);
                     criticalErrorOccurred = true;
                     break; 
                 }
                 
                 // Display Error
                 let displayMsg = error.message;
                 try {
                     const jsonError = JSON.parse(error.message);
                     if (jsonError.error && jsonError.error.message) displayMsg = jsonError.error.message;
                 } catch (e) { /* ignore */ }

                 setScannerMessages(prev => [...prev, { text: `Failed to process file: ${file.name}. ${displayMsg}`, type: 'error' }]);
            }
        }
        
        results.sort((a, b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());
        setScannerResults(results);
        setScannerIsLoading(false);
    };

    // Shared processing logic to normalize data from AI (Client or Server)
    const processRawData = (data: any[]): ScannerResult[] => {
        return data.map((item: any) => {
             if (!item.paymentPeriod && item.paymentDate) {
                const date = new Date(item.paymentDate);
                date.setMonth(date.getMonth() - 1);
                item.paymentPeriod = `${date.toLocaleString('default', { month: 'short' })}-${date.getFullYear().toString().slice(-2)}`;
            }
            if (item.paymentDate) {
                const date = new Date(item.paymentDate);
                item.paymentDateDisplay = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
            }
            if (item.receiptNumber) {
                item.receiptNumber = String(item.receiptNumber).trim();
            }
            if (item.taxType) {
                item.taxType = item.taxType.trim();
            }
            return item;
        }) as ScannerResult[];
    };
    
    const callScannerGeminiAPI = async (ai: GoogleGenAI, base64Data: string, mimeType: string): Promise<ScannerResult[]> => {
        const systemPrompt = `You are an expert accountant. This file may contain one or multiple receipts. 
        Extract the following fields for EACH receipt found.

        - companyName: The name of the company that made the payment.
        - paymentDate: The date the payment was made (ISO YYYY-MM-DD).
        - paymentPeriod: The month/year the payment covers (e.g., "Jan-25").
        - receiptNumber: The unique receipt or transaction number.
            - CRITICAL FOR LAGOS STATE: Look for "Receipt No", "Transaction ID", "Payment Ref", "CBS Reference", or "Bill Reference". Capture the FULL alphanumeric string (e.g., "LGS...", "CBS...", "R-...", or numeric). Do not truncate. If it looks like a Lagos State receipt, prioritize the "CBS Reference" or "Payment Reference" if "Receipt No" is ambiguous.
        - taxType: The specific type of tax paid.
            - If it is "WVAT" or "Withholding VAT", return "WVAT".
            - If it is generic "Withholding Tax" with no specific detail, return "WHT".
            - If it is "Withholding Tax" with detail (e.g., Contract, Consultancy, Rent), return the full detail (e.g., "WHT on Contract").
            - If "PAYE", return "PAYE".
            - If "Development Levy", return "Development Levy".
        - state: The State or Authority (e.g., "Lagos", "Delta", "Federal"). Normalize names (e.g., "Lagos State" -> "Lagos").
        - amount: The FINAL TOTAL amount paid.
        
        Return a valid JSON ARRAY of objects.`;
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: { parts: [{ text: "Extract all receipts from this file as a JSON array." }, { inlineData: { mimeType, data: base64Data } }] },
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: "application/json",
                responseSchema: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            "companyName": { "type": Type.STRING },
                            "paymentDate": { "type": Type.STRING, "description": "Date in YYYY-MM-DD format" },
                            "paymentPeriod": { "type": Type.STRING, "description": "Period in Mon-YY format" },
                            "receiptNumber": { "type": Type.STRING },
                            "taxType": { "type": Type.STRING },
                            "state": { "type": Type.STRING },
                            "amount": { "type": Type.NUMBER }
                        },
                        required: ["companyName", "paymentDate", "paymentPeriod", "receiptNumber", "taxType", "state", "amount"]
                    }
                }
            }
        });

        const rawText = response.text;
        let data: any[] = [];
        try {
            const parsed = JSON.parse(rawText);
            if (Array.isArray(parsed)) {
                data = parsed;
            } else if (typeof parsed === 'object') {
                data = [parsed];
            }
        } catch (e) {
            console.error("Failed to parse AI response", rawText);
            return [];
        }
        
        return processRawData(data);
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
        const sortedResults = [...scannerResults].sort((a,b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());

        // Group by State first, normalizing keys to avoid duplicates (e.g. Lagos vs LAGOS)
        const dataByState: { [key: string]: ScannerResult[] } = {};
        sortedResults.forEach(row => {
            let stateKey = row.state ? row.state.trim().toUpperCase() : "UNKNOWN";
            // Remove " STATE" suffix if present to group "Lagos" and "Lagos State"
            stateKey = stateKey.replace(/\s+STATE$/i, "");
            // Normalize common variations
            if (stateKey === "FIRS" || stateKey === "FEDERAL GOVT" || stateKey === "FEDERAL INLAND REVENUE") stateKey = "FEDERAL";
            
            if (!dataByState[stateKey]) dataByState[stateKey] = [];
            dataByState[stateKey].push(row);
        });


        if (templateType === 'upload') {
            // --- Upload Template Logic (Single Workbook, Separate Sheets per State) ---
            const headers = ["REVENUE ITEM", "DATE OF PAYMENT", "AMOUNT PAID", "RECEIPT NUMBER", "PERIOD OF PAYMENT"];
            
            for (const [state, rows] of Object.entries(dataByState)) {
                 const dataRows = rows.map(row => {
                    let displayTaxType = row.taxType;
                    const upperTax = displayTaxType.toUpperCase();
                    
                    if (upperTax.includes("LAGOS REVENUE PAYMENT") || upperTax === "REVENUE PAYMENT" || upperTax === "REVENUE RECEIPT" || upperTax.includes("PAY AS YOU EARN")) {
                        displayTaxType = "PAYE";
                    }

                    const isPaye = displayTaxType.toUpperCase().includes("PAYE");
                    let periodVal = row.paymentPeriod;

                    const parts = row.paymentPeriod.split('-');
                    if (parts.length === 2) {
                        const monthMap: {[key:string]: string} = {
                            'Jan': 'JANUARY', 'Feb': 'FEBRUARY', 'Mar': 'MARCH', 'Apr': 'APRIL', 'May': 'MAY', 'Jun': 'JUNE',
                            'Jul': 'JULY', 'Aug': 'AUGUST', 'Sep': 'SEPTEMBER', 'Oct': 'OCTOBER', 'Nov': 'NOVEMBER', 'Dec': 'DECEMBER',
                            'jan': 'JANUARY', 'feb': 'FEBRUARY', 'mar': 'MARCH', 'apr': 'APRIL', 'may': 'MAY', 'jun': 'JUNE',
                            'jul': 'JULY', 'aug': 'AUGUST', 'sep': 'SEPTEMBER', 'oct': 'OCTOBER', 'nov': 'NOVEMBER', 'dec': 'DECEMBER'
                        };
                        const m = parts[0];
                        const y = parts[1].length === 2 ? '20' + parts[1] : parts[1];
                        
                        if (isPaye) {
                            periodVal = monthMap[m] || monthMap[m.toLowerCase()] || m.toUpperCase();
                        } else {
                            periodVal = y;
                        }
                    } else {
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

                // Create sheet for this state
                const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);

                const range = XLSX.utils.decode_range(ws['!ref'] || "A1");
                for(let R = range.s.r; R <= range.e.r; ++R) {
                     const C = 1; // Column B (Date)
                     const cellRef = XLSX.utils.encode_cell({c: C, r: R});
                     if (ws[cellRef] && R > 0) { 
                         ws[cellRef].z = 'dd/mm/yyyy';
                     }
                }

                ws['!cols'] = [{ wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 35 }, { wch: 20 }];
                
                // Sheet name limited to 31 chars
                const sheetName = `Upload - ${state}`.substring(0, 31);
                XLSX.utils.book_append_sheet(wb, ws, sheetName);
            }
            
            XLSX.writeFile(wb, "Combined_Upload_Schedule.xlsx");

        } else {
            // --- Standard Template Logic (Styled) ---
            // Group by State AND Year
            const thinBorder = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
            const headerStyle = { font: { bold: true, sz: 11 }, border: thinBorder, alignment: { horizontal: "center", vertical: "center" }, fill: { fgColor: { rgb: "EEEEEE" } } };
            const dataStyle = { border: thinBorder, font: { sz: 11 } };
            const titleStyle = { font: { bold: true, sz: 14 } };

            // Robust year extractor that handles messy periods and falls back to payment date
            const getYearFromPeriod = (period: string | undefined, paymentDate: string) => {
                let p = period ? period.trim() : "";
                
                // 1. Try to find a 2-4 digit year at the end of the period string (e.g. "Jan-23", "2023")
                const matchEnd = p.match(/(\d{2,4})$/);
                if (matchEnd) {
                    return matchEnd[1].length === 2 ? `20${matchEnd[1]}` : matchEnd[1];
                }
                
                // 2. Try to find any 4 digit year in the string (e.g. "Jan 2023 Payment")
                const matchAny = p.match(/(\d{4})/);
                if (matchAny) return matchAny[1];

                // 3. Fallback to Payment Date Year
                if (paymentDate) {
                    const d = new Date(paymentDate);
                    if (!isNaN(d.getTime())) return d.getFullYear().toString();
                }
                
                return "Unknown";
            };

            // Loop through each state
            for (const [state, stateRows] of Object.entries(dataByState)) {
                 const dataByYear: { [key: string]: ScannerResult[] } = {};

                 stateRows.forEach(row => {
                    const year = getYearFromPeriod(row.paymentPeriod, row.paymentDate);
                    if (!dataByYear[year]) dataByYear[year] = [];
                    dataByYear[year].push(row);
                });

                // For each year within this state, create a sheet
                for (const year in dataByYear) {
                    const sheetData = dataByYear[year];
                    
                    const companyCounts = sheetData.reduce((acc, row) => {
                        const name = row.companyName || "Unknown";
                        acc[name] = (acc[name] || 0) + 1;
                        return acc;
                    }, {} as Record<string, number>);
                    const titleName = Object.keys(companyCounts).reduce((a, b) => companyCounts[a] > companyCounts[b] ? a : b, "NASD PLC");
                    
                    const ws = XLSX.utils.aoa_to_sheet([]);
                    
                    XLSX.utils.sheet_add_aoa(ws, [[titleName]], { origin: "A1" });
                    if(ws['A1']) ws['A1'].s = titleStyle;

                    XLSX.utils.sheet_add_aoa(ws, [[`${state.toUpperCase()} REMITTANCE SCHEDULE FOR ${year}`]], { origin: "A2" });
                    if(ws['A2']) ws['A2'].s = { font: { bold: true, sz: 12 } };

                    const headers = ["PAYMENT DATE", "PERIOD", "RECEIPT NUMBER", "TAX TYPE", "AMOUNT [N]"];
                    XLSX.utils.sheet_add_aoa(ws, [headers], { origin: "A4" });
                    
                    ['A4', 'B4', 'C4', 'D4', 'E4'].forEach(ref => {
                        if (ws[ref]) ws[ref].s = headerStyle;
                    });
                    
                    // --- NEW GROUPING LOGIC ---
                    
                    // 1. Group data by Tax Type
                    const groups: Record<string, ScannerResult[]> = {};
                    sheetData.forEach(r => {
                        const key = r.taxType ? r.taxType.trim().toUpperCase() : "OTHER";
                        if (!groups[key]) groups[key] = [];
                        groups[key].push(r);
                    });
                    
                    const sortedGroupKeys = Object.keys(groups).sort();
                    
                    let currentWriteRow = 4; // Start writing data from Row 5 (Index 4)
                    
                    sortedGroupKeys.forEach(groupKey => {
                        const groupRows = groups[groupKey];
                        // Sort rows within group by date
                        groupRows.sort((a,b) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime());

                        // Add Section Header
                        XLSX.utils.sheet_add_aoa(ws, [[groupKey]], { origin: { r: currentWriteRow, c: 0 } });
                        
                        // Merge header across
                        if(!ws['!merges']) ws['!merges'] = [];
                        ws['!merges'].push({ s: { r: currentWriteRow, c: 0 }, e: { r: currentWriteRow, c: 4 } });
                        
                        const shCell = XLSX.utils.encode_cell({r: currentWriteRow, c: 0});
                        if(ws[shCell]) ws[shCell].s = { 
                            font: { bold: true, sz: 11, color: { rgb: "FFFFFF" } }, 
                            fill: { fgColor: { rgb: "6D28D9" } },
                            alignment: { horizontal: "left" },
                            border: thinBorder
                        };
                        
                        currentWriteRow++; // Next row

                        const rowsToAdd = groupRows.map(row => [
                            row.paymentDate ? new Date(row.paymentDate) : undefined,
                            row.paymentPeriod,
                            row.receiptNumber,
                            row.taxType,
                            row.amount
                        ]);

                        XLSX.utils.sheet_add_aoa(ws, rowsToAdd, { origin: { r: currentWriteRow, c: 0 } });
                        
                        // Style Data Rows
                        rowsToAdd.forEach((_, idx) => {
                            const r = currentWriteRow + idx;
                            const dateRef = XLSX.utils.encode_cell({c: 0, r});
                            if (ws[dateRef]) {
                                ws[dateRef].z = 'dd/mm/yyyy';
                                ws[dateRef].s = { ...dataStyle, alignment: { horizontal: "center" } };
                            }
                            [1, 2, 3].forEach(c => {
                                const ref = XLSX.utils.encode_cell({c, r});
                                if(ws[ref]) ws[ref].s = dataStyle;
                            });
                            const amtRef = XLSX.utils.encode_cell({c: 4, r});
                            if (ws[amtRef]) {
                                ws[amtRef].z = '#,##0.00';
                                ws[amtRef].s = dataStyle;
                            }
                        });
                        
                        currentWriteRow += rowsToAdd.length;
                        
                        // Optional Subtotal for Group
                        const subTotal = groupRows.reduce((sum, r) => sum + (r.amount || 0), 0);
                        // Add empty row then subtotal? No, just directly under or with 1 space? 
                        // Let's put a subtotal line.
                        XLSX.utils.sheet_add_aoa(ws, [["", "", "", "Subtotal", subTotal]], { origin: { r: currentWriteRow, c: 0 } });
                        
                        const subLabelRef = XLSX.utils.encode_cell({c: 3, r: currentWriteRow});
                        const subValRef = XLSX.utils.encode_cell({c: 4, r: currentWriteRow});
                        if(ws[subLabelRef]) ws[subLabelRef].s = { font: { italic: true, sz: 10 }, alignment: { horizontal: "right" } };
                        if(ws[subValRef]) {
                            ws[subValRef].z = '#,##0.00';
                            ws[subValRef].s = { font: { italic: true, sz: 10 }, border: { top: { style: "thin" } } };
                        }
                        
                        currentWriteRow += 2; // Move past subtotal + 1 empty spacing row
                    });

                    // Grand Total
                    const total = sheetData.reduce((sum, row) => sum + (row.amount || 0), 0);
                    const totalRowIndex = currentWriteRow;
                    
                    XLSX.utils.sheet_add_aoa(ws, [["", "", "", "GRAND TOTAL", total]], { origin: { r: totalRowIndex, c: 0 } });
                    
                    const totalLabelRef = XLSX.utils.encode_cell({c: 3, r: totalRowIndex});
                    const totalValRef = XLSX.utils.encode_cell({c: 4, r: totalRowIndex});

                    if(ws[totalLabelRef]) ws[totalLabelRef].s = { font: { bold: true } };
                    if(ws[totalValRef]) {
                        ws[totalValRef].z = '#,##0.00';
                        ws[totalValRef].s = { font: { bold: true }, border: { bottom: { style: "double" } } };
                    }

                    ws['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 35 }, { wch: 30 }, { wch: 20 }];

                    const sheetName = `${state} ${year}`.substring(0, 31);
                    XLSX.utils.book_append_sheet(wb, ws, sheetName);
                }
            }
            
            // Filename generation
            const companyNames = Object.keys(scannerResults.reduce((acc, row) => {
                if (row.companyName) acc[row.companyName] = (acc[row.companyName] || 0) + 1;
                return acc;
            }, {} as Record<string, number>));
            
            let dominantCompany = "Unknown_Company";
            if (companyNames.length > 0) dominantCompany = companyNames[0]; 

            const safeCompanyName = dominantCompany.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "_");
            const filename = `${safeCompanyName}_Remittance_Schedule.xlsx`;
            
            XLSX.writeFile(wb, filename);
        }
    };
    
    // --- Render Logic ---

    const isLoading = scannerIsLoading;

    return (
        <div className="w-full max-w-7xl mx-auto relative">
            {/* Modal for Configuration Removed */}

            {/* Modal for Download Selection */}
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
                                <span className="mr-2">📤</span> For Portal Upload (Separated by State)
                            </button>
                            <button
                                onClick={() => handleDownloadConfirm('standard')}
                                className="w-full py-3 px-4 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium transition-colors flex items-center justify-center"
                            >
                                <span className="mr-2">📎</span> As Attachment (Separated by State & Year)
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
                <h1 className="text-4xl font-bold text-slate-100 tracking-wider">REMITTANCE SCHEDULE AI</h1>
                <p className="text-slate-400 mt-2">Your personal AI-powered toolkit.</p>
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
                                Drag & drop files here or <span className="text-violet-400">click to browse</span>
                            </span>
                            <span className="mt-1 block text-xs text-slate-500">
                                PDF, PNG, JPG, WebP
                            </span>
                        </label>
                        <input id="file-upload" name="file-upload" type="file" className="sr-only" multiple accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={(e) => handleFileChange(e.target.files)} />
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
                                <div key={index} className={`p-4 rounded-md text-sm border break-words ${
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
                                            <th className="px-6 py-3 text-left text-xs font-medium text-violet-300 uppercase tracking-wider">State</th>
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
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-300">{result.state}</td>
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
            </main>
            
            <footer className="fixed bottom-4 right-4 text-xs text-slate-500 font-medium opacity-80 z-50">
                &copy; IBRAHIM O.
            </footer>
        </div>
    );
};

export default App;