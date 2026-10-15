<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Remittance Schedule Tool

This app extracts remittance receipt data from PDFs and images without calling a cloud AI API. It uses browser-side PDF text extraction, bundled OCR for scanned receipts/images, and the existing Excel schedule exports.

PDFs can contain multiple unique receipts on separate pages or on the same page. The parser separates each receipt into its own schedule row and consolidates duplicate print copies using stable receipt identifiers such as PRN, payment reference, RRR, or receipt number. Scanned PDF pages are checked in their original orientation and rotated left or right when receipt signals are not detected.

PDF text items are reconstructed into readable lines before parsing, with recovery rules for fragmented receipt numbers and amounts. Incomplete receipts remain visible and are flagged for review instead of being silently discarded.

## Security Notes

- No Gemini or other LLM API keys are required.
- OCR worker, WASM core, and English traineddata are served from `public/ocr`.
- Do not commit `.env.local` or any production credentials.
- Review the generated schedule before filing or uploading it, especially when source files are scanned receipts.

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Run the app:
   `npm run dev`
3. Build for deployment:
   `npm run build`
4. Run the parser regression tests:
   `npm test`
