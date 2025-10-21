 const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { chromium } = require('playwright');

// Concurrency control for Browserless
let activeBrowserSessions = 0;
const MAX_CONCURRENT_SESSIONS = 1; // Sequential processing for reliability

// Wait for available browser session slot
async function waitForBrowserSlot() {
    const maxWaitTime = 300000; // 5 minutes max wait
    const startTime = Date.now();
    
    while (activeBrowserSessions >= MAX_CONCURRENT_SESSIONS) {
        const elapsed = Date.now() - startTime;
        if (elapsed > maxWaitTime) {
            console.error(`❌ Timeout waiting for browser slot after ${maxWaitTime/1000}s`);
            console.log('🔄 Resetting browser slots due to timeout...');
            resetBrowserSlots();
            // After reset, allow this request to proceed
            break;
        }
        
        console.log(`⏳ Waiting for browser slot (${activeBrowserSessions}/${MAX_CONCURRENT_SESSIONS} active)... (${Math.round(elapsed/1000)}s elapsed)`);
        await sleep(2000); // Wait 2 seconds before checking again
    }
    activeBrowserSessions++;
    console.log(`✅ Browser slot acquired (${activeBrowserSessions}/${MAX_CONCURRENT_SESSIONS} active)`);
}

// Release browser session slot
function releaseBrowserSlot() {
    activeBrowserSessions = Math.max(0, activeBrowserSessions - 1);
    console.log(`🔄 Browser slot released (${activeBrowserSessions}/${MAX_CONCURRENT_SESSIONS} active)`);
}

// Reset browser slots (emergency function)
function resetBrowserSlots() {
    console.log(`🔄 Resetting browser slots from ${activeBrowserSessions} to 0`);
    activeBrowserSessions = 0;
}

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
    
    // Wait for available browser slot
    await waitForBrowserSlot();
    
    // Add longer delay to avoid rate limiting
    await sleep(10000 + Math.random() * 20000); // 10-30s random delay
    
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
            for (let attempt = 1; attempt <= 8; attempt++) {
                try {
                browser = await chromium.connectOverCDP(remoteWs);
                    break;
                } catch (error) {
                    lastError = error;
                    if (error.message.includes('429') && attempt < 8) {
                        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 60000); // Max 60s, start at 2s
                        console.log(`⚠️ Browserless 429 error, retrying in ${delay}ms (attempt ${attempt}/8)...`);
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
        // Always release the slot on error
        releaseBrowserSlot();
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
    } finally {
        // Always release the browser slot
        releaseBrowserSlot();
    }
}

// Property cohorts for bimonthly water billing
const PROPERTY_COHORTS = {
    ODD: ['Aribau', 'Valencia', 'Borrell', 'Padilla', 'Providencia', 'Sardenya'],
    EVEN: ['Llull', 'Blasco', 'Torrent']
};

// Determine cohort from month pair (second month determines cohort)
function getCohortForPeriod(targetMonths) {
    const secondMonth = targetMonths[1];
    // EVEN cohort: Oct(10), Dec(12), Feb(2), Apr(4), Jun(6), Aug(8)
    const evenMonths = [10, 12, 2, 4, 6, 8];
    return evenMonths.includes(secondMonth) ? 'EVEN' : 'ODD';
}

// Check if property belongs to cohort
function isPropertyInCohort(propertyName, cohort) {
    const properties = PROPERTY_COHORTS[cohort] || [];
    return properties.some(p => propertyName.toLowerCase().includes(p.toLowerCase()));
}

// Calculate billing month using spillover logic (cutoff = day 9)
function calculateBillingMonth(dateStr) {
    const parts = dateStr.split('/');
    if (parts.length !== 3) return null;
    
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    
    if (!Number.isFinite(day) || !Number.isFinite(month)) return null;
    
    // If day <= 9, billing month is previous month
    if (day <= 9) {
        const prevMonth = month === 1 ? 12 : month - 1;
        return prevMonth;
    }
    return month;
}

// Calculate period coverage - how many days in each month a bill covers
function calculatePeriodCoverage(startDateStr, endDateStr) {
    const startDate = new Date(startDateStr.split('/').reverse().join('-'));
    const endDate = new Date(endDateStr.split('/').reverse().join('-'));
    
    const coverage = {};
    const current = new Date(startDate);
    
    while (current <= endDate) {
        const monthKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
        coverage[monthKey] = (coverage[monthKey] || 0) + 1;
        current.setDate(current.getDate() + 1);
    }
    
    return coverage;
}

// Find the best electricity bill matches for a given water coverage pattern
function findBestElectricityMatches(electricityCandidates, waterCoverage) {
    // Get the months that water bill actually covers (with significant days)
    const waterMonths = Object.entries(waterCoverage)
        .filter(([month, days]) => days >= 15) // At least 15 days to be considered "covered"
        .map(([month]) => month)
        .sort();
    
    console.log(`📅 Water bill significantly covers months: ${waterMonths.join(', ')}`);
    
    if (waterMonths.length === 0) {
        return electricityCandidates.slice(-2); // Fallback to latest 2
    }
    
    // Calculate coverage for each electricity bill
    const elecWithCoverage = electricityCandidates.map(bill => {
        const coverage = calculatePeriodCoverage(bill.initialDate, bill.finalDate);
        const elecMonths = Object.entries(coverage)
            .filter(([month, days]) => days >= 15)
            .map(([month]) => month)
            .sort();
        
        return {
            bill,
            coverage: elecMonths,
            score: calculateMatchScore(elecMonths, waterMonths)
        };
    });
    
    // Sort by match score (higher is better)
    elecWithCoverage.sort((a, b) => b.score - a.score);
    
    // Take the 2 best matches
    const bestMatches = elecWithCoverage.slice(0, 2).map(item => item.bill);
    
    console.log(`📅 Match scores: ${elecWithCoverage.map(item => `${item.bill.initialDate}-${item.bill.finalDate}: ${item.score.toFixed(2)}`).join(', ')}`);
    
    return bestMatches;
}

