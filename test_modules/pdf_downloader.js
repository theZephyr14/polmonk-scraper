const { chromium } = require('playwright');
const axios = require('axios');

// Helper function to sanitize filenames
function sanitize(name) {
    return String(name || "").replace(/[^A-Za-z0-9_\-]+/g, "_");
}

// Download PDFs for a specific property from Polaroo (reuses existing browser/context and login)
async function downloadPdfsForPropertyWithContext(propertyName, selectedBills, context, polarooEmail, polarooPassword) {
    console.log(`📥 Starting PDF download for: ${propertyName}`);
    
    const page = await context.newPage();
    
    try {
        // No need to login - context already has login session from main processing
        
        // Navigate to accounting dashboard
        console.log('🌐 Navigating to accounting dashboard...');
        await page.goto('https://app.polaroo.com/dashboard/accounting');
        await page.waitForTimeout(3000);
        
        // Search for property
        console.log(`🔍 Searching for: ${propertyName}`);
        const searchInput = page.locator('input[placeholder*="search"], input[placeholder*="Search"]').first();
        await searchInput.fill(propertyName);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000);
        
        // Wait for search results to load
        console.log('⏳ Waiting for search results...');
        await page.waitForSelector('table tr', { timeout: 10000 });
        
        // Find download buttons (cloud icons in # column)
        console.log(`📥 Looking for download buttons (cloud icons)...`);
        const downloadButtons = page.locator('table tr td:first-child button');
        const elementCount = await downloadButtons.count();
        
        console.log(`📋 Found ${elementCount} download buttons`);
        
        const pdfs = [];
        
        // Download PDFs by clicking cloud icons (up to 3 PDFs)
        const maxDownloads = Math.min(elementCount, 3);
        console.log(`📥 Downloading up to ${maxDownloads} PDFs...`);
        
        for (let i = 0; i < maxDownloads; i++) {
            try {
                console.log(`📥 Downloading PDF ${i + 1}/${maxDownloads}...`);
                
                // Set up new page promise for Adobe tab
                const newPagePromise = page.context().waitForEvent('page', { timeout: 10000 });
                
                // Click the cloud icon
                const element = downloadButtons.nth(i);
                await element.click();
                
                // Wait for new page (Adobe tab) to open
                const newPage = await newPagePromise;
                console.log('📄 Adobe tab opened, waiting for PDF to load...');
                
                // Wait for PDF network response and fetch raw bytes
                await newPage.waitForLoadState('networkidle', { timeout: 20000 });

                let pdfBuffer = null;

                try {
                    const pdfResponse = await newPage.waitForResponse(resp => {
                        const ct = resp.headers()['content-type'] || '';
                        return ct.includes('application/pdf');
                    }, { timeout: 10000 });
                    try {
                        pdfBuffer = await pdfResponse.body();
                    } catch (_) { /* ignore */ }
                } catch (_) { /* ignore */ }

                // Fallback: try to read the src from an embed/iframe and download via Axios (with cookies)
                if (!pdfBuffer || pdfBuffer.length < 1000) {
                    try {
                        const src = await newPage.evaluate(() => {
                            const el = document.querySelector('embed[type="application/pdf"], iframe');
                            return el ? (el.src || el.getAttribute('src')) : null;
                        });
                        if (src) {
                            // Collect cookies to pass along
                            const cookies = await newPage.context().cookies();
                            const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                            const resp = await axios.get(src, {
                                responseType: 'arraybuffer',
                                headers: { Cookie: cookieHeader }
                            });
                            pdfBuffer = Buffer.from(resp.data);
                        }
                    } catch (fallbackErr) {
                        console.log('⚠️ Fallback PDF fetch failed:', fallbackErr.message);
                    }
                }

                // As a last resort, avoid printing the web page to PDF (produces blank PDFs)

                // DEBUG: Check PDF integrity
                console.log(`🔍 DEBUG PDF ${i + 1}:`);
                console.log(`  - Buffer length: ${pdfBuffer ? pdfBuffer.length : 'null'}`);
                console.log(`  - Buffer type: ${typeof pdfBuffer}`);
                console.log(`  - First 20 bytes: ${pdfBuffer ? Array.from(pdfBuffer.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ') : 'null'}`);
                console.log(`  - Is valid PDF header: ${pdfBuffer && pdfBuffer.length > 4 ? pdfBuffer.slice(0, 4).toString() === '%PDF' : false}`);

                if (pdfBuffer && pdfBuffer.length > 0) {
                    const fileName = `${sanitize(propertyName)}_invoice_${Date.now()}.pdf`;
                    pdfs.push({
                        buffer: pdfBuffer,
                        fileName: fileName
                    });
                    console.log(`✅ Downloaded: ${fileName} (${pdfBuffer.length} bytes)`);
                } else {
                    console.log(`⚠️ No PDF content received for download ${i + 1}`);
                }
                
                // Close the Adobe tab
                await newPage.close();
                
            } catch (error) {
                console.log(`⚠️ Failed to download PDF ${i + 1}: ${error.message}`);
            }
        }
        
        return pdfs;
    } finally {
        // Close only the page, not the context
        await page.close();
    }
}

// Download PDFs for a specific property from Polaroo (creates new browser session)
async function downloadPdfsForProperty(propertyName, selectedBills, browserWsUrl, polarooEmail, polarooPassword) {
    console.log(`📥 Starting PDF download for: ${propertyName}`);
    
    // Connect to browser (local or remote)
    let browser;
    if (browserWsUrl) {
        // Use remote Browserless
        console.log('🌐 Connecting to remote browser...');
        browser = await chromium.connectOverCDP(browserWsUrl);
    } else {
        // Use local browser
        console.log('🖥️ Using local browser...');
        browser = await chromium.launch({ 
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled'
            ]
        });
    }
    const context = await browser.newContext();
    
    try {
        return await downloadPdfsForPropertyWithContext(propertyName, selectedBills, context, polarooEmail, polarooPassword);
    } finally {
        await context.close();
        await browser.close();
    }
}

