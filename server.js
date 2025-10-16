 const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');
const HouseMonkAuthManager = require('./auth_manager');

// Helper function to sanitize filenames
function sanitize(name) {
    return String(name || "").replace(/[^A-Za-z0-9_\-]+/g, "_");
}

// Build JSON metadata files for property (from New try folder)
function buildJsonBlobsForProperty(propertyName, overuseData) {
    const entry = Array.isArray(overuseData) 
        ? overuseData.find(p => (p.property || "").toLowerCase() === (propertyName || "").toLowerCase())
        : overuseData;

    const nowIso = new Date().toISOString();
    const files = [];

    const summary = {
        type: "overuse_summary",
        property: propertyName,
        generatedAt: nowIso,
        overage: entry?.overuse_amount ?? null,
        rooms: entry?.rooms ?? null,
    };
    files.push({ 
        name: `${sanitize(propertyName)}_summary.json`, 
        content: JSON.stringify(summary, null, 2) 
    });

    if (entry?.selected_bills) {
        files.push({ 
            name: `${sanitize(propertyName)}_selected_bills.json`, 
            content: JSON.stringify(entry.selected_bills, null, 2) 
        });
    }

    if (entry?.monthly_overuse) {
        files.push({ 
            name: `${sanitize(propertyName)}_monthly_overuse.json`, 
            content: JSON.stringify(entry.monthly_overuse, null, 2) 
        });
    }

    return files.slice(0, 3); // send up to 3 JSONs
}

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize HouseMonk authentication manager
const authManager = new HouseMonkAuthManager();

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