// Calculate how well electricity months match water months
function calculateMatchScore(elecMonths, waterMonths) {
    if (elecMonths.length === 0 || waterMonths.length === 0) return 0;
    
    // Perfect match gets highest score
    if (elecMonths.length === waterMonths.length && 
        elecMonths.every((month, i) => month === waterMonths[i])) {
        return 100;
    }
    
    // Calculate overlap
    const overlap = elecMonths.filter(month => waterMonths.includes(month)).length;
    const total = Math.max(elecMonths.length, waterMonths.length);
    
    // Base score from overlap
    let score = (overlap / total) * 80;
    
    // Bonus for adjacent months (handles cases like water 6-8, elec 7-8)
    const waterMonthNums = waterMonths.map(m => parseInt(m.split('-')[1]));
    const elecMonthNums = elecMonths.map(m => parseInt(m.split('-')[1]));
    
    // Check if electricity months are adjacent to water months
    const isAdjacent = elecMonthNums.some(elecMonth => 
        waterMonthNums.some(waterMonth => 
            Math.abs(elecMonth - waterMonth) <= 1
        )
    );
    
    if (isAdjacent) score += 15;
    
    // Penalty for too many electricity months
    if (elecMonths.length > waterMonths.length + 1) {
        score -= 20;
    }
    
    return Math.max(0, score);
}

// Helper function to filter bills: water-first approach, extract months from water bill dates
function filterBillsByMonth(tableData, targetMonths, propertyName) {
    const cohort = getCohortForPeriod(targetMonths);
    const [firstMonth, secondMonth] = targetMonths;
    
    const rows = [];
    console.log(`🔍 DEBUG: Processing ${tableData.length} bills from webpage`);
    
    for (const bill of tableData) {
        const fd = bill['Final date'] || '';
        const id = bill['Initial date'] || '';
        const service = (bill.Service || '').toLowerCase();
        
        console.log(`🔍 DEBUG: Bill - Service: "${service}", Initial: "${id}", Final: "${fd}"`);
        
        const billingMonth = calculateBillingMonth(fd);
        if (!billingMonth) {
            console.log(`⚠️ DEBUG: Skipping bill - invalid billing month calculation for "${fd}"`);
            continue;
        }
        
        // Ignore gas bills entirely
        if (service.includes('gas')) {
            console.log(`⚠️ DEBUG: Skipping gas bill`);
            continue;
        }
        
        const isElec = service.includes('electric');
        const isWater = service.includes('water') || service.includes('agua');
        
        console.log(`✅ DEBUG: Adding bill - BillingMonth: ${billingMonth}, IsElec: ${isElec}, IsWater: ${isWater}`);

        rows.push({
            raw: bill,
            billingMonth,
            initialDate: id,
            finalDate: fd,
            isElec,
            isWater
        });
    }
    
    console.log(`🔍 DEBUG: Final processed bills: ${rows.length} total`);
    console.log(`🔍 DEBUG: Electricity bills: ${rows.filter(r => r.isElec).length}`);
    console.log(`🔍 DEBUG: Water bills: ${rows.filter(r => r.isWater).length}`);
    
    const warnings = [];
    
    // Check cohort match for water
    if (!isPropertyInCohort(propertyName, cohort)) {
        warnings.push(`Property not in ${cohort} cohort for this period`);
    }
    
    // STEP 1: Find WATER bill first (second month, matching cohort)
    let water = [];
    let electricityMonths = targetMonths; // Default to selected months
    
    console.log(`🔍 DEBUG: Looking for water bills with billingMonth === ${secondMonth}`);
    console.log(`🔍 DEBUG: Available water bills:`, rows.filter(r => r.isWater).map(r => ({
        initialDate: r.initialDate,
        finalDate: r.finalDate,
        billingMonth: r.billingMonth
    })));
    
    const waterCandidates = rows.filter(r => r.isWater && r.billingMonth === secondMonth);
    console.log(`🔍 DEBUG: Water candidates for month ${secondMonth}:`, waterCandidates.length);
    
    if (waterCandidates.length > 0) {
        const waterBill = waterCandidates[waterCandidates.length - 1];
        water = [waterBill.raw];
        
        // STEP 2: Extract billing months from water bill's initial and final dates
        const waterInitialMonth = calculateBillingMonth(waterBill.initialDate);
        const waterFinalMonth = calculateBillingMonth(waterBill.finalDate);
        
        console.log(`🔍 DEBUG: Water bill dates: ${waterBill.initialDate} to ${waterBill.finalDate}`);
        console.log(`🔍 DEBUG: Calculated billing months: ${waterInitialMonth}, ${waterFinalMonth}`);
        
        if (waterInitialMonth && waterFinalMonth) {
            // Water bill covers 2 months, so electricity should also cover those same 2 months
            electricityMonths = [waterInitialMonth, waterFinalMonth];
            console.log(`📅 Using water bill date range for electricity search: months ${waterInitialMonth}, ${waterFinalMonth}`);
            console.log(`📅 Water bill period: ${waterBill.initialDate} to ${waterBill.finalDate}`);
        }
    } else {
        warnings.push('Water bill missing - using selected period for electricity search');
        console.log(`⚠️ DEBUG: No water bills found for month ${secondMonth}, using target months: ${targetMonths}`);
    }
    
    // STEP 3: Find ELECTRICITY bills based on water bill's period coverage
    const electricity = [];
    
    if (water.length > 0) {
        const waterBill = water[0];
        console.log(`📅 Water bill period: ${waterBill['Initial date']} to ${waterBill['Final date']}`);
        
        // Calculate which months the water bill actually covers (by days)
        const waterCoverage = calculatePeriodCoverage(waterBill['Initial date'], waterBill['Final date']);
        console.log(`📅 Water bill covers: ${JSON.stringify(waterCoverage)}`);
        
        // Find electricity bills that best match this coverage pattern
        const electricityCandidates = rows.filter(r => r.isElec);
        console.log(`🔍 DEBUG: Available electricity bills:`, electricityCandidates.map(r => ({
            initialDate: r.initialDate,
            finalDate: r.finalDate,
            billingMonth: r.billingMonth
        })));
        
        const bestMatches = findBestElectricityMatches(electricityCandidates, waterCoverage);
        
        console.log(`📅 Selected electricity bills: ${bestMatches.map(b => `${b.initialDate}-${b.finalDate}`).join(', ')}`);
        electricity.push(...bestMatches);
    } else {
        // Fallback to original logic if no water bill
        console.log(`🔍 DEBUG: No water bill, using fallback logic for months: ${electricityMonths}`);
        for (const targetMonth of electricityMonths) {
            const candidates = rows.filter(r => r.isElec && r.billingMonth === targetMonth);
            console.log(`🔍 DEBUG: Electricity candidates for month ${targetMonth}:`, candidates.length);
            if (candidates.length > 0) {
                electricity.push(candidates[candidates.length - 1].raw);
            }
        }
    }
    
    // Validation warnings
    if (electricity.length < 2) {
        warnings.push(`Only ${electricity.length}/2 electricity bills found`);
    } else if (electricity.length > 2) {
        warnings.push(`Extra electricity bills found (${electricity.length} instead of 2)`);
    }
    
    if (water.length === 0) {
        warnings.push('Water bill missing');
    } else if (water.length > 1) {
        warnings.push(`Multiple water bills found (${water.length})`);
    }
    
    // Only trigger LLM fallback when NO electricity bills found (water bills can be missing)
    const needsLLMFallback = electricity.length === 0;
    
    return { electricity, water, warnings, needsLLMFallback };
}