// Login to Polaroo
async function loginToPolaroo(page, email, password) {
    console.log('🔑 Logging into Polaroo...');
    
    await page.goto('https://app.polaroo.com/login');
    await page.waitForTimeout(2000);
    
    // Check if already logged in
    const currentUrl = page.url();
    if (currentUrl.includes('dashboard')) {
        console.log('✅ Already logged in');
        return true;
    }
    
    // Fill credentials
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    
    // Click sign in
    try {
        await page.click('button[type="submit"]');
    } catch (e) {
        const signInButton = page.locator('button:has-text("Sign in")').first();
        if (await signInButton.count() > 0) {
            await signInButton.click();
        }
    }
    
    // Wait for dashboard redirect
    for (let i = 0; i < 20; i++) {
        const url = page.url();
        if (url.includes('dashboard')) {
            console.log('✅ Successfully logged into Polaroo!');
            return true;
        }
        await page.waitForTimeout(500);
    }
    
    throw new Error('Login failed - dashboard not reached');
}

// Download a single PDF matching the bill
async function downloadSinglePdf(page, billToMatch) {
    // Get table rows and find matching bill
    const tableRows = await page.evaluate((bill) => {
        const headerCells = Array.from(document.querySelectorAll('table thead th'));
        const headerTexts = headerCells.map(th => th.innerText.trim().toLowerCase());
        
        let serviceIdx = headerTexts.indexOf('service');
        let initialIdx = headerTexts.indexOf('initial date');
        let finalIdx = headerTexts.indexOf('final date');
        let totalIdx = headerTexts.indexOf('total');
        
        // If not found, try alternative header row
        if (serviceIdx === -1 || initialIdx === -1 || finalIdx === -1) {
            const ths = Array.from(document.querySelectorAll('table tr')).find(r => r.querySelectorAll('th').length)?.querySelectorAll('th');
            if (ths) {
                const texts = Array.from(ths).map(th => th.innerText.trim().toLowerCase());
                serviceIdx = texts.indexOf('service');
                initialIdx = texts.indexOf('initial date');
                finalIdx = texts.indexOf('final date');
                totalIdx = texts.indexOf('total');
            }
        }
        
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        return rows.map((tr, idx) => {
            const tds = Array.from(tr.querySelectorAll('td'));
            const service = serviceIdx >= 0 ? (tds[serviceIdx]?.innerText.trim() || '') : '';
            const initial = initialIdx >= 0 ? (tds[initialIdx]?.innerText.trim() || '') : '';
            const final = finalIdx >= 0 ? (tds[finalIdx]?.innerText.trim() || '') : '';
            const total = totalIdx >= 0 ? (tds[totalIdx]?.innerText.trim() || '') : '';
            return { idx, service, initial, final, total };
        });
    }, billToMatch);
    
    // Find matching row
    const service = billToMatch.Service || '';
    const initialDate = billToMatch['Initial date'] || billToMatch['Initial Date'] || '';
    const finalDate = billToMatch['Final date'] || billToMatch['Final Date'] || '';
    
    let matchingRowIdx = -1;
    for (const row of tableRows) {
        if (row.service && row.initial && row.final &&
            row.service.toLowerCase().includes(service.toLowerCase().split(' ')[0]) &&
            row.initial.includes(initialDate) &&
            row.final.includes(finalDate)) {
            matchingRowIdx = row.idx;
            break;
        }
    }
    
    if (matchingRowIdx === -1) {
        console.warn(`⚠️ Could not find matching row for ${service}`);
        return null;
    }
    
    // Click the download button in column 0 (#)
    const downloadButtons = page.locator('table tbody tr td:first-child button');
    const downloadButton = downloadButtons.nth(matchingRowIdx);
    
    // Set up listener for new page (PDF viewer)
    const newPagePromise = page.context().waitForEvent('page', { timeout: 15000 });
    
    await downloadButton.click();
    
    // Wait for new tab with PDF viewer
    const newPage = await newPagePromise;
    await newPage.waitForLoadState();
    
    const pdfUrl = newPage.url();
    console.log(`  📄 PDF viewer opened: ${pdfUrl.substring(0, 80)}...`);
    
    // Wait for viewer to load
    await newPage.waitForTimeout(3000);
    
    // Download PDF using direct URL with proper headers
    try {
        const response = await axios.get(pdfUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/pdf,application/octet-stream,*/*'
            },
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        const pdfBuffer = Buffer.from(response.data);
        
        // Validate PDF
        const pdfHeader = pdfBuffer.slice(0, 4).toString();
        if (pdfHeader !== '%PDF') {
            console.warn(`  ⚠️ Invalid PDF file (header: ${pdfHeader})`);
            await newPage.close();
            return null;
        }
        
        console.log(`  ✅ Valid PDF downloaded (${pdfBuffer.length} bytes)`);
        await newPage.close();
        return pdfBuffer;
        
    } catch (downloadError) {
        console.error(`  ❌ PDF download failed:`, downloadError.message);
        await newPage.close();
        return null;
    }
}

// Sanitize filename
function sanitize(name) {
    return String(name || '').replace(/[^A-Za-z0-9_-]+/g, '_');
}

module.exports = { downloadPdfsForProperty, downloadPdfsForPropertyWithContext, loginToPolaroo };