// Local helper to login to Polaroo within this server (reuses existing inline flow)
async function performPolarooLogin(page, email, password) {
    // Quick egress probe
    await probeUrl('https://www.google.com', 'egress');
    await probeUrl('https://app.polaroo.com', 'polaroo host');

    // Navigate to login page and prepare DOM
    await navigateWithWatchdog(page, 'https://app.polaroo.com/login', 'login page');
    await waitCloudflareIfPresent(page, 60000);
    await debugLoginDom(page);
    await maybeRevealEmailLogin(page).catch(()=>{});
    await sleep(WAIT_MS);
    await debugLoginDom(page);

    // Consent banners if present
    try {
        const consentBtn = page.getByRole('button', { name: /accept|agree|got it|aceptar|consent/i });
        if (await consentBtn.count()) {
            await consentBtn.first().click({ timeout: 2000 }).catch(() => {});
        }
    } catch (_) {}

    if (!page.url().includes('dashboard')) {
        const ok = await safeFillAndSubmit(page, email, password);
        if (!ok) throw new Error('Login inputs not found');
    }

    // Wait for dashboard
    const arrived = await waitForUrlContains(page, 'dashboard', 30000);
    if (!arrived) {
        await page.goto('https://app.polaroo.com/dashboard', { timeout: 60000, waitUntil: 'networkidle' }).catch(()=>{});
        await page.waitForLoadState('networkidle').catch(()=>{});
    }
    if (!page.url().includes('dashboard')) throw new Error('No dashboard after login');
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

// Simple wrapper used by login flow to probe connectivity and log DOM state
async function probePage(page) {
    try {
        // Network probes
        await probeUrl('https://www.google.com', 'egress');
        await probeUrl('https://app.polaroo.com', 'polaroo host');
        // DOM probe
        await debugLoginDom(page);
    } catch (_) {
        // Best-effort only
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

async function isLoggedIn(page) {
    try {
        const url = page.url?.() || '';
        if (/\/dashboard\b/i.test(url)) return true;
        // Heuristic: look for a common dashboard element
        const hasDash = await page.locator('nav, [data-dashboard], [role="navigation"]').first().count().catch(()=>0);
        return hasDash > 0;
    } catch (_) {
        return false;
    }
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

// Properly parse European currency strings like "1.234,56 €" -> 1234.56
function parseEuro(value) {
    if (typeof value !== 'string') return Number(value) || 0;
    const s = value
        .replace(/[^0-9.,-]/g, '')
        .replace(/\.(?=\d{3}(\D|$))/g, '') // remove thousand dots
        .replace(',', '.'); // decimal comma -> dot
    const n = Number(s);
    return isNaN(n) ? 0 : n;
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
    
    // Add small delay to avoid rapid reconnections
    await sleep(2000 + Math.random() * 3000); // 2-5s random delay
    
    try {
        console.log('🟡 Launching Playwright Chromium...');
        let remoteWs = process.env.BROWSER_WS_URL || process.env.BROWSERLESS_WS_URL;
        if (remoteWs && !remoteWs.includes('timeout=')) {
            const sep = remoteWs.includes('?') ? '&' : '?';
            remoteWs = `${remoteWs}${sep}timeout=600000`;
        }
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
            
            // Retry with exponential backoff for 429 errors
            let lastError;
            for (let attempt = 1; attempt <= 5; attempt++) {
                try {
                    browser = await chromium.connectOverCDP(remoteWs);
                    break;
                } catch (error) {
                    lastError = error;
                    if (error.message.includes('429') && attempt < 5) {
                        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 30000); // Max 30s
                        console.log(`⚠️ Browserless 429 error, retrying in ${delay}ms (attempt ${attempt}/5)...`);
                        await sleep(delay);
                        continue;
                    }
                    throw error;
                }
            }
            if (!browser) throw lastError;
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
// In-flight run control (very simple cooperative cancel)
let CURRENT_RUN = null; // { cancelled: boolean }

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

        // Remove temporary limit: always process all provided properties
        const effectiveLimit = null;
        const totalToProcess = properties.length;

        console.log(`🚀 Starting processing for ${totalToProcess} properties`);
        if (period) {
            console.log(`📅 Period selected: ${period}`);
        }
        console.log('ℹ️ Processing all provided properties');
        sendEvent({ type: 'log', level: 'info', message: 'ℹ️ Processing all provided properties' });

        // Setup cooperative cancel (manual only, not on disconnect)
        CURRENT_RUN = { cancelled: false };
        
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
        
        // Create ONE browser session for all properties (optimized for paid Browserless)
        let browser, context;
        try {
            console.log('🟡 Creating shared browser session for all properties...');
            const session = await createBrowserSession();
            browser = session.browser;
            context = session.context;
            console.log('✅ Shared browser session created successfully');
        } catch (error) {
            console.error('❌ Failed to create shared browser session:', error);
            return res.status(500).json({
                success: false,
                message: 'Failed to create browser session',
                error: error.message
            });
        }
        
        try {
            // Login to Polaroo ONCE at the start (reuse for all properties)
            let loginPage = await context.newPage();
            try {
                await withRetry(async (attempt) => {
                    logs.push({ message: `🔑 Logging into Polaroo... (attempt ${attempt})`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `🔑 Logging into Polaroo... (attempt ${attempt})` });
                    await performPolarooLogin(loginPage, email, password);
                    logs.push({ message: '✅ Successfully logged into Polaroo!', level: 'success' });
                    sendEvent({ type: 'log', level: 'success', message: '✅ Successfully logged into Polaroo!' });
                }, 3, 1000, 'login');
                
                // Close login page - we'll reuse the context's cookies
                await loginPage.close();
                logs.push({ message: '🍪 Login session established - will reuse for all properties', level: 'success' });
                sendEvent({ type: 'log', level: 'success', message: '🍪 Login session established - will reuse for all properties' });
            } catch (error) {
                await loginPage.close();
                throw error;
            }
            
            // Process each property using the shared browser session (no re-login needed)
            // Honor client selection only: do not process any other properties
            const total = totalToProcess;
            const retried = new Set();
            for (let i = 0; i < total; i++) {
                if (CURRENT_RUN?.cancelled) {
                    logs.push({ message: '🛑 Run cancelled by client disconnect', level: 'warning' });
                    sendEvent({ type: 'log', level: 'warning', message: '🛑 Run cancelled by client disconnect' });
                    break;
                }
                
                // Small delay between properties to smooth load
                if (i > 0) await sleep(2000);
                
                const property = properties[i];
                const propertyName = property.name || property; // Handle both old and new format
                const roomCount = property.rooms || 0;
                
                // Update progress bar
                const progressPercentage = Math.round(((i + 1) / total) * 100);
                sendEvent({ type: 'progress', percentage: progressPercentage });
                
                logs.push({ message: `🏠 Processing property ${i + 1}/${totalToProcess}: ${propertyName} (${roomCount} rooms)`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: `🏠 Processing property ${i + 1}/${totalToProcess}: ${propertyName}` });
                
                let page;
                
                try {
                    // Create new page for this property (reuse browser/context with existing login)
                    page = await context.newPage();
                    
                    // Configure page
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
                        window.chrome = { runtime: {} };
                    });
                    await page.setViewportSize?.({ width: 1366, height: 768 });
                    page.setDefaultTimeout(15000);
                    page.setDefaultNavigationTimeout(30000);
            
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
                    rooms: roomCount,
                    unitCode: property.unitCode || ''
                    };
                    
                    // DEBUG: Log bill counts for data flow tracking
                    console.log(`🔍 DEBUG Bill Counts for ${propertyName}:`);
                    console.log(`  - electricity_bills: ${electricityBills.length}`);
                    console.log(`  - water_bills: ${waterBills.length}`);
                    console.log(`  - electricity_cost: ${electricityCost}`);
                    console.log(`  - water_cost: ${waterCost}`);
                    console.log(`  - overuse_amount: ${overuseAmount}`);
                    
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

                    // Auto-recover if Browserless closed the page/context/browser
                    const isClosedErr = /Target page, context or browser has been closed|browserContext\.newPage/i.test(error.message || '');
                    if (isClosedErr && !retried.has(i)) {
                        retried.add(i);
                        logs.push({ message: '♻️ Session appears closed. Recreating browser context and retrying property once...', level: 'warning' });
                        sendEvent({ type: 'log', level: 'warning', message: '♻️ Recreating browser and retrying current property once...' });
                        try {
                            await cleanupBrowserSession(browser, context);
                        } catch(_) {}
                        const session = await createBrowserSession();
                        browser = session.browser;
                        context = session.context;
                        // Re-login
                        let relogin = await context.newPage();
                        try {
                            await withRetry(async (attempt) => {
                                logs.push({ message: `🔑 Re-logging into Polaroo... (attempt ${attempt})`, level: 'info' });
                                await performPolarooLogin(relogin, email, password);
                            }, 2, 1000, 'relogin');
                        } finally {
                            await relogin.close().catch(() => {});
                        }
                        // Retry current index
                        i -= 1;
                        continue;
                    }
                } finally {
                    // Close page after each property (but keep browser/context alive)
                    if (page) {
                        try {
                            await page.close();
                        } catch (closeError) {
                            console.log(`⚠️ Warning: Failed to close page for ${propertyName}:`, closeError.message);
                        }
                    }
                    // Recycle context periodically to avoid TTL/memory issues
                    const processedCount = i + 1;
                    if (processedCount % 10 === 0 && processedCount < total) {
                        logs.push({ message: '♻️ Recycling browser context to keep session healthy...', level: 'info' });
                        sendEvent({ type: 'log', level: 'info', message: '♻️ Recycling browser context...' });
                        try { await context.close(); } catch(_) {}
                        const session = await createBrowserSession();
                        browser = session.browser;
                        context = session.context;
                        // Re-login after recycle
                        let relogin2 = await context.newPage();
                        try {
                            await withRetry(async (attempt) => {
                                logs.push({ message: `🔑 Re-logging into Polaroo after recycle... (attempt ${attempt})`, level: 'info' });
                                await performPolarooLogin(relogin2, email, password);
                            }, 2, 1000, 'relogin-after-recycle');
                        } finally {
                            await relogin2.close().catch(() => {});
                        }
                        await sleep(3000);
                    }
                }
            }
        } finally {
            // Cleanup shared browser session only at the end
            console.log('🧹 Cleaning up shared browser session...');
            await cleanupBrowserSession(browser, context);
        }
        
        if (!CURRENT_RUN?.cancelled) {
            logs.push({ message: '🎉 Processing completed!', level: 'success' });
        }
        
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

// Manual cancel endpoint to stop current run
app.post('/api/cancel-current-run', (req, res) => {
    if (CURRENT_RUN) CURRENT_RUN.cancelled = true;
    console.log('🛑 Cancel requested via API');
    sendEvent({ type: 'log', level: 'warning', message: '🛑 Cancel requested - stopping as soon as safe' });
    res.json({ success: true, message: 'Cancel requested' });
});

// Batch processing endpoint - processes 15 properties then restarts
app.post('/api/process-properties-batch', async (req, res) => {
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

        const batchProperties = properties;
        const totalBatches = 1;

        console.log(`🚀 Starting full processing - ${batchProperties.length} properties`);
        if (period) {
            console.log(`📅 Period selected: ${period}`);
        }
        console.log(`ℹ️ Processing ${batchProperties.length} properties`);
        sendEvent({ type: 'log', level: 'info', message: `ℹ️ Processing ${batchProperties.length} properties` });
        
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
        
        // Create ONE browser session for all properties (optimized for paid Browserless)
        let browser, context;
        try {
            console.log('🟡 Creating shared browser session for batch...');
            const session = await createBrowserSession();
            browser = session.browser;
            context = session.context;
            console.log('✅ Shared browser session created successfully');
        } catch (error) {
            console.error('❌ Failed to create shared browser session:', error);
            return res.status(500).json({
                success: false,
                message: 'Failed to create browser session',
                error: error.message
            });
        }
        
        try {
            // Login to Polaroo ONCE at the start (reuse for all properties)
            let loginPage = await context.newPage();
            try {
                await withRetry(async (attempt) => {
                    logs.push({ message: `🔑 Logging into Polaroo... (attempt ${attempt})`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `🔑 Logging into Polaroo... (attempt ${attempt})` });
                    
                    await loginPage.goto('https://app.polaroo.com/login', { timeout: 60000, waitUntil: 'domcontentloaded' });
                    await sleep(3000);
                    
                    await waitCloudflareIfPresent(loginPage);
                    await probePage(loginPage);
                    
                    // If we're already logged in (redirected), skip credential filling
                    if (await isLoggedIn(loginPage)) {
                        return; // success
                    }
                    
                    // Ensure email login fields are visible before filling
                    await maybeRevealEmailLogin(loginPage);
                    const filled = await fillLoginCredentials(loginPage, email, password);
                    if (!filled) throw new Error('Could not fill login credentials');
                    await sleep(2000);
                    
                    const submitButton = await queryInPageOrFrames(loginPage, [
                        'button[type="submit"]',
                        'input[type="submit"]',
                        'button:has-text("Sign in")',
                        'button:has-text("Login")',
                        'button:has-text("Log in")'
                    ]);
                    
                    if (submitButton) {
                        await submitButton.locator.click();
                        await sleep(5000);
                        await waitCloudflareIfPresent(loginPage);
                    }
                    
                    await loginPage.waitForURL('**/dashboard**', { timeout: 30000 });
                    logs.push({ message: '✅ Successfully logged into Polaroo!', level: 'success' });
                    sendEvent({ type: 'log', level: 'success', message: '✅ Successfully logged into Polaroo!' });
                }, 3, 2000, 'login');
                
                console.log('🍪 Login session established - will reuse for all properties');
                logs.push({ message: '🍪 Login session established - will reuse for all properties', level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: '🍪 Login session established - will reuse for all properties' });
                
            } finally {
                await loginPage.close();
            }
            
            // Process each property in the batch
            const total = batchProperties.length;
            for (let i = 0; i < total; i++) {
                // Add delay BEFORE processing each property (except first)
                if (i > 0) {
                    await sleep(25000 + Math.random() * 10000); // 25-35s random delay
                }
                
                const property = batchProperties[i];
                const propertyName = property.name || property; // Handle both old and new format
                const roomCount = property.rooms || 0;
                
                // Update progress bar
                const progressPercentage = Math.round(((i + 1) / total) * 100);
                sendEvent({ type: 'progress', percentage: progressPercentage });
                
                logs.push({ message: `🏠 Processing property ${i + 1}/${total}: ${propertyName} (${roomCount} rooms)`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: `🏠 Processing property ${i + 1}/${total}: ${propertyName}` });
                
                let page;
                
                try {
                    // Create new page for this property (reuse browser/context with existing login)
                    page = await context.newPage();
                    
                    // Configure page
                    await page.addInitScript(() => {
                        Object.defineProperty(navigator, 'webdriver', { get: () => false });
                        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
                        window.chrome = { runtime: {} };
                    });
                    await page.setViewportSize?.({ width: 1366, height: 768 });
                    page.setDefaultTimeout(15000);
                    page.setDefaultNavigationTimeout(30000);
            
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
                    
                    // Filter bills by target months and service type
                    logs.push({ message: `🔍 Filtering bills by month and service...`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: '🔍 Filtering bills by month and service...' });
                    
                    function parsePolarooDate(s) {
                        if (!s) return null;
                        // Formats seen: dd/mm/yyyy, yyyy-mm-dd
                        if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
                            const [dd, mm, yyyy] = s.split('/').map(Number);
                            return new Date(yyyy, mm - 1, dd);
                        }
                        const d = new Date(s);
                        return isNaN(d) ? null : d;
                    }

                    const filteredBills = tableData.filter(bill => {
                        const service = bill.Service?.toLowerCase() || '';
                        const initialDate = bill['Initial date'] || '';
                        const finalDate = bill['Final date'] || '';
                        
                        // Check if it's electricity or water
                        const isUtility = service.includes('electricity') || service.includes('water') || 
                                        service.includes('electric') || service.includes('agua') || 
                                        service.includes('luz') || service.includes('electricidad');
                        
                        if (!isUtility) return false;
                        
                        // Check if date falls within target months
                        const dateStr = initialDate || finalDate;
                        if (!dateStr) return false;
                        
                        const date = parsePolarooDate(dateStr);
                        if (!date) return false;
                        const month = date.getMonth() + 1;
                        // Optionally restrict to current year to avoid previous years inflating totals
                        const currentYear = new Date().getFullYear();
                        const yearOk = date.getFullYear() === currentYear;
                        return targetMonths.includes(month) && yearOk;
                    });
                    
                    // Separate electricity and water bills
                    const electricityBills = filteredBills.filter(bill => {
                        const service = bill.Service?.toLowerCase() || '';
                        return service.includes('electricity') || service.includes('electric') || 
                               service.includes('luz') || service.includes('electricidad');
                    });
                    
                    const waterBills = filteredBills.filter(bill => {
                        const service = bill.Service?.toLowerCase() || '';
                        return service.includes('water') || service.includes('agua');
                    });
                    
                    // Calculate costs
                    // Constrain to one bill per month per service and correct euro parsing
                    function monthKey(dateStr) {
                        const d = new Date(dateStr);
                        return isNaN(d) ? null : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
                    }

                    function dedupeByMonth(bills) {
                        const map = new Map();
                        for (const b of bills) {
                            const k = monthKey(b['Initial date'] || b['Final date']);
                            if (!k) continue;
                            // keep the latest row by Final date
                            const cur = map.get(k);
                            if (!cur) map.set(k, b);
                            else {
                                const curD = new Date(cur['Final date'] || cur['Initial date'] || 0);
                                const newD = new Date(b['Final date'] || b['Initial date'] || 0);
                                if (newD > curD) map.set(k, b);
                            }
                        }
                        return Array.from(map.values());
                    }

                    const electricityMonthly = dedupeByMonth(electricityBills);
                    const waterMonthly = dedupeByMonth(waterBills);

                    const electricityCost = electricityMonthly.reduce((sum, bill) => sum + parseEuro(bill.Total || '0'), 0);
                    
                    const waterCost = waterMonthly.reduce((sum, bill) => sum + parseEuro(bill.Total || '0'), 0);
                    
                    // Calculate overuse (simplified: assume 100€ per room per month is the limit)
                    const monthlyLimit = roomCount * 100;
                    const totalCost = electricityCost + waterCost;
                    const overuseAmount = Math.max(0, totalCost - monthlyLimit);
                    
                    // DEBUG: Log bill counts for data flow tracking
                    console.log(`🔍 DEBUG Bill Counts for ${propertyName}:`);
                    console.log(`  - electricity_bills: ${electricityBills.length}`);
                    console.log(`  - water_bills: ${waterBills.length}`);
                    console.log(`  - electricity_cost: ${electricityCost}`);
                    console.log(`  - water_cost: ${waterCost}`);
                    console.log(`  - overuse_amount: ${overuseAmount}`);
                    
                    const result = {
                        property: propertyName,
                        rooms: roomCount,
                        electricity_bills: electricityMonthly.length,
                        water_bills: waterMonthly.length,
                        electricity_cost: electricityCost,
                        water_cost: waterCost,
                        overuse_amount: overuseAmount,
                        success: true,
                        message: `Processed ${filteredBills.length} bills (${electricityBills.length} electricity, ${waterBills.length} water)`
                    };
                    
                    results.push(result);
                    logs.push({ message: `✅ COMPLETED: ${propertyName}`, level: 'success' });
                    sendEvent({ type: 'log', level: 'success', message: `✅ COMPLETED: ${propertyName}` });
                    
                } catch (error) {
                    console.error(`❌ Error processing ${propertyName}:`, error);
                    results.push({
                        property: propertyName,
                        rooms: roomCount,
                        electricity_bills: 0,
                        water_bills: 0,
                        electricity_cost: 0,
                        water_cost: 0,
                        overuse_amount: 0,
                        success: false,
                        message: error.message
                    });
                    logs.push({ message: `❌ FAILED: ${propertyName} - ${error.message}`, level: 'error' });
                    sendEvent({ type: 'log', level: 'error', message: `❌ FAILED: ${propertyName} - ${error.message}` });
                } finally {
                    if (page) {
                        await page.close();
                    }
                }
            }
            
        } finally {
            if (browser) {
                await browser.close();
            }
        }
        
        logs.push({ message: `🎉 Processing completed!`, level: 'success' });
        
        // Save batch results to file for persistence
        const batchData = {
            processedAt: new Date().toISOString(),
            results,
            logs
        };
        
        fs.writeFileSync(`batch_results.json`, JSON.stringify(batchData, null, 2));
        console.log(`💾 Saved results to batch_results.json`);
        
        res.json({
            success: true,
            batchNumber: 1,
            totalBatches: 1,
            results: results,
            logs: logs,
            totalProcessed: results.length,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length,
            hasMoreBatches: false,
            nextBatchNumber: null,
            restartRequired: false
        });
        
    } catch (error) {
        console.error('Batch processing error:', error);
        res.status(500).json({
            success: false,
            message: 'Batch processing failed',
            error: error.message
        });
    }
});

