// pdfjs-dist ships this worker build without its own type declarations —
// see the comment in app/api/files/extract/route.ts for why it's imported
// directly rather than left to pdf-parse's normal dynamic-import path.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
