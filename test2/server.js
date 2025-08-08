const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { JSDOM } = require('jsdom');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only PDF files are allowed'), false);
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

const LEGEND = {
    'OK': 'Current',
    '30': '30 Days Late',
    '60': '60 Days Late',
    '90': '90 Days Late',
    '120': '120 Days Late',
    '150': '150 Days Late',
    '180': '180 Days Late',
    'CO': 'Chargeoff or Collection',
    'RF': 'Repossession or Foreclosure',
    'PP': 'Payment Plan',
    'VS': 'Voluntary Surrender',
    'NDP': 'No Data Provided'
};

/**
 * Initialize PDF.js in a DOM environment
 */
async function initializePdfJs() {
    const dom = new JSDOM(`
        <!DOCTYPE html>
        <html>
        <head>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.min.js"></script>
        </head>
        <body></body>
        </html>
    `, {
        runScripts: "dangerously",
        resources: "usable",
        pretendToBeVisual: true
    });

    return new Promise((resolve, reject) => {
        dom.window.addEventListener('load', () => {
            try {
                const pdfjsLib = dom.window.pdfjsLib;
                pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js`;
                resolve(pdfjsLib);
            } catch (error) {
                reject(error);
            }
        });

        setTimeout(() => reject(new Error('PDF.js initialization timeout')), 10000);
    });
}

/**
 * Parses the uploaded PDF file using PDF.js (same as original HTML version)
 */
async function parsePdfWithPdfJs(buffer) {
    const pdfjsLib = await initializePdfJs();

    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    let allTextItems = [];

    // Extract text from all pages
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        // Add page number to each item for context
        textContent.items.forEach(item => item.page = i);
        allTextItems.push(...textContent.items);
    }

    return { textItems: allTextItems, numPages: pdf.numPages };
}

/**
 * Analyzes the extracted text items to find payment history grids and issues.
 * This is the exact same logic from your original HTML file.
 */
function analyzeTextContent(textItems) {
    const accounts = [];
    let currentAccount = null;

    // Find all account sections by looking for "Two-Year payment history"
    const paymentHistoryMarkers = textItems.filter(item => item.str.includes('Two-Year payment history'));

    if (paymentHistoryMarkers.length === 0) {
        throw new Error("Could not find any 'Two-Year payment history' sections in the document. The format might not be supported.");
    }

    for (const marker of paymentHistoryMarkers) {
        // Find the account name associated with this history marker.
        // The account name is usually the capitalized word appearing before the history table.
        const potentialAccountNames = textItems
            .filter(item => item.page === marker.page && item.transform[5] > marker.transform[5] && item.str.trim().length > 2 && item.str.toUpperCase() === item.str)
            .sort((a, b) => b.transform[5] - a.transform[5]); // Sort by y-position, descending

        let accountName = "Unknown Account";
        if (potentialAccountNames.length > 0) {
            // Find the closest name above the marker
            let closestName = null;
            let minDistance = Infinity;
            for (const name of potentialAccountNames) {
                const distance = name.transform[5] - marker.transform[5];
                if (distance > 0 && distance < minDistance) {
                    minDistance = distance;
                    closestName = name;
                }
            }
            if (closestName) accountName = closestName.str.trim();
        }

        currentAccount = { name: accountName, issues: [] };

        // Define a bounding box for the payment grid based on the marker's position
        const gridTop = marker.transform[5] - 100; // Approx 100 units above marker
        const gridBottom = marker.transform[5] - 20; // Just above the marker
        const gridPage = marker.page;

        const gridItems = textItems.filter(item =>
            item.page === gridPage &&
            item.transform[5] < gridBottom &&
            item.transform[5] > gridTop
        );

        // Parse the grid
        const grid = parsePaymentGrid(gridItems);

        // Analyze the parsed grid for issues
        if (grid.headers.length > 0) {
            for (const bureau of Object.keys(grid.data)) {
                grid.data[bureau].forEach((status, index) => {
                    if (status.trim() !== 'OK' && status.trim() !== '') {
                        const header = grid.headers[index] || { month: 'N/A', year: 'N/A' };
                        currentAccount.issues.push({
                            bureau,
                            month: header.month,
                            year: header.year,
                            status: LEGEND[status.trim()] || `Unknown Code: ${status.trim()}`
                        });
                    }
                });
            }
        }
        accounts.push(currentAccount);
    }

    return accounts.filter(acc => acc.issues.length > 0);
}

/**
 * Parses a set of text items into a structured payment grid.
 * This is the exact same logic from your original HTML file.
 */
function parsePaymentGrid(gridItems) {
    if (gridItems.length === 0) return { headers: [], data: {} };

    // Group items by row (y-coordinate)
    const rows = {};
    gridItems.forEach(item => {
        const y = Math.round(item.transform[5]);
        if (!rows[y]) rows[y] = [];
        rows[y].push(item);
    });

    // Sort rows by y-coordinate (top to bottom)
    const sortedRows = Object.values(rows).sort((a, b) => b[0].transform[5] - a[0].transform[5]);

    const monthRow = sortedRows.find(row => row.some(item => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].includes(item.str.trim())));
    const yearRow = sortedRows.find(row => row.some(item => /^\d{2}$/.test(item.str.trim())));
    const transUnionRow = sortedRows.find(row => row.some(item => item.str.includes('TransUnion')));
    const experianRow = sortedRows.find(row => row.some(item => item.str.includes('Experian')));
    const equifaxRow = sortedRows.find(row => row.some(item => item.str.includes('Equifax')));

    if (!monthRow || !yearRow) return { headers: [], data: {} };

    // Create headers
    const headers = monthRow.map(monthItem => ({
        month: monthItem.str.trim(),
        x: monthItem.transform[4],
        year: 'N/A'
    })).sort((a, b) => a.x - b.x);

    yearRow.forEach(yearItem => {
        let closestMonthIndex = -1;
        let minDistance = Infinity;
        headers.forEach((header, index) => {
            const distance = Math.abs(header.x - yearItem.transform[4]);
            if (distance < minDistance) {
                minDistance = distance;
                closestMonthIndex = index;
            }
        });
        if (closestMonthIndex !== -1) {
            headers[closestMonthIndex].year = `20${yearItem.str.trim()}`;
        }
    });

    const data = {};
    const processBureauRow = (bureauRow, bureauName) => {
        if (!bureauRow) return;
        const statusItems = bureauRow.filter(item => !item.str.includes(bureauName));
        const statuses = Array(headers.length).fill('');
        statusItems.forEach(statusItem => {
            let closestHeaderIndex = -1;
            let minDistance = Infinity;
            headers.forEach((header, index) => {
                const distance = Math.abs(header.x - statusItem.transform[4]);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestHeaderIndex = index;
                }
            });
            if (closestHeaderIndex !== -1) {
                statuses[closestHeaderIndex] = statusItem.str.trim();
            }
        });
        data[bureauName] = statuses;
    };

    processBureauRow(transUnionRow, 'TransUnion');
    processBureauRow(experianRow, 'Experian');
    processBureauRow(equifaxRow, 'Equifax');

    return { headers, data };
}

// Routes
app.get('/', (req, res) => {
    res.json({
        message: 'Credit Report Analyzer API',
        endpoints: {
            'POST /analyze': 'Upload PDF and get analysis results',
            'GET /health': 'Health check endpoint'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Add a GET handler for /analyze to provide usage instructions
app.get('/analyze', (req, res) => {
    res.json({
        message: 'This endpoint requires a POST request with a PDF file',
        usage: {
            method: 'POST',
            contentType: 'multipart/form-data',
            field: 'pdf',
            example: 'curl -X POST http://localhost:3000/analyze -F "pdf=@your_credit_report.pdf"'
        }
    });
});

app.post('/analyze', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                error: 'No PDF file uploaded. Please upload a PDF file using the "pdf" field.'
            });
        }

        console.log(`Processing PDF: ${req.file.originalname}, Size: ${req.file.buffer.length} bytes`);

        // Parse the PDF using PDF.js (same as original HTML version)
        const { textItems, numPages } = await parsePdfWithPdfJs(req.file.buffer);

        console.log(`Extracted ${textItems.length} text items from ${numPages} pages`);

        // Analyze the text content using the same logic as HTML version
        const analysisResults = analyzeTextContent(textItems);

        console.log(`Analysis complete: Found ${analysisResults.length} accounts with issues`);

        // Return results in the same format as before
        res.json({
            success: true,
            filename: req.file.originalname,
            totalPages: numPages,
            accountsWithIssues: analysisResults.length,
            results: analysisResults,
            legend: LEGEND
        });

    } catch (error) {
        console.error('Error analyzing PDF:', error);
        res.status(500).json({
            error: error.message || 'An error occurred while analyzing the PDF file.',
            success: false
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 10MB.' });
        }
    }

    res.status(500).json({
        error: error.message || 'Internal server error',
        success: false
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
    console.log(`Credit Report Analyzer API running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`API endpoint: POST http://localhost:${PORT}/analyze`);
});

module.exports = app;