// Export overuse data for HouseMonk integration
app.post('/api/export-test-data', (req, res) => {
    try {
        const { results } = req.body;
        if (!results || !Array.isArray(results)) {
            return res.status(400).json({ success: false, message: 'Invalid results data' });
        }
    
        // Filter only properties with overuse > 0
        const overuseOnly = results.filter(r => r.overuse_amount > 0);
        
        // Add selected bills data for each overuse property
        const enrichedData = overuseOnly.map(property => ({
            ...property,
            selected_bills: property.electricity_bills > 0 ? [
                {
                    Service: 'Electricity',
                    'Initial date': '2024-01-01', // Placeholder - will be filled from actual data
                    'Final date': '2024-01-31',
                    Total: property.electricity_cost?.toFixed(2) || '0.00'
                }
            ] : [],
            period: 'Current Period',
            electricity_bills_count: property.electricity_bills,
            water_bills_count: property.water_bills
        }));
        
        fs.writeFileSync('test_overuse_data.json', JSON.stringify(enrichedData, null, 2));
        
        console.log(`📥 Exported ${enrichedData.length} properties with overuse to test_overuse_data.json`);
        
        res.json({ 
            success: true, 
            count: enrichedData.length,
            message: `Exported ${enrichedData.length} properties with overuse. Run: npm run test:hm:full`
        });
    } catch (error) {
        console.error('Error exporting test data:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// TEST ONLY: Verify exported test data exists and return a brief summary
app.get('/api/housemonk-test/summary', (req, res) => {
    try {
        const filePath = 'test_overuse_data.json';
        if (!fs.existsSync(filePath)) {
            return res.json({ success: true, exists: false, count: 0, properties: [] });
        }
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const properties = (data || []).map(r => ({ property: r.property, overuse: r.overuse_amount, rooms: r.rooms }));
        res.json({ success: true, exists: true, count: properties.length, properties });
    } catch (error) {
        console.error('Error reading test_overuse_data.json:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// TEST ONLY: Return the full exported JSON file for download
app.get('/api/housemonk-test/file', (req, res) => {
    try {
        const filePath = 'test_overuse_data.json';
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'test_overuse_data.json not found' });
        }
        res.setHeader('Content-Type', 'application/json');
        res.send(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error('Error sending test_overuse_data.json:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// TEST ONLY: HouseMonk sandbox auth check using proper token refresh
app.post('/api/housemonk-test/auth-check', async (req, res) => {
    try {
        console.log('🔍 Testing HouseMonk authentication...');
        
        // Get valid tokens (will refresh if needed)
        const masterToken = await authManager.getValidMasterToken();
        const userToken = await authManager.getValidUserToken();
        
        // Get token status for debugging
        const tokenStatus = authManager.getTokenStatus();
        
        console.log('✅ Authentication test successful');
        
        return res.json({ 
            success: true, 
            message: 'Authentication working properly',
            tokens: {
                masterToken: Boolean(masterToken),
                userToken: Boolean(userToken)
            },
            status: tokenStatus,
            debug: {
                masterTokenLength: masterToken ? masterToken.length : 0,
                userTokenLength: userToken ? userToken.length : 0
            }
        });
    } catch (error) {
        console.error('❌ HouseMonk auth-check error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message,
            step: 'authentication-test'
        });
    }
});


// TEST ONLY: Test making an actual API call with authentication
app.post('/api/housemonk-test/api-call', async (req, res) => {
    try {
        const { endpoint = '/api/home', method = 'GET' } = req.body;
        
        console.log(`🔍 Testing API call: ${method} ${endpoint}`);
        
        // Make authenticated request
        const response = await authManager.makeAuthenticatedRequest(method, endpoint);
        
        console.log('✅ API call successful');
        
        return res.json({
            success: true,
            message: 'API call successful',
            data: response.data,
            status: response.status,
            headers: response.headers
        });
    } catch (error) {
        console.error('❌ API call error:', error);
        res.status(500).json({
            success: false,
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
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

// Process overuse properties and download PDFs
app.post('/api/process-overuse-pdfs', async (req, res) => {
    try {
        const { results } = req.body;
        
        if (!results || !Array.isArray(results)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid results data'
            });
        }
        
        // Filter properties with overuse > 0
        const overuseProperties = results.filter(prop => prop.overuse_amount > 0);
        
        if (overuseProperties.length === 0) {
            return res.json({
                success: true,
                message: 'No properties with overuse found',
                count: 0
            });
        }
        
        console.log(`Processing ${overuseProperties.length} properties with overuse for PDF download`);
        sendEvent({ type: 'log', level: 'info', message: `Processing ${overuseProperties.length} properties with overuse for PDF download` });
        
        // Use real Polaroo credentials for PDF download and AWS upload
        const { downloadPdfsForPropertyWithContext } = require('./test_modules/pdf_downloader');
        const { uploadPdfAndMetadata } = require('./test_modules/aws_uploader');
        const { HouseMonkAuth } = require('./test_modules/housemonk_auth');
        
        // Import loginToPolaroo function
        const { loginToPolaroo } = require('./test_modules/pdf_downloader');
        
        // Initialize HouseMonk authentication
        const auth = new HouseMonkAuth();
        let authInitialized = false;
        
        // Create shared browser session for PDF downloads (optimized for paid Browserless)
        let browser, context;
        try {
            console.log('🟡 Creating shared browser session for PDF downloads...');
            sendEvent({ type: 'log', level: 'info', message: '🟡 Creating shared browser session for PDF downloads...' });
            const session = await createBrowserSession();
            browser = session.browser;
            context = session.context;
            console.log('✅ Shared browser session created successfully');
        } catch (error) {
            console.error('❌ Failed to create shared browser session for PDFs:', error);
            sendEvent({ type: 'log', level: 'error', message: `❌ Failed to create shared browser session for PDFs: ${error.message}` });
            return res.status(500).json({
                success: false,
                message: 'Failed to create browser session for PDF downloads',
                error: error.message
            });
        }
        
        const processedProperties = [];
        
        try {
            // Login to Polaroo ONCE at the start for PDF downloads (reuse for all properties)
            let loginPage = await context.newPage();
            try {
                console.log('🔑 Logging into Polaroo for PDF downloads...');
                sendEvent({ type: 'log', level: 'info', message: '🔑 Logging into Polaroo for PDF downloads...' });
                await performPolarooLogin(loginPage, process.env.POLAROO_EMAIL, process.env.POLAROO_PASSWORD);
                console.log('✅ Login established for PDF downloads - will reuse for all properties');
                sendEvent({ type: 'log', level: 'success', message: '✅ Login established for PDF downloads - will reuse for all properties' });
            } catch (error) {
                console.error('❌ Failed to login for PDF downloads:', error);
                sendEvent({ type: 'log', level: 'error', message: `❌ Failed to login for PDF downloads: ${error.message}` });
                throw error;
            } finally {
                await loginPage.close();
            }
            
            for (let i = 0; i < overuseProperties.length; i++) {
                const prop = overuseProperties[i];
                try {
                    console.log(`Downloading PDFs for ${prop.property}... (${i + 1}/${overuseProperties.length})`);
                    sendEvent({ type: 'log', level: 'info', message: `Downloading PDFs for ${prop.property}... (${i + 1}/${overuseProperties.length})` });
                    
                    // Update progress
                    const progress = Math.round(((i + 1) / overuseProperties.length) * 100);
                    sendEvent({ type: 'progress', percentage: progress });
                    
                    // Add delay between properties to avoid rate limiting
                    if (i > 0) {
                        console.log('⏳ Waiting 10 seconds to avoid rate limiting...');
                        sendEvent({ type: 'log', level: 'info', message: '⏳ Waiting 10 seconds to avoid rate limiting...' });
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                    
                    const pdfs = await downloadPdfsForPropertyWithContext(
                        prop.property,
                        prop.selected_bills || [],
                        context, // Reuse shared context with existing login
                        'francisco@node-living.com',
                        'Aribau126!'
                    );
                
                let uploadResults = [];
                
                // Upload PDFs to AWS if we have any
                if (pdfs.length > 0) {
                    try {
                        console.log(`☁️ Uploading ${pdfs.length} PDFs to HouseMonk AWS...`);
                        sendEvent({ type: 'log', level: 'info', message: `☁️ Uploading ${pdfs.length} PDFs to HouseMonk AWS...` });

                        // Use working credentials from New try folder
                        const workingToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiI2ODkxZGZiZjA1MmQxZDdmMzM2ZDBkNjIiLCJ0eXBlcyI6WyJhZG1pbiJdLCJpYXQiOjE3NTg1MzUzNjEsImV4cCI6MTc2NjMxMTM2MX0.wGHFL1Gd3cOODn6uHVcV5IbJ2xMZBoCoMmvydet8fRY";
                        const workingClientId = "1326bbe0-8ed1-11f0-b658-7dd414f87b53";

                        // Upload PDFs (using uploader module to normalize document objects)
                        for (const pdf of pdfs) {
                            const { pdfObjectKey, pdfDocument } = await uploadPdfAndMetadata(auth, pdf.buffer, pdf.fileName, prop);
                            uploadResults.push({
                                pdfObjectKey,
                                pdfDocument,
                                jsonObjectKeys: [],
                                jsonDocuments: []
                            });
                            console.log(`✅ Uploaded PDF: ${pdf.fileName} → ${pdfObjectKey}`);
                            sendEvent({ type: 'log', level: 'success', message: `✅ Uploaded PDF: ${pdf.fileName} → ${pdfObjectKey}` });
                        }

                        // Create and upload JSON metadata files
                        const jsonFiles = buildJsonBlobsForProperty(prop.property, prop);
                        const jsonObjectKeys = [];
                        
                        for (const jsonFile of jsonFiles) {
                            // Get presigned URL for JSON
                            const { jsonObjectKeys: newKeys, jsonDocuments } = await uploadPdfAndMetadata(auth, Buffer.from(jsonFile.content, "utf8"), jsonFile.name, prop);
                            newKeys.forEach(k => jsonObjectKeys.push(k));
                            // attach json documents to first result bucket
                            if (uploadResults.length > 0) {
                                const first = uploadResults[0];
                                first.jsonObjectKeys = [...(first.jsonObjectKeys || []), ...newKeys];
                                first.jsonDocuments = [...(first.jsonDocuments || []), ...jsonDocuments];
                            }
                            console.log(`✅ Uploaded JSON: ${jsonFile.name} → ${newKeys.join(', ')}`);
                            sendEvent({ type: 'log', level: 'success', message: `✅ Uploaded JSON: ${jsonFile.name} → ${newKeys.join(', ')}` });
                        }

                        // Update upload results with JSON object keys (compat)
                        uploadResults.forEach(result => {
                            result.jsonObjectKeys = jsonObjectKeys;
                        });

                        console.log(`✅ Uploaded ${pdfs.length} PDFs to AWS for ${prop.property}`);
                        sendEvent({ type: 'log', level: 'success', message: `✅ Uploaded ${pdfs.length} PDFs to AWS for ${prop.property}` });

                    } catch (uploadError) {
                        console.error(`❌ AWS upload failed for ${prop.property}:`, uploadError.response?.data?.message || uploadError.message);
                        sendEvent({ type: 'log', level: 'error', message: `❌ AWS upload failed for ${prop.property}: ${uploadError.response?.data?.message || uploadError.message}` });
                        // Continue with success status but note upload failure
                    }
                } else {
                    console.log(`⚠️ No PDFs downloaded for ${prop.property}`);
                    sendEvent({ type: 'log', level: 'warning', message: `⚠️ No PDFs downloaded for ${prop.property}` });
                }
                
                processedProperties.push({
                    property: prop.property,
                    overuse_amount: prop.overuse_amount,
                    rooms: prop.rooms,
                    unitCode: prop.unitCode || 'NOT_PROVIDED',
                    status: 'success',
                    message: `Downloaded ${pdfs.length} PDFs and uploaded to AWS successfully`,
                    pdfCount: pdfs.length,
                    uploadCount: uploadResults.length,
                    awsObjectKeys: uploadResults.map(r => r.pdfObjectKey),
                    jsonObjectKeys: uploadResults.length > 0 ? uploadResults[0].jsonObjectKeys : [],
                    // New: provide full document objects so frontend can pass them to Button 3
                    awsDocuments: uploadResults.map(r => r.pdfDocument).filter(Boolean),
                    jsonDocuments: uploadResults.length > 0 ? (uploadResults[0].jsonDocuments || []) : []
                });
                
                console.log(`✅ Processed ${prop.property}: ${pdfs.length} PDFs downloaded, ${uploadResults.length} uploaded to AWS`);
                sendEvent({ type: 'log', level: 'success', message: `✅ Processed ${prop.property}: ${pdfs.length} PDFs downloaded, ${uploadResults.length} uploaded to AWS` });

                // Small delay after processing each property
                if (i < overuseProperties.length - 1) {
                    console.log('⏳ Brief pause before next property...');
                    sendEvent({ type: 'log', level: 'info', message: '⏳ Brief pause before next property...' });
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

            } catch (error) {
                console.error(`❌ Failed to process ${prop.property}:`, error.message);
                sendEvent({ type: 'log', level: 'error', message: `❌ Failed to process ${prop.property}: ${error.message}` });
                processedProperties.push({
                    property: prop.property,
                    overuse_amount: prop.overuse_amount,
                    rooms: prop.rooms,
                    unitCode: prop.unitCode || 'NOT_PROVIDED',
                    status: 'failed',
                    message: `Processing failed: ${error.message}`,
                    error: error.message
                });
            }
            }
        } finally {
            // Cleanup shared browser session only at the end
            console.log('🧹 Cleaning up shared browser session for PDF downloads...');
            sendEvent({ type: 'log', level: 'info', message: '🧹 Cleaning up shared browser session for PDF downloads...' });
            await cleanupBrowserSession(browser, context);
        }
        
        const successCount = processedProperties.filter(p => p.status === 'success').length;
        const failedCount = processedProperties.filter(p => p.status === 'failed').length;
        
        return res.json({
            success: true,
            message: `PDF download completed: ${successCount} successful, ${failedCount} failed`,
            count: processedProperties.length,
            successCount,
            failedCount,
            properties: processedProperties
        });
        
    } catch (error) {
        console.error('Error processing overuse PDFs:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// Complete HouseMonk integration: Download PDFs → Upload to S3 → Create Invoices
app.post('/api/housemonk/process-overuse', async (req, res) => {
    try {
        const { results } = req.body;
        
        if (!results || !Array.isArray(results)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid results data'
            });
        }
        
        // Filter properties with overuse > 0
        const overuseProperties = results.filter(prop => prop.overuse_amount > 0);
        
        if (overuseProperties.length === 0) {
            return res.json({
                success: true,
                message: 'No properties with overuse found',
                count: 0,
                successCount: 0,
                failedCount: 0,
                items: []
            });
        }
        
        console.log(`🏠 Processing ${overuseProperties.length} properties with overuse for HouseMonk integration`);
        
        // Import required modules
        const { HouseMonkAuth, HouseMonkIDResolver } = require('./test_modules/housemonk_auth');
        const { createInvoiceForOveruse } = require('./test_modules/invoice_creator');
        
        // Initialize HouseMonk authentication
        console.log('🔐 Initializing HouseMonk authentication...');
        const auth = new HouseMonkAuth();
        await auth.refreshMasterToken();
        await auth.getUserAccessToken(auth.config.userId);
        console.log('✅ HouseMonk authentication successful');
        
        const resolver = new HouseMonkIDResolver(auth);
        const items = [];
        let successCount = 0;
        let failedCount = 0;
        
        // Process each property
        for (let i = 0; i < overuseProperties.length; i++) {
            const prop = overuseProperties[i];
            console.log(`\n[${i+1}/${overuseProperties.length}] Processing: ${prop.property}`);
            console.log(`💰 Overuse: ${prop.overuse_amount.toFixed(2)} €`);
            
            // Update progress
            const progress = Math.round(((i + 1) / overuseProperties.length) * 100);
            sendEvent({ type: 'progress', percentage: progress });
            
            try {
                // Prefer full document objects if available, else fall back to object keys
                const pdfInputs = (prop.awsDocuments && prop.awsDocuments.length > 0) ? prop.awsDocuments : (prop.awsObjectKeys || []);
                const jsonInputs = (prop.jsonDocuments && prop.jsonDocuments.length > 0) ? prop.jsonDocuments : (prop.jsonObjectKeys || []);

                if ((!pdfInputs || pdfInputs.length === 0)) {
                    console.log('❌ No AWS files found - please run Button 2 first to upload PDFs');
                    throw new Error('No AWS files found. Please run "Download PDFs & Upload to AWS" first.');
                }

                console.log(`📋 Using ${pdfInputs.length} AWS files from Button 2`);
                
                const printable = pdfInputs.map(f => (typeof f === 'string' ? f : f.objectKey));
                console.log(`✅ Using existing AWS files: ${printable.join(', ')}`);
                
                // Create invoice in HouseMonk using existing AWS files
                console.log('📝 Creating invoice in HouseMonk...');
                const invoice = await createInvoiceForOveruse(
                    auth,
                    resolver,
                    prop,
                    pdfInputs,
                    jsonInputs
                );
                
                console.log(`✅ Invoice created: ${invoice._id}`);
                
                items.push({
                    property: prop.property,
                    status: 'success',
                    invoiceId: invoice._id,
                    invoiceUrl: `${auth.config.baseUrl}/dashboard/transactions/${invoice._id}`,
                    overuseAmount: prop.overuse_amount,
                    pdfCount: pdfInputs.length,
                    aws: {
                        pdfs: printable,
                        json: (Array.isArray(jsonInputs) ? jsonInputs.map(f => (typeof f === 'string' ? f : f.objectKey)) : [])
                    }
                });
                
                successCount++;
                console.log(`🎉 Completed: ${prop.property}`);
                
            } catch (error) {
                console.error(`❌ Failed: ${prop.property} - ${error.message}`);
                items.push({
                    property: prop.property,
                    status: 'failed',
                    error: error.message,
                    overuseAmount: prop.overuse_amount
                });
                failedCount++;
            }
            
            // No delay needed for API calls - much faster processing
        }
        
        // Save results to file
        const fs = require('fs');
        fs.writeFileSync('test_housemonk_results.json', JSON.stringify(items, null, 2));
        
        console.log(`\n🎉 HouseMonk integration complete!`);
        console.log(`✅ Success: ${successCount}`);
        console.log(`❌ Failed: ${failedCount}`);
        
        return res.json({
            success: true,
            message: `HouseMonk integration completed: ${successCount} successful, ${failedCount} failed`,
            count: overuseProperties.length,
            successCount,
            failedCount,
            items
        });
        
    } catch (error) {
        console.error('❌ HouseMonk integration failed:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


// End-to-end: Download → Upload → Create Invoices (single run)
app.post('/api/run-overuse-end-to-end', async (req, res) => {
    try {
        const { results } = req.body;
        if (!results || !Array.isArray(results)) {
            return res.status(400).json({ success: false, message: 'Invalid results data' });
        }

        // Filter properties with overuse > 0, but also include properties with bills for debugging
        const overuseProperties = results.filter(prop => prop.overuse_amount > 0);
        const propertiesWithBills = results.filter(prop => 
            (prop.electricity_bills > 0 || prop.water_bills > 0) && prop.overuse_amount === 0
        );
        
        console.log(`🔍 End-to-end debug: ${overuseProperties.length} with overuse, ${propertiesWithBills.length} with bills but no overuse`);
        
        if (overuseProperties.length === 0 && propertiesWithBills.length === 0) {
            return res.json({ success: true, message: 'No properties with overuse or bills found', count: 0, items: [] });
        }
        
        // Use properties with overuse, or fall back to properties with bills for debugging
        const propertiesToProcess = overuseProperties.length > 0 ? overuseProperties : propertiesWithBills;

        sendEvent({ type: 'log', level: 'info', message: `🚀 End-to-end run for ${propertiesToProcess.length} properties` });

        // Modules
        const { downloadPdfsForPropertyWithContext, loginToPolaroo } = require('./test_modules/pdf_downloader');
        const { uploadPdfAndMetadata } = require('./test_modules/aws_uploader');
        const { HouseMonkAuth, HouseMonkIDResolver } = require('./test_modules/housemonk_auth');
        const { createInvoiceForOveruse } = require('./test_modules/invoice_creator');

        // Auth for HouseMonk
        const hmAuth = new HouseMonkAuth();
        await hmAuth.refreshMasterToken();
        await hmAuth.getUserAccessToken(hmAuth.config.userId);
        const resolver = new HouseMonkIDResolver(hmAuth);

        // Shared browser for downloads
        let browser, context;
        try {
            const session = await createBrowserSession();
            browser = session.browser;
            context = session.context;
            sendEvent({ type: 'log', level: 'success', message: '✅ Browser ready for downloads' });
        } catch (e) {
            sendEvent({ type: 'log', level: 'error', message: `❌ Browser startup failed: ${e.message}` });
            return res.status(500).json({ success: false, message: e.message });
        }

        // Login once
        let loginPage = await context.newPage();
        try {
            await performPolarooLogin(loginPage, process.env.POLAROO_EMAIL, process.env.POLAROO_PASSWORD);
            sendEvent({ type: 'log', level: 'success', message: '✅ Logged into Polaroo' });
        } catch (e) {
            await loginPage.close().catch(()=>{});
            await cleanupBrowserSession(browser, context);
            return res.status(500).json({ success: false, message: `Polaroo login failed: ${e.message}` });
        }
        await loginPage.close().catch(()=>{});

        const items = [];

        try {
            for (let i = 0; i < propertiesToProcess.length; i++) {
                const prop = propertiesToProcess[i];
                const label = `${prop.property} (${i+1}/${propertiesToProcess.length})`;
                sendEvent({ type: 'log', level: 'info', message: `🏠 ${label}` });

                try {
                    // 1) Download PDFs
                    const pdfs = await downloadPdfsForPropertyWithContext(
                        prop.property,
                        prop.selected_bills || [],
                        context,
                        process.env.POLAROO_EMAIL,
                        process.env.POLAROO_PASSWORD
                    );

                    if (!pdfs || pdfs.length === 0) {
                        sendEvent({ type: 'log', level: 'warning', message: `⚠️ No PDFs downloaded for ${prop.property}` });
                        throw new Error('No PDFs downloaded');
                    }

                    // 2) Upload PDFs to HouseMonk S3 via presign; collect full Document objects
                    const pdfDocuments = [];
                    for (const pdf of pdfs) {
                        const { pdfDocument } = await uploadPdfAndMetadata(hmAuth, pdf.buffer, pdf.fileName, prop);
                        if (pdfDocument) pdfDocuments.push(pdfDocument);
                    }
                    if (pdfDocuments.length === 0) throw new Error('Upload returned no documents');

                    // 3) Create invoice in HouseMonk attaching only PDFs (skip JSON files in files array)
                    const invoice = await createInvoiceForOveruse(hmAuth, resolver, prop, pdfDocuments, []);
                    items.push({
                        property: prop.property,
                        status: 'success',
                        invoiceId: invoice._id,
                        invoiceUrl: `${hmAuth.config.baseUrl}/dashboard/transactions/${invoice._id}`,
                        pdfCount: pdfDocuments.length,
                        overuseAmount: prop.overuse_amount
                    });
                    sendEvent({ type: 'log', level: 'success', message: `✅ Created invoice ${invoice._id} for ${prop.property}` });

                } catch (e) {
                    items.push({ property: prop.property, status: 'failed', error: e.message });
                    sendEvent({ type: 'log', level: 'error', message: `❌ ${prop.property}: ${e.message}` });
                }

                const progress = Math.round(((i + 1) / propertiesToProcess.length) * 100);
                sendEvent({ type: 'progress', percentage: progress });
            }
        } finally {
            await cleanupBrowserSession(browser, context);
        }

        const successCount = items.filter(x => x.status === 'success').length;
        const failedCount = items.length - successCount;
        return res.json({ success: true, message: 'End-to-end completed', successCount, failedCount, items });

    } catch (error) {
        console.error('❌ End-to-end failed:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});


app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Visit: http://localhost:${PORT}`);
});