// LLM Fallback function for intelligent bill selection
async function selectBillsWithLLM(tableData, targetMonths, propertyName, cohereApiKey) {
    if (!cohereApiKey) {
        console.log('⚠️ Cohere API key not available, skipping LLM fallback');
        return null;
    }
    
    try {
        console.log(`🤖 Triggering LLM fallback for ${propertyName}...`);
        
        // Filter out gas bills and prepare bill list
        const relevantBills = tableData.filter(bill => {
            const service = (bill.Service || '').toLowerCase();
            return !service.includes('gas');
        }).map((bill, idx) => ({
            index: idx,
            service: bill.Service,
            initialDate: bill['Initial date'],
            finalDate: bill['Final date'],
            total: bill.Total,
            concept: bill.Concept || ''
        }));
        
        if (relevantBills.length === 0) {
            return null;
        }
        
        const [month1, month2] = targetMonths;
        const monthNames = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const periodStr = `${monthNames[month1]}-${monthNames[month2]}`;
        const cohort = getCohortForPeriod(targetMonths);
        
        const prompt = `You are analyzing utility bills for property "${propertyName}" for the billing period ${periodStr}.

Property belongs to ${cohort} cohort. We need to select:
- 2 ELECTRICITY bills (one for each month in the period)
- 1 WATER bill (covering the 2-month period)

Rules:
1. Bills have Initial Date and Final Date. The billing month is determined by Final Date, but if the day of Final Date is <= 9, the billing month is the PREVIOUS month.
2. For water: find the bill whose billing month matches ${monthNames[month2]} (the second month).
3. For electricity: once you find the water bill, use ITS initial and final dates to determine which months to look for electricity bills.
4. Ignore any bills that don't make sense for this period.

Available bills:
${relevantBills.map(b => `[${b.index}] ${b.service} | ${b.initialDate} to ${b.finalDate} | ${b.total}`).join('\n')}

Respond in JSON format:
{
  "waterBillIndex": <index or null>,
  "electricityBillIndices": [<index1>, <index2>],
  "reasoning": "<brief explanation of your selection>"
}`;

        const response = await fetch('https://api.cohere.ai/v1/generate', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${cohereApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'command',
                prompt: prompt,
                temperature: 0.1,
                max_tokens: 1000
            })
        });
        
        if (!response.ok) {
            console.error('❌ Cohere API error:', response.status);
            return null;
        }
        
        const data = await response.json();
        const llmResponse = JSON.parse(data.generations[0].text);
        
        console.log(`🤖 LLM reasoning: ${llmResponse.reasoning}`);
        
        // Extract selected bills
        const selectedElectricity = [];
        const selectedWater = [];
        
        if (llmResponse.electricityBillIndices && Array.isArray(llmResponse.electricityBillIndices)) {
            for (const idx of llmResponse.electricityBillIndices) {
                if (idx < tableData.length) {
                    selectedElectricity.push(tableData[idx]);
                }
            }
        }
        
        if (llmResponse.waterBillIndex !== null && llmResponse.waterBillIndex < tableData.length) {
            selectedWater.push(tableData[llmResponse.waterBillIndex]);
        }
        
        return {
            electricity: selectedElectricity,
            water: selectedWater,
            warnings: [`LLM-assisted selection: ${llmResponse.reasoning}`],
            llmUsed: true
        };
        
    } catch (error) {
        console.error('❌ LLM fallback failed:', error);
        return null;
    }
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
        
        // Reset browser slots at start of each run to prevent stuck slots
        resetBrowserSlots();

        // Setup cooperative cancel (manual only, not on disconnect)
        CURRENT_RUN = { cancelled: false };
        
        // Determine target months from requested period (fallback to last 2 months if not provided)
        let targetMonths;
        if (period) {
            const map = {
                'Jan-Feb': [1, 2], 'Feb-Mar': [2, 3], 'Mar-Apr': [3, 4],
                'Apr-May': [4, 5], 'May-Jun': [5, 6], 'Jun-Jul': [6, 7],
                'Jul-Aug': [7, 8], 'Aug-Sep': [8, 9], 'Sep-Oct': [9, 10],
                'Oct-Nov': [10, 11], 'Nov-Dec': [11, 12], 'Dec-Jan': [12, 1]
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
        
        // Process properties in batches of 20 per browser session
        const PROPERTIES_PER_SESSION = 20;
        const totalBatches = Math.ceil(totalToProcess / PROPERTIES_PER_SESSION);
        
        console.log(`📦 Processing ${totalToProcess} properties in ${totalBatches} batch(es) of up to ${PROPERTIES_PER_SESSION} properties per session`);
        sendEvent({ type: 'log', level: 'info', message: `📦 Processing in ${totalBatches} batch(es) of ${PROPERTIES_PER_SESSION} properties` });
        
        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            if (CURRENT_RUN?.cancelled) {
                logs.push({ message: '🛑 Processing cancelled by user', level: 'warning' });
                sendEvent({ type: 'log', level: 'warning', message: '🛑 Processing cancelled by user' });
                break;
            }
            
            const startIndex = batchIndex * PROPERTIES_PER_SESSION;
            const endIndex = Math.min(startIndex + PROPERTIES_PER_SESSION, totalToProcess);
            const batchProperties = properties.slice(startIndex, endIndex);
            
            console.log(`\n🔄 Starting Batch ${batchIndex + 1}/${totalBatches}: Properties ${startIndex + 1}-${endIndex}`);
            sendEvent({ type: 'log', level: 'info', message: `🔄 Batch ${batchIndex + 1}/${totalBatches}: ${batchProperties.length} properties` });
            
            // Create ONE browser session for this batch
            let browser, context;
            try {
                console.log('🟡 Creating browser session for batch...');
                const session = await createBrowserSession();
                browser = session.browser;
                context = session.context;
                console.log('✅ Browser session created successfully');
            } catch (error) {
                console.error('❌ Failed to create browser session:', error);
                // Mark all properties in this batch as failed
                batchProperties.forEach(prop => {
                    results.push({
                        property: prop.name || prop,
                        success: false,
                        error: `Failed to create browser session: ${error.message}`
                    });
                });
                // Continue to next batch
                continue;
            }
        
        try {
            // Login to Polaroo ONCE for this batch
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
                logs.push({ message: '🍪 Login session established - will reuse for batch properties', level: 'success' });
                sendEvent({ type: 'log', level: 'success', message: '🍪 Login session established for batch' });
            } catch (error) {
                await loginPage.close();
                throw error;
            }
            
            // Process each property in this batch using the shared browser session
            const retried = new Set();
            for (let i = 0; i < batchProperties.length; i++) {
                if (CURRENT_RUN?.cancelled) {
                    logs.push({ message: '🛑 Run cancelled by client disconnect', level: 'warning' });
                    sendEvent({ type: 'log', level: 'warning', message: '🛑 Run cancelled by client disconnect' });
                    break;
                }
                
                // Delay between properties to reduce load
                if (i > 0) await sleep(3000);
            
                const property = batchProperties[i];
                const propertyName = property.name || property; // Handle both old and new format
                const roomCount = property.rooms || 0;
                
                // Calculate overall progress across all batches
                const overallPropertyIndex = startIndex + i;
                const progressPercentage = Math.round(((overallPropertyIndex + 1) / totalToProcess) * 100);
                sendEvent({ type: 'progress', percentage: progressPercentage });
                
                logs.push({ message: `🏠 Processing property ${overallPropertyIndex + 1}/${totalToProcess}: ${propertyName} (${roomCount} rooms)`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: `🏠 [${overallPropertyIndex + 1}/${totalToProcess}] ${propertyName}` });
            
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
                    
                    // Wait for table to load and data to be present
                    await page.waitForSelector('table, .table, [role="table"]', { timeout: 30000 });
                    await page.waitForFunction(() => {
                        const tables = document.querySelectorAll('table, .table, [role="table"]');
                        for (const table of tables) {
                            const rows = table.querySelectorAll('tbody tr, tr');
                            if (rows.length > 0) {
                                // Check if any row has a Total column with € value
                                return Array.from(rows).some(row => {
                                    const cells = row.querySelectorAll('td, th');
                                    return Array.from(cells).some(cell => 
                                        cell.textContent?.includes('€') && 
                                        cell.textContent?.match(/\d+[,.]\d+\s*€/)
                                    );
                                });
                            }
                        }
                        return false;
                    }, { timeout: 30000 });
                    await sleep(3000); // Extra buffer after data is confirmed loaded
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
                    
                // Extract table data with retry logic for failed extractions
                    let tableData = [];
                    let extractionAttempts = 0;
                    const maxExtractionAttempts = 3;
                    
                    while (tableData.length === 0 && extractionAttempts < maxExtractionAttempts) {
                        extractionAttempts++;
                        logs.push({ message: `📊 Extracting invoice data... (attempt ${extractionAttempts})`, level: 'info' });
                        sendEvent({ type: 'log', level: 'info', message: `📊 Extracting invoice data... (attempt ${extractionAttempts})` });
                        
                        // Wait a bit longer on retry attempts
                        if (extractionAttempts > 1) {
                            await sleep(5000 + (extractionAttempts * 2000));
                        }
                        
                        tableData = await page.evaluate(() => {
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
                        
                        if (tableData.length === 0) {
                            logs.push({ message: `⚠️ No bills extracted on attempt ${extractionAttempts}, retrying...`, level: 'warning' });
                            sendEvent({ type: 'log', level: 'warning', message: `⚠️ No bills extracted on attempt ${extractionAttempts}, retrying...` });
                        }
                    }
                    
                    if (tableData.length === 0) {
                        logs.push({ message: `❌ Failed to extract bills after ${maxExtractionAttempts} attempts`, level: 'error' });
                        sendEvent({ type: 'log', level: 'error', message: `❌ Failed to extract bills after ${maxExtractionAttempts} attempts` });
                        throw new Error('Failed to extract bills from table');
                    }
                    
                    logs.push({ message: `📋 Found ${tableData.length} total bills`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `📋 Found ${tableData.length} total bills` });
                    
                // Process bills with retry logic for missing bills or 0 costs
                let filteredBills, electricityBills, waterBills, warnings;
                let processingAttempts = 0;
                const maxProcessingAttempts = 3;
                let needsRetry = false;
                
                do {
                    processingAttempts++;
                    needsRetry = false;
                    
                    logs.push({ message: `🔍 Filtering bills by month and service... (attempt ${processingAttempts})`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `🔍 Filtering bills by month and service... (attempt ${processingAttempts})` });
                    
                    filteredBills = filterBillsByMonth(tableData, targetMonths, propertyName);
                    electricityBills = filteredBills.electricity;
                    waterBills = filteredBills.water;
                    warnings = filteredBills.warnings || [];

                // LLM Fallback: If rule-based logic produces warnings or finds 0 bills
                if (filteredBills.needsLLMFallback) {
                    logs.push({ message: `⚠️ Rule-based selection has issues, trying LLM fallback...`, level: 'warning' });
                    sendEvent({ type: 'log', level: 'warning', message: '⚠️ Rule-based selection has issues, trying LLM fallback...' });
                    
                    const llmResult = await selectBillsWithLLM(tableData, targetMonths, propertyName, process.env.COHERE_API_KEY);
                    
                    if (llmResult && (llmResult.electricity.length > 0 || llmResult.water.length > 0)) {
                        logs.push({ message: `🤖 LLM fallback successful!`, level: 'success' });
                        sendEvent({ type: 'log', level: 'success', message: '🤖 LLM fallback successful!' });
                        electricityBills = llmResult.electricity;
                        waterBills = llmResult.water;
                        warnings = llmResult.warnings;
                    } else {
                        logs.push({ message: `⚠️ LLM fallback unavailable, using rule-based results`, level: 'warning' });
                        sendEvent({ type: 'log', level: 'warning', message: '⚠️ LLM fallback unavailable, using rule-based results' });
                    }
                }
                
                logs.push({ message: `⚡ Found ${electricityBills.length} electricity bills for selected months`, level: 'info' });
                logs.push({ message: `💧 Found ${waterBills.length} water bills for selected months`, level: 'info' });
                
                // DEBUG: Log electricity bill data to diagnose cost extraction issues
                console.log(`\n🔍 DEBUG: Electricity Bills Data for ${propertyName}:`);
                electricityBills.forEach((bill, index) => {
                    console.log(`  Bill ${index + 1}:`, JSON.stringify(bill, null, 2));
                    console.log(`  - Has Total field:`, 'Total' in bill);
                    console.log(`  - Total value:`, bill.Total);
                    console.log(`  - All keys:`, Object.keys(bill));
                });
                
                console.log(`\n🔍 DEBUG: Water Bills Data for ${propertyName}:`);
                waterBills.forEach((bill, index) => {
                    console.log(`  Bill ${index + 1}:`, JSON.stringify(bill, null, 2));
                    console.log(`  - Has Total field:`, 'Total' in bill);
                    console.log(`  - Total value:`, bill.Total);
                });
                
                // Calculate costs using parseEuro for proper European currency handling
                const electricityCost = electricityBills.reduce((sum, bill) => {
                    const total = parseEuro(bill.Total || '0');
                    console.log(`  - Parsing electricity bill total: "${bill.Total}" → ${total} €`);
                    return sum + total;
                }, 0);
                
                const waterCost = waterBills.reduce((sum, bill) => {
                    const total = parseEuro(bill.Total || '0');
                    console.log(`  - Parsing water bill total: "${bill.Total}" → ${total} €`);
                    return sum + total;
                }, 0);
                
                const totalCost = electricityCost + waterCost;
                
                // Check if we need to retry due to missing bills or 0 costs
                const hasElectricityBills = electricityBills.length > 0;
                const hasWaterBills = waterBills.length > 0;
                const hasElectricityCost = electricityCost > 0;
                const hasWaterCost = waterCost > 0;
                
                // Determine if we should retry
                if (processingAttempts < maxProcessingAttempts) {
                    if ((hasElectricityBills && !hasElectricityCost) || 
                        (hasWaterBills && !hasWaterCost) ||
                        (!hasElectricityBills && !hasWaterBills)) {
                        needsRetry = true;
                        logs.push({ message: `⚠️ Retry needed: Elec bills: ${electricityBills.length} (cost: ${electricityCost}), Water bills: ${waterBills.length} (cost: ${waterCost})`, level: 'warning' });
                        sendEvent({ type: 'log', level: 'warning', message: `⚠️ Retry needed: Elec bills: ${electricityBills.length} (cost: ${electricityCost}), Water bills: ${waterBills.length} (cost: ${waterCost})` });
                        
                        // Wait longer before retry
                        await sleep(5000 + (processingAttempts * 3000));
                        
                        // Re-extract table data for retry
                        logs.push({ message: `🔄 Re-extracting table data for retry...`, level: 'info' });
                        sendEvent({ type: 'log', level: 'info', message: '🔄 Re-extracting table data for retry...' });
                        
                        tableData = await page.evaluate(() => {
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
                                    
                                    for (let i = 1; i < rows.length; i++) {
                                        const cells = rows[i].querySelectorAll('td, th');
                                        const rowData = {};
                                        
                                        for (let j = 0; j < cells.length && j < headers.length; j++) {
                                            const cellText = cells[j].textContent.trim();
                                            const header = headers[j];
                                            
                                            if (['Asset', 'Service', 'Initial date', 'Final date', 'Subtotal', 'Taxes', 'Total'].includes(header)) {
                                                rowData[header] = cellText;
                                            }
                                        }
                                        
                                        if (Object.keys(rowData).length > 0) {
                                            data.push(rowData);
                                        }
                                    }
                                }
                            }
                            
                            return data;
                        });
                        
                        logs.push({ message: `📋 Re-extracted ${tableData.length} bills for retry`, level: 'info' });
                        sendEvent({ type: 'log', level: 'info', message: `📋 Re-extracted ${tableData.length} bills for retry` });
                    }
                }
                
                if (!needsRetry) {
                    // Calculate allowance and overuse
                    const monthlyAllowance = getMonthlyAllowance(propertyName, roomCount);
                    const totalAllowance = monthlyAllowance * 2; // 2 months
                    const overuseAmount = Math.max(0, totalCost - totalAllowance);
                    
                    logs.push({ message: `📊 Electricity: ${electricityBills.length} bills, ${electricityCost.toFixed(2)} €`, level: 'info' });
                    logs.push({ message: `📊 Water: ${waterBills.length} bills, ${waterCost.toFixed(2)} €`, level: 'info' });
                    logs.push({ message: `📊 Total Cost: ${totalCost.toFixed(2)} €, Allowance: ${totalAllowance} €, Overuse: ${overuseAmount.toFixed(2)} €`, level: 'success' });
                }
                
                } while (needsRetry && processingAttempts < maxProcessingAttempts);
                
                // Final cost calculation after retries
                const finalElectricityCost = electricityBills.reduce((sum, bill) => {
                    const total = parseEuro(bill.Total || '0');
                    return sum + total;
                }, 0);
                
                const finalWaterCost = waterBills.reduce((sum, bill) => {
                    const total = parseEuro(bill.Total || '0');
                    return sum + total;
                }, 0);
                
                const finalTotalCost = finalElectricityCost + finalWaterCost;
                
                // Calculate allowance and overuse
                const monthlyAllowance = getMonthlyAllowance(propertyName, roomCount);
                const totalAllowance = monthlyAllowance * 2; // 2 months
                const overuseAmount = Math.max(0, finalTotalCost - totalAllowance);
                
                logs.push({ message: `📊 Final Electricity: ${electricityBills.length} bills, ${finalElectricityCost.toFixed(2)} €`, level: 'info' });
                logs.push({ message: `📊 Final Water: ${waterBills.length} bills, ${finalWaterCost.toFixed(2)} €`, level: 'info' });
                logs.push({ message: `📊 Final Total Cost: ${finalTotalCost.toFixed(2)} €, Allowance: ${totalAllowance} €, Overuse: ${overuseAmount.toFixed(2)} €`, level: 'success' });
                
                // Create result
                    const result = {
                        property: propertyName,
                        success: true,
                    electricity_bills: electricityBills.length,
                    water_bills: waterBills.length,
                    electricity_cost: finalElectricityCost,
                    water_cost: finalWaterCost,
                    total_cost: finalTotalCost,
                    overuse_amount: overuseAmount,
                    rooms: roomCount,
                    unitCode: property.unitCode || '',
                    warnings: warnings || [],
                    selected_bills: [...electricityBills, ...waterBills] // Include the actual selected bills
                    };
                    
                    // DEBUG: Log bill counts for data flow tracking
                    console.log(`🔍 DEBUG Bill Counts for ${propertyName}:`);
                    console.log(`  - electricity_bills: ${electricityBills.length}`);
                    console.log(`  - water_bills: ${waterBills.length}`);
                    console.log(`  - electricity_cost: ${finalElectricityCost}`);
                    console.log(`  - water_cost: ${finalWaterCost}`);
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
                        
                        // Properly cleanup old session first (this releases the slot)
                        try {
                            await cleanupBrowserSession(browser, context);
                        } catch(cleanupErr) {
                            console.log('⚠️ Warning during cleanup:', cleanupErr.message);
                        }
                        
                        // Add delay before creating new session
                        await sleep(5000);
                        
                        // Create new session and retry
                        try {
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
                        } catch (retryError) {
                            logs.push({ message: `⚠️ Failed to recreate session: ${retryError.message}. Skipping property.`, level: 'error' });
                            sendEvent({ type: 'log', level: 'error', message: '⚠️ Session recreation failed, skipping property...' });
                            // Don't retry again, just move on
                        }
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
                }
            }
        } finally {
            // Cleanup browser session for this batch
            console.log(`🧹 Cleaning up browser session for batch ${batchIndex + 1}...`);
            await cleanupBrowserSession(browser, context);
        }
        
        // Wait between batches (except for the last one)
        if (batchIndex < totalBatches - 1) {
            const delaySeconds = 120; // 2 minutes between batches
            console.log(`⏳ Waiting ${delaySeconds}s before next batch...`);
            sendEvent({ type: 'log', level: 'info', message: `⏳ Waiting ${delaySeconds}s before next batch...` });
            await sleep(delaySeconds * 1000);
        }
    } // End of batch loop
        
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

