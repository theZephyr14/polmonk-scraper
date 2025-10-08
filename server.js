 const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('.', { maxAge: 0 }));

// Serve index.html with no-cache to avoid stale UI
app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ===== SSE streaming support =====
let sseClients = [];
function sendEvent(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((res) => {
        try { res.write(payload); } catch(_) {}
    });
}

app.get('/api/process-properties-stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });
    res.flushHeaders?.();
    sseClients.push(res);
    req.on('close', () => {
        sseClients = sseClients.filter((r) => r !== res);
        try { res.end(); } catch(_) {}
    });
});

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = 'uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir);
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: function (req, file, cb) {
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only Excel files are allowed!'), false);
        }
    },
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

// ---------- timing & retry helpers (inspired by backup scripts) ----------
const WAIT_MS = 5000; // base wait between major actions (be patient on cloud)
const MAX_WAIT_LOOPS = 20; // 20 * 500ms = 10s loops

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(min = 200, max = 800) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Detect Browserless 429 responses and websocket closure indicating throttling
// (Backoff removed) We now connect directly per property using createBrowserSession()

async function withRetry(task, attempts = 3, backoffMs = 800, label = 'step') {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            return await task(i);
        } catch (err) {
            lastErr = err;
            await sleep(backoffMs * i);
        }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${lastErr?.message || lastErr}`);
}

async function waitForUrlContains(page, fragment, timeoutMs = 30000) {
    const loops = Math.max(1, Math.floor(timeoutMs / 500));
    for (let i = 0; i < loops; i++) {
        if (page.url().includes(fragment)) return true;
        await sleep(500);
    }
    return false;
}

async function navigateWithWatchdog(page, url, label, timeoutMs = 30000) {
    console.log(`NAV: navigating to ${label} -> ${url}`);
    sendEvent({ type: 'log', level: 'info', message: `🌐 Navigating to ${label}…` });
    try {
        // Use 'domcontentloaded' instead of 'networkidle' to avoid hanging on slow resources
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await sleep(2000); // Give it 2s to settle
        console.log(`NAV: reached ${label}`);
        sendEvent({ type: 'log', level: 'success', message: `✅ Reached ${label}` });
    } catch (e) {
        console.log(`NAV: error navigating to ${label}: ${e.message}`);
        sendEvent({ type: 'log', level: 'error', message: `❌ Navigation error: ${e.message}` });
        throw new Error(`Timeout after ${timeoutMs}ms navigating to ${label}`);
    }
}

async function probeUrl(url, label, timeoutMs = 8000) {
    console.log(`PROBE: ${label} -> ${url}`);
    sendEvent({ type: 'log', level: 'info', message: `🛰️ Probing ${label}…` });
    try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        const res = await fetch(url, { method: 'GET', signal: ac.signal });
        clearTimeout(t);
        console.log(`PROBE: ${label} status ${res.status}`);
        sendEvent({ type: 'log', level: 'info', message: `✅ Probe ${label}: ${res.status}` });
        return true;
    } catch (e) {
        console.log(`PROBE: ${label} failed: ${e.message || e}`);
        sendEvent({ type: 'log', level: 'error', message: `❌ Probe ${label} failed: ${e.message || e}` });
        return false;
    }
}

async function debugLoginDom(page) {
    try {
        const infos = [];
        const frames = [page, ...page.frames()];
        for (const f of frames) {
            const url = f.url?.() || 'n/a';
            const emailCount = await f.locator('input[name="email"]').count().catch(()=>0);
            const passCount = await f.locator('input[name="password"]').count().catch(()=>0);
            infos.push({ url, emailCount, passCount });
        }
        sendEvent({ type: 'log', level: 'info', message: `🔎 DOM probe: ${JSON.stringify(infos)}` });
    } catch (_) {}
}

async function waitCloudflareIfPresent(page, timeoutMs = 30000) {
    try {
        const start = Date.now();
        // If a Cloudflare challenge frame appears, wait for it to disappear
        while (Date.now() - start < timeoutMs) {
            const hasCf = page.frames().some(f => /challenges\.cloudflare\.com/i.test(f.url?.() || ''));
            if (!hasCf) break;
            await sleep(1000);
        }
    } catch (_) {}
}

// Try to find elements either on the main page or within any iframe
async function queryInPageOrFrames(page, selectors) {
    // Main page first
    for (const sel of selectors) {
        const loc = page.locator(sel).first();
        try {
            if (await loc.count()) return { frame: page, locator: loc };
        } catch (_) {}
    }
    // Then child frames
    for (const frame of page.frames()) {
        for (const sel of selectors) {
            try {
                const loc = frame.locator(sel).first();
                if (await loc.count()) return { frame, locator: loc };
            } catch (_) {}
        }
    }
    return null;
}

async function fillLoginCredentials(page, email, password) {
    // Prefer explicit Polaroo fields, with label/placeholder fallbacks (still precise to the form shown)
    const tryBuildLocators = (root) => ([
        root.locator('input[name="email"]').first(),
        root.getByLabel?.(/Email/i),
        root.getByPlaceholder?.(/Email/i),
    ].filter(Boolean));

    const tryBuildPassLocators = (root) => ([
        root.locator('input[name="password"]').first(),
        root.getByLabel?.(/Password/i),
        root.getByPlaceholder?.(/Password/i),
    ].filter(Boolean));

    const roots = [page, ...page.frames()];
    let emailLoc; let passLoc;
    for (const root of roots) {
        for (const loc of tryBuildLocators(root)) {
            try { if (await loc.count()) { emailLoc = loc; break; } } catch(_) {}
        }
        if (emailLoc) {
            for (const loc of tryBuildPassLocators(root)) {
                try { if (await loc.count()) { passLoc = loc; break; } } catch(_) {}
            }
        }
        if (emailLoc && passLoc) break;
    }

    if (!emailLoc || !passLoc) {
        try {
            const p = `/tmp/login-missing-${Date.now()}.png`;
            await page.screenshot({ path: p, fullPage: true }).catch(()=>{});
            sendEvent({ type: 'log', level: 'warning', message: `📸 Saved screenshot for missing inputs: ${p}` });
        } catch(_) {}
        return false;
    }

    try { await emailLoc.waitFor({ state: 'visible', timeout: 15000 }); } catch { return false; }
    try { await passLoc.waitFor({ state: 'visible', timeout: 15000 }); } catch { return false; }

    await emailLoc.fill(email, { timeout: 8000 }).catch(()=>{});
    await passLoc.fill(password, { timeout: 8000 }).catch(()=>{});
    return true;
}

// Some providers hide email/password behind a "Continue with email" toggle
async function maybeRevealEmailLogin(page) {
    const revealSelectors = [
        'button:has-text("Continue with email")',
        'button:has-text("Sign in with email")',
        'button:has-text("Use email")',
        'a:has-text("Continue with email")',
        'a:has-text("Sign in with email")',
        'a:has-text("Use email")'
    ];
    // Try on main page and frames
    const targets = [];
    for (const sel of revealSelectors) targets.push({ frame: page, locator: page.locator(sel).first() });
    for (const frame of page.frames()) {
        for (const sel of revealSelectors) targets.push({ frame, locator: frame.locator(sel).first() });
    }
    for (const t of targets) {
        try {
            if (await t.locator.count()) { await t.locator.click({ timeout: 1500 }).catch(()=>{}); }
        } catch(_) {}
    }
}

// Fill and submit with resilience to frame reloads/detach
async function safeFillAndSubmit(page, email, password) {
    for (let i = 1; i <= 2; i++) {
        try {
            await maybeRevealEmailLogin(page).catch(()=>{});
            const filled = await fillLoginCredentials(page, email, password);
            if (!filled) return false;

            // Strict submit button again per-attempt (fresh locator each time)
            let submit = page.locator('button[type="submit"]').first();
            if (!(await submit.count())) {
                for (const frame of page.frames()) {
                    const cand = frame.locator('button[type="submit"]').first();
                    if (await cand.count()) { submit = cand; break; }
                }
            }
            await submit.click({ timeout: 5000 }).catch(async () => {
                await page.keyboard.press('Enter').catch(()=>{});
            });
            return true;
        } catch (e) {
            // If the login iframe reloaded, try once more
            if (String(e?.message || e).toLowerCase().includes('detached')) {
                await sleep(1500);
                continue;
            }
            throw e;
        }
    }
    return false;
}



// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/upload', upload.single('excelFile'), (req, res) => {
    try {
        const file = req.file;

        if (!file) {
            return res.status(400).json({
                success: false,
                message: 'Excel file is required'
            });
        }

        console.log('File upload:', {
            file: file.originalname,
            size: file.size,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: `File "${file.originalname}" has been uploaded successfully.`,
            data: {
                fileName: file.originalname,
                fileSize: file.size,
                uploadTime: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error processing upload:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while processing your request'
        });
    }
});

app.post('/api/secrets', (req, res) => {
    try {
        const { email, password, cohereKey } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required'
            });
        }

        // Store Cohere API key in environment if provided
        if (cohereKey && cohereKey.trim() !== '') {
            process.env.COHERE_API_KEY = cohereKey.trim();
            console.log('Cohere API key updated');
        }

        console.log('Secrets saved:', {
            email: email,
            hasCohereKey: !!cohereKey,
            timestamp: new Date().toISOString()
        });

        res.json({
            success: true,
            message: 'Secrets saved successfully!'
        });

    } catch (error) {
        console.error('Error saving secrets:', error);
        res.status(500).json({
            success: false,
            message: 'An error occurred while saving secrets'
        });
    }
});

// Environment flags for frontend (so we can hide Secrets when using Fly secrets)
app.get('/api/env-flags', (req, res) => {
    try {
        const hasPolaroo = Boolean(process.env.POLAROO_EMAIL && process.env.POLAROO_PASSWORD);
        const hasCohere = Boolean(process.env.COHERE_API_KEY);
        res.json({
            success: true,
            hasPolaroo,
            hasCohere
        });
    } catch (e) {
        res.json({ success: false, hasPolaroo: false, hasCohere: false });
    }
});

// Helper function to create browser session for a single property
async function createBrowserSession() {
    let browser, context, page;
    
    try {
        console.log('🟡 Launching Playwright Chromium...');
        const remoteWs = process.env.BROWSER_WS_URL || process.env.BROWSERLESS_WS_URL;
        const forceLocal = String(process.env.FORCE_LOCAL_CHROMIUM || '').toLowerCase() === 'true';
        
        if (forceLocal) {
            console.log('⛳ FORCE_LOCAL_CHROMIUM=true → using local Chromium');
            const userDataDir = '/tmp/chrome-profile';
            context = await chromium.launchPersistentContext(userDataDir, {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1366,768'
                ],
                proxy: process.env.PROXY_URL ? { server: process.env.PROXY_URL } : undefined
            });
        } else {
            if (!remoteWs) {
                throw new Error('BROWSER_WS_URL (Browserless) is not configured');
            }
            console.log('🌐 Connecting to remote browser over WebSocket…');
            browser = await chromium.connectOverCDP(remoteWs);
            context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                locale: 'en-US',
                timezoneId: 'Europe/Madrid',
            });
        }
        
        page = await context.newPage();
        
        // Configure page
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
            window.chrome = { runtime: {} };
        });
        await page.setViewportSize?.({ width: 1366, height: 768 });
        await context.setExtraHTTPHeaders?.({ 'Accept-Language': 'en-US,en;q=0.9' });
        page.setDefaultTimeout(15000);
        page.setDefaultNavigationTimeout(30000);
        
        console.log('✅ Browser session created successfully');
        return { browser, context, page };
        
    } catch (error) {
        console.error('❌ Failed to create browser session:', error);
        throw error;
    }
}

// Helper function to cleanup browser session
async function cleanupBrowserSession(browser, context) {
    try {
        if (context && typeof context.close === 'function') {
            await context.close();
        } else if (browser) {
            await browser.close();
        }
    } catch (error) {
        console.error('Error cleaning up browser session:', error);
    }
}

// Helper function to filter bills: exactly 1 electricity per month, and 1 water for second month
function filterBillsByMonth(tableData, targetMonths) {
    // Normalize rows
    const rows = [];
    for (const bill of tableData) {
        const fd = bill['Final date'] || '';
        const parts = fd.split('/');
        if (parts.length !== 3) continue;
        const month = parseInt(parts[1]);
        if (!Number.isFinite(month)) continue;

        const service = (bill.Service || '').toLowerCase();
        const total = parseFloat((bill.Total || '0').replace('€', '').replace(',', '.').trim()) || 0;

        rows.push({
            raw: bill,
            month,
            isElec: service.includes('electric'),
            isWater: service.includes('water') || service.includes('agua'),
            total
        });
    }

    // Electricity: pick exactly one per month (prefer the last occurrence)
    const electricity = [];
    for (const m of targetMonths) {
        const candidates = rows.filter(r => r.isElec && r.month === m);
        if (candidates.length > 0) electricity.push(candidates[candidates.length - 1].raw);
    }

    // Water: pick only for second month
    const secondMonth = targetMonths[1];
    const waterCandidates = rows.filter(r => r.isWater && r.month === secondMonth);
    const water = waterCandidates.length > 0 ? [waterCandidates[waterCandidates.length - 1].raw] : [];

    return { electricity, water };
}

// Helper function to get monthly allowance based on property and room count
function getMonthlyAllowance(propertyName, roomCount) {
    // Special case for Padilla 1-3
    if (propertyName.toLowerCase().includes('padilla 1-3')) {
        return 150;
    }
    
    // Room-based allowances
    if (roomCount <= 1) return 50;
    if (roomCount === 2) return 70;
    if (roomCount === 3) return 100;
    if (roomCount >= 4) return 130;
    
    // Default fallback
    return 70;
}

// Process properties endpoint with Cohere API and allowance calculations
app.post('/api/process-properties', async (req, res) => {
    try {
        const { properties, period } = req.body;
        
        if (!properties || !Array.isArray(properties) || properties.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Properties array is required'
            });
        }

        // Read Polaroo credentials from environment (Fly.io secrets)
        const email = process.env.POLAROO_EMAIL;
        const password = process.env.POLAROO_PASSWORD;
        if (!email || !password) {
            return res.status(500).json({
                success: false,
                message: 'POLAROO_EMAIL and POLAROO_PASSWORD must be set as Fly secrets'
            });
        }

        // Temporary limit support: env TEMP_LIMIT or body.limit
        const parsedLimit = parseInt(process.env.TEMP_LIMIT || req.body.limit, 10);
        const effectiveLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
        const totalToProcess = effectiveLimit ? Math.min(effectiveLimit, properties.length) : properties.length;

        console.log(`🚀 Starting processing for ${totalToProcess} properties`);
        if (period) {
            console.log(`📅 Period selected: ${period}`);
        }
        if (effectiveLimit) {
            console.log(`⛔ TEMP LIMIT ACTIVE: Capping run to first ${totalToProcess} properties`);
            sendEvent({ type: 'log', level: 'warning', message: `⛔ TEMP LIMIT: processing first ${totalToProcess} properties` });
        }
        
        // Determine target months from requested period (fallback to last 2 months if not provided)
        let targetMonths;
        if (period) {
            const map = {
                'Jan-Feb': [1, 2], 'Mar-Apr': [3, 4], 'May-Jun': [5, 6],
                'Jul-Aug': [7, 8], 'Sep-Oct': [9, 10], 'Nov-Dec': [11, 12]
            };
            targetMonths = map[period] || map['Jul-Aug'];
        } else {
            const currentMonth = new Date().getMonth() + 1;
            targetMonths = [];
            for (let i = 1; i >= 0; i--) {
                let m = currentMonth - i;
                if (m <= 0) m += 12;
                targetMonths.push(m);
            }
        }
        
        console.log(`📅 Processing months: ${targetMonths.join(', ')}`);
        
        const results = [];
        const logs = [];
        // Process each property with its own browser session
        for (let i = 0; i < properties.length; i++) {
            if (effectiveLimit && i >= effectiveLimit) break;
            const property = properties[i];
            const propertyName = property.name || property; // Handle both old and new format
            const roomCount = property.rooms || 0;
            
            logs.push({ message: `🏠 Processing property ${i + 1}/${totalToProcess}: ${propertyName} (${roomCount} rooms)`, level: 'info' });
            sendEvent({ type: 'log', level: 'info', message: `🏠 Processing property ${i + 1}/${totalToProcess}: ${propertyName}` });
            
            let browser, context, page;
            
            try {
                // Create new browser session for this property (no backoff)
                const session = await createBrowserSession();
                browser = session.browser;
                context = session.context;
                page = session.page;
                
                // Login to Polaroo
                await withRetry(async (attempt) => {
                    logs.push({ message: `🔑 Logging into Polaroo... (attempt ${attempt})`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `🔑 Logging into Polaroo... (attempt ${attempt})` });
                    
                    // Quick egress probe
                    await probeUrl('https://www.google.com', 'egress');
                    await probeUrl('https://app.polaroo.com', 'polaroo host');
                    
                    // Navigate to login page
                    await navigateWithWatchdog(page, 'https://app.polaroo.com/login', 'login page');
                    await waitCloudflareIfPresent(page, 60000);
                    await debugLoginDom(page);
                    await maybeRevealEmailLogin(page).catch(()=>{});
                    await sleep(WAIT_MS);
                    await debugLoginDom(page);

                    // Handle cookie/consent banners if present
                    try {
                        const consentBtn = page.getByRole('button', { name: /accept|agree|got it|aceptar|consent/i });
                        if (await consentBtn.count()) {
                            await consentBtn.first().click({ timeout: 2000 }).catch(() => {});
                        }
                    } catch (_) {}

                    if (!page.url().includes('dashboard')) {
                        logs.push({ message: '📝 Filling login credentials...', level: 'info' });
                        const ok = await safeFillAndSubmit(page, email, password);
                        if (!ok) throw new Error('Login inputs not found');
                    }

                    // Wait for dashboard
                    logs.push({ message: '⏳ Waiting for dashboard redirect...', level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: '⏳ Waiting for dashboard redirect...' });
                    const ok = await waitForUrlContains(page, 'dashboard', 30000);
                    if (!ok) {
                        logs.push({ message: '↪️ Forcing navigation to /dashboard', level: 'warning' });
                        sendEvent({ type: 'log', level: 'warning', message: '↪️ Forcing navigation to /dashboard' });
                        await page.goto('https://app.polaroo.com/dashboard', { timeout: 60000, waitUntil: 'networkidle' }).catch(()=>{});
                        await page.waitForLoadState('networkidle').catch(()=>{});
                    }
                    if (!page.url().includes('dashboard')) throw new Error('No dashboard after login');
                    logs.push({ message: '✅ Successfully logged into Polaroo!', level: 'success' });
                    sendEvent({ type: 'log', level: 'success', message: '✅ Successfully logged into Polaroo!' });
                }, 3, 1000, 'login');
                
                // Navigate to accounting dashboard
                logs.push({ message: `🔍 Navigating to accounting dashboard...`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: '🔍 Navigating to accounting dashboard...' });
                await withRetry(async () => {
                    await page.goto('https://app.polaroo.com/dashboard/accounting', { timeout: 60000, waitUntil: 'domcontentloaded' });
                    await sleep(8000); // Wait for table to load
                }, 2, 800, 'navigate-accounting');
                
                // Search for property
                logs.push({ message: `🔍 Searching for: ${propertyName}`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: `🔍 Searching for: ${propertyName}` });
                const searchInput = page.locator('input[placeholder*="search"], input[placeholder*="Search"]').first();
                if (await searchInput.count() > 0) {
                    await searchInput.fill(propertyName);
                    await page.keyboard.press('Enter');
                    await sleep(8000); // Wait for table to load
                }
                
                // Wait for table to load
                logs.push({ message: `📊 Waiting for invoice table to load...`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: '📊 Waiting for invoice table to load...' });
                await page.waitForSelector('table, .table, [role="table"]', { timeout: 60000 });
                
                // Extract table data (only needed columns)
                logs.push({ message: `📊 Extracting invoice data...`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: '📊 Extracting invoice data...' });
                const tableData = await page.evaluate(() => {
                    const tables = document.querySelectorAll('table, .table, [role="table"]');
                    const data = [];
                    
                    for (const table of tables) {
                        const rows = table.querySelectorAll('tr');
                        const headers = [];
                        
                        if (rows.length > 0) {
                            const headerRow = rows[0];
                            const headerCells = headerRow.querySelectorAll('th, td');
                            for (const cell of headerCells) {
                                headers.push(cell.textContent.trim());
                            }
                        }
                        
                        for (let i = 1; i < rows.length; i++) {
                            const row = rows[i];
                            const cells = row.querySelectorAll('td, th');
                            const rowData = {};
                            
                            for (let j = 0; j < cells.length && j < headers.length; j++) {
                                const cellText = cells[j].textContent.trim();
                                const header = headers[j];
                                
                                // Only extract needed columns
                                if (['Asset', 'Service', 'Initial date', 'Final date', 'Subtotal', 'Taxes', 'Total'].includes(header)) {
                                    rowData[header] = cellText;
                                }
                            }
                            
                            if (Object.keys(rowData).length > 0) {
                                data.push(rowData);
                            }
                        }
                    }
                    
                    return data;
                });
                
                logs.push({ message: `📋 Found ${tableData.length} total bills`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: `📋 Found ${tableData.length} total bills` });
                
                // Filter bills by month and service type
                logs.push({ message: `🔍 Filtering bills by month and service...`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: '🔍 Filtering bills by month and service...' });
                
                const filteredBills = filterBillsByMonth(tableData, targetMonths);
                const electricityBills = filteredBills.electricity;
                const waterBills = filteredBills.water;
                
                logs.push({ message: `⚡ Found ${electricityBills.length} electricity bills for selected months`, level: 'info' });
                logs.push({ message: `💧 Found ${waterBills.length} water bills for selected months`, level: 'info' });
                
                // Calculate costs
                const electricityCost = electricityBills.reduce((sum, bill) => {
                    const total = parseFloat((bill.Total || '0').replace('€', '').replace(',', '.').trim());
                    return sum + (isNaN(total) ? 0 : total);
                }, 0);
                
                const waterCost = waterBills.reduce((sum, bill) => {
                    const total = parseFloat((bill.Total || '0').replace('€', '').replace(',', '.').trim());
                    return sum + (isNaN(total) ? 0 : total);
                }, 0);
                
                const totalCost = electricityCost + waterCost;
                
                // Calculate allowance and overuse
                const monthlyAllowance = getMonthlyAllowance(propertyName, roomCount);
                const totalAllowance = monthlyAllowance * 2; // 2 months
                const overuseAmount = Math.max(0, totalCost - totalAllowance);
                
                logs.push({ message: `📊 Electricity: ${electricityBills.length} bills, ${electricityCost.toFixed(2)} €`, level: 'info' });
                logs.push({ message: `📊 Water: ${waterBills.length} bills, ${waterCost.toFixed(2)} €`, level: 'info' });
                logs.push({ message: `📊 Total Cost: ${totalCost.toFixed(2)} €, Allowance: ${totalAllowance} €, Overuse: ${overuseAmount.toFixed(2)} €`, level: 'success' });
                
                // Create result
                const result = {
                    property: propertyName,
                    success: true,
                    electricity_bills: electricityBills.length,
                    water_bills: waterBills.length,
                    electricity_cost: electricityCost,
                    water_cost: waterCost,
                    total_cost: totalCost,
                    overuse_amount: overuseAmount,
                    rooms: roomCount
                };
                
                results.push(result);
                logs.push({ message: `✅ COMPLETED: ${propertyName} - ${electricityBills.length} elec + ${waterBills.length} water = ${overuseAmount.toFixed(2)} € overuse`, level: 'success' });
                sendEvent({ type: 'log', level: 'success', message: `✅ COMPLETED: ${propertyName}` });
                
            } catch (error) {
                console.error(`❌ Error processing ${propertyName}:`, error.message);
                
                const result = {
                    property: propertyName,
                    success: false,
                    error: error.message
                };
                
                results.push(result);
                logs.push({ message: `❌ Failed to process ${propertyName}: ${error.message}`, level: 'error' });
                sendEvent({ type: 'log', level: 'error', message: `❌ Failed: ${propertyName} - ${error.message}` });
            } finally {
                // Cleanup browser session for this property
                await cleanupBrowserSession(browser, context);
            }
            
            // Small delay between properties (additional throttle)
            if (i < properties.length - 1) {
                await sleep(10000); // fixed 10s to avoid Browserless 429 bursts
            }
        }
        
        logs.push({ message: '🎉 Processing completed!', level: 'success' });
        
        res.json({
            success: true,
            results: results,
            logs: logs,
            totalProcessed: results.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length
        });
        
    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Processing failed',
            error: error.message
        });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 10MB.'
            });
        }
    }
    
    res.status(400).json({
        success: false,
        message: error.message
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Visit: http://localhost:${PORT}`);
});