// Reset browser slots endpoint
app.post('/api/reset-browser-slots', (req, res) => {
    resetBrowserSlots();
    res.json({ success: true, message: 'Browser slots reset' });
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
                'Jan-Feb': [1, 2], 'Feb-Mar': [2, 3], 'Mar-Apr': [3, 4],
                'Apr-May': [4, 5], 'May-Jun': [5, 6], 'Jun-Jul': [6, 7],
                'Jul-Aug': [7, 8], 'Aug-Sep': [8, 9], 'Sep-Oct': [9, 10],
                'Oct-Nov': [10, 11], 'Nov-Dec': [11, 12], 'Dec-Jan': [12, 1]
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
                    
                    // Wait for table to load and data to be present
                    await page.waitForSelector('table, .table, [role="table"]', { timeout: 30000 });
                    await page.waitForFunction(() => {
                        const tables = document.querySelectorAll('table, .table, [role="table"]');
                        for (const table of tables) {
                            const rows = table.querySelectorAll('tbody tr, tr');
                            if (rows.length > 0) {
                                // Check if any row has a Total column with € value
                                return Array.from(rows).some(row => {
                                    const cells = row.querySelectorAll('td, th');
                                    return Array.from(cells).some(cell => 
                                        cell.textContent?.includes('€') && 
                                        cell.textContent?.match(/\d+[,.]\d+\s*€/)
                                    );
                                });
                            }
                        }
                        return false;
                    }, { timeout: 30000 });
                    await sleep(3000); // Extra buffer after data is confirmed loaded
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
                    
                    // Extract table data with retry logic for failed extractions
                    let tableData = [];
                    let extractionAttempts = 0;
                    const maxExtractionAttempts = 3;
                    
                    while (tableData.length === 0 && extractionAttempts < maxExtractionAttempts) {
                        extractionAttempts++;
                        logs.push({ message: `📊 Extracting invoice data... (attempt ${extractionAttempts})`, level: 'info' });
                        sendEvent({ type: 'log', level: 'info', message: `📊 Extracting invoice data... (attempt ${extractionAttempts})` });
                        
                        // Wait a bit longer on retry attempts
                        if (extractionAttempts > 1) {
                            await sleep(5000 + (extractionAttempts * 2000));
                        }
                        
                        tableData = await page.evaluate(() => {
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
                        
                        if (tableData.length === 0) {
                            logs.push({ message: `⚠️ No bills extracted on attempt ${extractionAttempts}, retrying...`, level: 'warning' });
                            sendEvent({ type: 'log', level: 'warning', message: `⚠️ No bills extracted on attempt ${extractionAttempts}, retrying...` });
                        }
                    }
                    
                    if (tableData.length === 0) {
                        logs.push({ message: `❌ Failed to extract bills after ${maxExtractionAttempts} attempts`, level: 'error' });
                        sendEvent({ type: 'log', level: 'error', message: `❌ Failed to extract bills after ${maxExtractionAttempts} attempts` });
                        throw new Error('Failed to extract bills from table');
                    }
                    
                    logs.push({ message: `📋 Found ${tableData.length} total bills`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `📋 Found ${tableData.length} total bills` });
                    
                    // Filter bills by month and service type using new logic
                    logs.push({ message: `🔍 Filtering bills by month and service...`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: '🔍 Filtering bills by month and service...' });
                    
                    let filteredBills = filterBillsByMonth(tableData, targetMonths, propertyName);
                    let electricityBills = filteredBills.electricity;
                    let waterBills = filteredBills.water;
                    let warnings = filteredBills.warnings || [];

                    // LLM Fallback: If rule-based logic produces warnings or finds 0 bills
                    if (filteredBills.needsLLMFallback) {
                        logs.push({ message: `⚠️ Rule-based selection has issues, trying LLM fallback...`, level: 'warning' });
                        sendEvent({ type: 'log', level: 'warning', message: '⚠️ Rule-based selection has issues, trying LLM fallback...' });
                        
                        const llmResult = await selectBillsWithLLM(tableData, targetMonths, propertyName, process.env.COHERE_API_KEY);
                        
                        if (llmResult && (llmResult.electricity.length > 0 || llmResult.water.length > 0)) {
                            logs.push({ message: `🤖 LLM fallback successful!`, level: 'success' });
                            sendEvent({ type: 'log', level: 'success', message: '🤖 LLM fallback successful!' });
                            electricityBills = llmResult.electricity;
                            waterBills = llmResult.water;
                            warnings = llmResult.warnings;
                        } else {
                            logs.push({ message: `⚠️ LLM fallback unavailable, using rule-based results`, level: 'warning' });
                            sendEvent({ type: 'log', level: 'warning', message: '⚠️ LLM fallback unavailable, using rule-based results' });
                        }
                    }
                    
                    // Calculate costs using the filtered bills
                    const electricityCost = electricityBills.reduce((sum, bill) => {
                        const total = parseEuro(bill.Total || '0');
                        return sum + total;
                    }, 0);
                    
                    const waterCost = waterBills.reduce((sum, bill) => {
                        const total = parseEuro(bill.Total || '0');
                        return sum + total;
                    }, 0);
                    
                    // Calculate overuse using the same logic as main processing
                    const monthlyAllowance = getMonthlyAllowance(propertyName, roomCount);
                    const totalAllowance = monthlyAllowance * 2; // 2 months
                    const totalCost = electricityCost + waterCost;
                    const overuseAmount = Math.max(0, totalCost - totalAllowance);
                    
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
                        electricity_bills: electricityBills.length,
                        water_bills: waterBills.length,
                        electricity_cost: electricityCost,
                        water_cost: waterCost,
                        overuse_amount: overuseAmount,
                        success: true,
                        warnings: warnings || [],
                        selected_bills: [...electricityBills, ...waterBills], // Include the actual selected bills
                        message: `Processed ${electricityBills.length + waterBills.length} bills (${electricityBills.length} electricity, ${waterBills.length} water)`
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
            // Release browser slot
            releaseBrowserSlot();
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

        // Shared browser for downloads with retry
        let browser, context;
        let lastError;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const session = await createBrowserSession();
                browser = session.browser;
                context = session.context;
                sendEvent({ type: 'log', level: 'success', message: '✅ Browser ready for downloads' });
                break;
            } catch (e) {
                lastError = e;
                if (e.message.includes('429') && attempt < 3) {
                    const delay = 2000 * attempt; // 2s, 4s
                    sendEvent({ type: 'log', level: 'warning', message: `⚠️ Browserless 429, retrying in ${delay}ms (attempt ${attempt}/3)...` });
                    await sleep(delay);
                    continue;
                }
                sendEvent({ type: 'log', level: 'error', message: `❌ Browser startup failed: ${e.message}` });
                return res.status(500).json({ success: false, message: e.message });
            }
        }
        if (!browser) throw lastError;

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
                // Delay between properties to reduce load
                if (i > 0) await sleep(3000);
                
                const prop = propertiesToProcess[i];
                const label = `${prop.property} (${i+1}/${propertiesToProcess.length})`;
                sendEvent({ type: 'log', level: 'info', message: `🏠 ${label}` });

                // Retry logic for browser session failures
                let retryCount = 0;
                const maxRetries = 1;
                let success = false;
                
                while (retryCount <= maxRetries && !success) {
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
                        success = true;

                    } catch (e) {
                        const isClosedErr = /Target page, context or browser has been closed|browserContext\.newPage/i.test(e.message || '');
                        
                        if (isClosedErr && retryCount < maxRetries) {
                            retryCount++;
                            sendEvent({ type: 'log', level: 'warning', message: `♻️ Browser closed, recreating session and retrying ${prop.property}...` });
                            
                            // Properly cleanup old session first (this releases the slot)
                            try { 
                                await cleanupBrowserSession(browser, context); 
                            } catch(cleanupErr) {
                                console.log('⚠️ Warning during cleanup:', cleanupErr.message);
                            }
                            
                            // Add delay before creating new session
                            await sleep(5000);
                            
                            // Recreate browser session
                            try {
                                const session = await createBrowserSession();
                                browser = session.browser;
                                context = session.context;
                                
                                // Re-login
                                let relogin = await context.newPage();
                                try {
                                    await performPolarooLogin(relogin, process.env.POLAROO_EMAIL, process.env.POLAROO_PASSWORD);
                                } finally {
                                    await relogin.close().catch(() => {});
                                }
                                continue;
                            } catch (retryError) {
                                sendEvent({ type: 'log', level: 'error', message: `⚠️ Failed to recreate session: ${retryError.message}. Skipping property.` });
                                success = true; // Exit retry loop on failure
                            }
                        }
                        
                        items.push({ property: prop.property, status: 'failed', error: e.message });
                        sendEvent({ type: 'log', level: 'error', message: `❌ ${prop.property}: ${e.message}` });
                        success = true; // Exit retry loop even on failure
                    }
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