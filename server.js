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

// Cohere API integration
async function analyzeWithCohere(tableData, propertyName) {
    try {
        const cohereApiKey = process.env.COHERE_API_KEY;
        if (!cohereApiKey) {
            throw new Error('COHERE_API_KEY is required but not set');
        }

        const prompt = `
Analyze this invoice data for property "${propertyName}" and identify:

1. ELECTRICITY bills (look for: electric, electricity, power, luz, electricidad)
2. WATER bills (look for: water, agua, supply, abastecimiento)
3. For each bill, extract:
   - Service type (electricity/water)
   - Usage amount (kWh for electricity, m³ for water)
   - Allowance amount (if mentioned)
   - Bill period (start and end dates)
   - Total cost

Data to analyze:
${JSON.stringify(tableData, null, 2)}

Return ONLY a JSON object with this structure:
{
  "electricity_bills": [
    {
      "service": "Electricity Supply",
      "usage": 150,
      "allowance": 100,
      "start_date": "01/08/2024",
      "end_date": "31/08/2024",
      "total_cost": 45.67,
      "overuse": 50,
      "month": 8
    }
  ],
  "water_bills": [
    {
      "service": "Water Supply", 
      "usage": 25,
      "allowance": 20,
      "start_date": "01/08/2024",
      "end_date": "31/08/2024",
      "total_cost": 12.50,
      "overuse": 5,
      "month": 8
    }
  ]
}
\nIf no allowance is mentioned, assume standard allowances: 100 kWh for electricity, 20 m³ for water.\n
Calculate overuse as: usage - allowance (if positive) or 0 (if negative).\n`;

        // Use Cohere chat endpoint (current API). If provider changes, we parse defensively.
        const response = await fetch('https://api.cohere.ai/v1/chat', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${cohereApiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'command-r',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 2000,
                temperature: 0.1
            })
        });

        if (!response.ok) {
            const errText = await response.text().catch(()=>'');
            throw new Error(`Cohere API error: ${response.status} ${response.statusText} ${errText}`);
        }

        const data = await response.json();
        // New API returns { text: "..." } or { message: { content: [...] } }
        let text = data?.text;
        if (!text && data?.message?.content?.length) {
            text = data.message.content.map(p => p.text || '').join('\n');
        }
        if (!text && Array.isArray(data?.generations) && data.generations[0]?.text) {
            text = data.generations[0].text; // legacy fallback parse
        }
        if (!text) {
            throw new Error('Cohere response missing text');
        }
        const analysis = JSON.parse(text);
        
        return analysis;
    } catch (error) {
        console.error('Cohere API error:', error);
        throw error;
    }
}

// Fallback analysis when Cohere API is not available
function analyzeWithFallback(tableData, propertyName) {
    const electricityBills = [];
    const waterBills = [];
    
    for (const bill of tableData) {
        const service = (bill.Service || '').toLowerCase();
        const total = parseFloat((bill.Total || '0').replace('€', '').replace(',', '.').trim());
        
        if (service.includes('electric') || service.includes('electricity') || service.includes('luz')) {
            const usage = parseFloat(bill.Usage || bill['kWh'] || '0');
            const allowance = 100; // Default electricity allowance
            const overuse = Math.max(0, usage - allowance);
            
            electricityBills.push({
                service: bill.Service || 'Electricity',
                usage: usage,
                allowance: allowance,
                start_date: bill['Initial date'] || '',
                end_date: bill['Final date'] || '',
                total_cost: total,
                overuse: overuse,
                month: extractMonth(bill['Initial date'] || bill['Final date'] || '')
            });
        } else if (service.includes('water') || service.includes('agua') || service.includes('supply')) {
            const usage = parseFloat(bill.Usage || bill['m³'] || bill['m3'] || '0');
            const allowance = 20; // Default water allowance
            const overuse = Math.max(0, usage - allowance);
            
            waterBills.push({
                service: bill.Service || 'Water',
                usage: usage,
                allowance: allowance,
                start_date: bill['Initial date'] || '',
                end_date: bill['Final date'] || '',
                total_cost: total,
                overuse: overuse,
                month: extractMonth(bill['Initial date'] || bill['Final date'] || '')
            });
        }
    }
    
    return { electricity_bills: electricityBills, water_bills: waterBills };
}

function extractMonth(dateStr) {
    if (!dateStr || !dateStr.includes('/')) return 0;
    const parts = dateStr.split('/');
    return parseInt(parts[1]) || 0;
}

// Calculate allowance-based totals with overuse/underuse logic
function calculateAllowanceTotals(analysis, targetMonths) {
    const currentYear = new Date().getFullYear();
    
    // Filter bills for target months
    const electricityBills = analysis.electricity_bills.filter(bill => 
        targetMonths.includes(bill.month) && bill.month > 0
    );
    const waterBills = analysis.water_bills.filter(bill => 
        targetMonths.includes(bill.month) && bill.month > 0
    );
    
    // Sort by month to ensure proper order
    electricityBills.sort((a, b) => a.month - b.month);
    waterBills.sort((a, b) => a.month - b.month);
    
    // Calculate electricity totals
    let electricityOveruse = 0;
    let electricityBillsCount = 0;
    let electricityTotalCost = 0;
    
    for (const bill of electricityBills) {
        electricityOveruse += bill.overuse;
        electricityBillsCount++;
        electricityTotalCost += bill.total_cost;
    }
    
    // Calculate water totals
    let waterOveruse = 0;
    let waterBillsCount = 0;
    let waterTotalCost = 0;
    
    for (const bill of waterBills) {
        waterOveruse += bill.overuse;
        waterBillsCount++;
        waterTotalCost += bill.total_cost;
    }
    
    // Apply overuse/underuse logic: if one month is overuse and one is underuse, 
    // show total as overuse + 0 (not the sum)
    const totalOveruse = Math.max(0, electricityOveruse + waterOveruse);
    const totalCost = electricityTotalCost + waterTotalCost;
    
    return {
        electricity_bills: electricityBillsCount,
        water_bills: waterBillsCount,
        electricity_overuse: electricityOveruse,
        water_overuse: waterOveruse,
        total_overuse: totalOveruse,
        total_cost: totalCost.toFixed(2),
        electricity_cost: electricityTotalCost.toFixed(2),
        water_cost: waterTotalCost.toFixed(2)
    };
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
        
        console.log('🟡 Launching Playwright Chromium...');
        let browser;
        const remoteWs = process.env.BROWSER_WS_URL || process.env.BROWSERLESS_WS_URL;
        const forceLocal = String(process.env.FORCE_LOCAL_CHROMIUM || '').toLowerCase() === 'true';
        let context; // will be set after connect
        try {
            if (forceLocal) {
                console.log('⛳ FORCE_LOCAL_CHROMIUM=true → using local Chromium (persistent context)');
                sendEvent({ type: 'log', level: 'info', message: '⛳ Using local Chromium (persistent context)' });
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
                console.log('🟢 Persistent context launched.');
                sendEvent({ type: 'log', level: 'info', message: '🟢 Persistent context launched.' });
            } else {
                if (!remoteWs) {
                    throw new Error('BROWSER_WS_URL (Browserless) is not configured');
                }
                console.log('🌐 Connecting to remote browser over WebSocket…');
                sendEvent({ type: 'log', level: 'info', message: '🌐 Connecting to remote browser…' });
                browser = await chromium.connectOverCDP(remoteWs);
                console.log('🟢 Connected to remote browser.');
                sendEvent({ type: 'log', level: 'info', message: '🟢 Connected to remote browser.' });
            }
        } catch (e) {
            const msg = e?.message || String(e);
            console.error('🔴 Remote connection failed:', msg);
            sendEvent({ type: 'error', message: `Remote Browserless connect failed: ${msg}` });
            if (!forceLocal) throw e;
        }
        
        // Create context with watchdogs and logs
        sendEvent({ type: 'log', level: 'info', message: '⚙️ Creating browser context…' });
            try {
                if (!context) {
                // Prefer existing context when connected over CDP (remote Browserless usually runs persistent context)
                const existingContexts = typeof browser?.contexts === 'function' ? browser.contexts() : [];
                if (existingContexts && existingContexts.length > 0) {
                    context = existingContexts[0];
                } else {
                        context = await Promise.race([
                            browser.newContext({
                                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                                locale: 'en-US',
                                timezoneId: 'Europe/Madrid',
                            }),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('newContext timeout (10s)')), 10000))
                    ]);
                }
            }
        } catch (e) {
            sendEvent({ type: 'error', message: `Context creation failed: ${e.message || e}` });
            throw e;
        }
        sendEvent({ type: 'log', level: 'success', message: '✅ Context created' });

        sendEvent({ type: 'log', level: 'info', message: '📄 Opening new page…' });
        let page;
        try {
            // Try existing page first (persistent context usually has one)
            const existing = context.pages();
            if (existing && existing.length > 0) {
                page = existing[0];
            } else {
                page = await Promise.race([
                    context.newPage(),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('newPage timeout (30s)')), 30000))
                ]);
            }
        } catch (e1) {
            try {
                sendEvent({ type: 'log', level: 'warning', message: '⚠️ context.newPage failed, trying persistent context refresh…' });
                // As a recovery, relaunch persistent context which returns a page immediately
                const userDataDir = '/tmp/chrome-profile';
                const pctx = await chromium.launchPersistentContext(userDataDir, {
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
                context = pctx;
                const pages = context.pages();
                page = pages.length ? pages[0] : await context.newPage();
            } catch (e3) {
                sendEvent({ type: 'error', message: `Page open failed: ${e1.message || e1} / ${e3.message || e3}` });
                throw e3;
            }
        }
        sendEvent({ type: 'log', level: 'success', message: '✅ Page opened' });
        try {
            await page.addInitScript(() => {
                // Reduce headless detection
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
                // Pretend Chrome env
                window.chrome = { runtime: {} };
            });
            await page.setViewportSize?.({ width: 1366, height: 768 });
            await context.setExtraHTTPHeaders?.({ 'Accept-Language': 'en-US,en;q=0.9' });
        } catch (_) {}

        // Set sane timeouts to avoid silent hangs
        try {
            page.setDefaultTimeout(15000);
            page.setDefaultNavigationTimeout(30000);
            sendEvent({ type: 'log', level: 'info', message: '⏱️ Timeouts configured' });
        } catch (e) {
            sendEvent({ type: 'error', message: `Failed to set timeouts: ${e.message || e}` });
        }

        // --- Lightweight diagnostics to catch why pages close ---
        try {
            page.on('close', () => sendEvent({ type: 'log', level: 'error', message: '🛑 Page closed event fired' }));
            page.on('crash', () => sendEvent({ type: 'log', level: 'error', message: '💥 Page crashed' }));
            page.on('pageerror', (err) => sendEvent({ type: 'log', level: 'error', message: `🧨 Page error: ${err?.message || err}` }));
            page.on('console', (msg) => {
                const type = msg.type();
                if (type === 'error') sendEvent({ type: 'log', level: 'error', message: `🖥️ Console error: ${msg.text()}` });
            });
            page.on('requestfailed', (req) => {
                const url = req.url();
                const failure = req.failure()?.errorText || 'unknown';
                if (/polaroo|dashboard|login|accounting/i.test(url)) {
                    sendEvent({ type: 'log', level: 'warning', message: `❌ Request failed: ${url} -> ${failure}` });
                }
            });
            browser.on?.('disconnected', () => {
                sendEvent({ type: 'log', level: 'error', message: '🔌 Browser disconnected (check Browserless timeout settings)' });
            });
        } catch (_) {}

        // Keep remote Browserless session active by sending tiny script periodically
        let __keepAliveInterval;
        try {
            __keepAliveInterval = setInterval(() => {
                page?.evaluate?.(() => 0).catch(() => {});
            }, 3000);
        } catch (_) {}

        // Browser reconnection function
        async function reconnectBrowser() {
            try {
                logs.push({ message: `🔄 Attempting browser reconnection...`, level: 'warning' });
                sendEvent({ type: 'log', level: 'warning', message: '🔄 Attempting browser reconnection...' });
                
                // Close existing connections
                try {
                    if (context && typeof context.close === 'function') {
                        await context.close();
                    } else if (browser) {
                        await browser.close();
                    }
                } catch (_) {}
                
                // Reconnect to remote browser
                if (remoteWs) {
                    browser = await chromium.connectOverCDP(remoteWs);
                    context = await browser.newContext({
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
                        locale: 'en-US',
                        timezoneId: 'Europe/Madrid',
                    });
                    page = await context.newPage();
                    
                    // Re-setup page configuration
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
                    
                    logs.push({ message: `✅ Browser reconnected successfully`, level: 'success' });
                    sendEvent({ type: 'log', level: 'success', message: '✅ Browser reconnected successfully' });
                    return true;
                } else {
                    throw new Error('No remote browser URL available for reconnection');
                }
            } catch (error) {
                logs.push({ message: `❌ Browser reconnection failed: ${error.message}`, level: 'error' });
                sendEvent({ type: 'log', level: 'error', message: `❌ Browser reconnection failed: ${error.message}` });
                return false;
            }
        }
        
        const results = [];
        const logs = [];
        
        try {
            // Login to Polaroo (robust + retries + waits)
            await withRetry(async (attempt) => {
                logs.push({ message: `🔑 Logging into Polaroo... (attempt ${attempt})`, level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: `🔑 Logging into Polaroo... (attempt ${attempt})` });
                // Quick egress probe
                await probeUrl('https://www.google.com', 'egress');
                await probeUrl('https://app.polaroo.com', 'polaroo host');
                // watchdog navigation to login
                await navigateWithWatchdog(page, 'https://app.polaroo.com/login', 'login page');
                // Wait for Cloudflare Turnstile to finish if present
                await waitCloudflareIfPresent(page, 60000);
                await debugLoginDom(page);
                // Some tenants render SSO first; try to reveal classic email login if present
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

                // Wait loop for dashboard
                logs.push({ message: '⏳ Waiting for dashboard redirect...', level: 'info' });
                sendEvent({ type: 'log', level: 'info', message: '⏳ Waiting for dashboard redirect...' });
                const ok = await waitForUrlContains(page, 'dashboard', 30000);
                if (!ok) {
                    // final try to go direct
                    logs.push({ message: '↪️ Forcing navigation to /dashboard', level: 'warning' });
                    sendEvent({ type: 'log', level: 'warning', message: '↪️ Forcing navigation to /dashboard' });
                    await page.goto('https://app.polaroo.com/dashboard', { timeout: 60000, waitUntil: 'networkidle' }).catch(()=>{});
                    await page.waitForLoadState('networkidle').catch(()=>{});
                }
                if (!page.url().includes('dashboard')) throw new Error('No dashboard after login');
                logs.push({ message: '✅ Successfully logged into Polaroo!', level: 'success' });
                sendEvent({ type: 'log', level: 'success', message: '✅ Successfully logged into Polaroo!' });

                // Keep-alive anchor tab to reduce remote browser idle/cleanup
                try {
                    const anchorPage = await context.newPage();
                    await anchorPage.goto('https://app.polaroo.com/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
                    sendEvent({ type: 'log', level: 'info', message: '🪝 Anchor tab opened to keep session alive' });
                    anchorPage.on('close', async () => {
                        try {
                            const ap = await context.newPage();
                            await ap.goto('https://app.polaroo.com/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
                            sendEvent({ type: 'log', level: 'warning', message: '🪝 Anchor tab recreated after close' });
                        } catch (_) {}
                    });
                } catch (_) {}
            }, 3, 1000, 'login');
            
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
            
            logs.push({ message: `📅 Processing months: ${targetMonths.join(', ')}`, level: 'info' });
            
            // Process each property
            for (let i = 0; i < properties.length; i++) {
                if (effectiveLimit && i >= effectiveLimit) break;
                const propertyName = properties[i];
                
                logs.push({ message: `🏠 Processing property ${i + 1}/${totalToProcess}: ${propertyName}`, level: 'info' });
                
                try {
                    // Navigate to accounting dashboard
                    logs.push({ message: `🔍 Navigating to accounting dashboard...`, level: 'info' });
                    await withRetry(async () => {
                        logs.push({ message: '🌐 Navigating to /dashboard/accounting…', level: 'info' });
                        sendEvent({ type: 'log', level: 'info', message: '🌐 Navigating to /dashboard/accounting…' });
                        await page.goto('https://app.polaroo.com/dashboard/accounting', { timeout: 60000, waitUntil: 'networkidle' });
                        await page.waitForLoadState('networkidle').catch(()=>{});
                        await sleep(WAIT_MS);
                    }, 2, 800, 'navigate-accounting');
                    
                    // Search for property
                    logs.push({ message: `🔍 Searching for: ${propertyName}`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `🔍 Searching for: ${propertyName}` });
                    const searchInput = page.locator('input[placeholder*="search"], input[placeholder*="Search"]').first();
                    if (await searchInput.count() > 0) {
                        await searchInput.fill(propertyName);
                        await page.keyboard.press('Enter');
                        await sleep(WAIT_MS);
                    }
                    
                    // Wait for table to load
                    logs.push({ message: `📊 Waiting for invoice table to load...`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: '📊 Waiting for invoice table to load...' });
                    await page.waitForSelector('table, .table, [role="table"]', { timeout: 60000 });
                    
                    // Extract table data
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
                                    rowData[headers[j]] = cellText;
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
                    
                    // Debug: Log the actual table data being extracted
                    console.log(`🔍 DEBUG - Table data for ${propertyName}:`, JSON.stringify(tableData, null, 2));
                    logs.push({ message: `🔍 DEBUG - First 3 rows: ${JSON.stringify(tableData.slice(0, 3), null, 2)}`, level: 'info' });
                    sendEvent({ type: 'log', level: 'info', message: `🔍 DEBUG - First 3 rows extracted` });
                    
                    // Validate table data before sending to Cohere
                    let analysis;
                    if (!tableData || tableData.length === 0) {
                        logs.push({ message: `⚠️ No table data found for ${propertyName}, using fallback analysis`, level: 'warning' });
                        sendEvent({ type: 'log', level: 'warning', message: `⚠️ No table data found for ${propertyName}` });
                        analysis = analyzeWithFallback([], propertyName);
                    } else {
                        // Check if data has meaningful content (not just empty strings)
                        const hasValidData = tableData.some(row => 
                            Object.values(row).some(value => value && value.toString().trim() !== '')
                        );
                        
                        if (!hasValidData) {
                            logs.push({ message: `⚠️ Table data appears empty for ${propertyName}, using fallback analysis`, level: 'warning' });
                            sendEvent({ type: 'log', level: 'warning', message: `⚠️ Table data appears empty for ${propertyName}` });
                            analysis = analyzeWithFallback(tableData, propertyName);
                        } else {
                            // Use Cohere API for intelligent analysis
                            logs.push({ message: `🤖 Analyzing bills with Cohere AI...`, level: 'info' });
                            sendEvent({ type: 'log', level: 'info', message: '🤖 Analyzing bills with Cohere AI...' });
                            
                            try {
                                analysis = await analyzeWithCohere(tableData, propertyName);
                            } catch (cohereError) {
                                logs.push({ message: `⚠️ Cohere API failed: ${cohereError.message}, using fallback analysis`, level: 'warning' });
                                sendEvent({ type: 'log', level: 'warning', message: `⚠️ Cohere API failed, using fallback` });
                                analysis = analyzeWithFallback(tableData, propertyName);
                            }
                        }
                    }
                    
                    logs.push({ message: `⚡ Found ${analysis.electricity_bills.length} electricity bills`, level: 'info' });
                    logs.push({ message: `💧 Found ${analysis.water_bills.length} water bills`, level: 'info' });
                    
                    // Calculate allowance-based totals
                    logs.push({ message: `🧮 Calculating allowance-based totals...`, level: 'info' });
                    const totals = calculateAllowanceTotals(analysis, targetMonths);
                    
                    logs.push({ message: `📊 Electricity: ${totals.electricity_bills} bills, ${totals.electricity_overuse} overuse, ${totals.electricity_cost} €`, level: 'info' });
                    logs.push({ message: `📊 Water: ${totals.water_bills} bills, ${totals.water_overuse} overuse, ${totals.water_cost} €`, level: 'info' });
                    logs.push({ message: `📊 Total Overuse: ${totals.total_overuse} units, Total Cost: ${totals.total_cost} €`, level: 'success' });
                    
                    const result = {
                        property: propertyName,
                        success: true,
                        electricity_bills: totals.electricity_bills,
                        water_bills: totals.water_bills,
                        electricity_overuse: totals.electricity_overuse,
                        water_overuse: totals.water_overuse,
                        total_overuse: totals.total_overuse,
                        total_cost: totals.total_cost,
                        electricity_cost: totals.electricity_cost,
                        water_cost: totals.water_cost
                    };
                    
                    results.push(result);
                    logs.push({ message: `✅ COMPLETED: ${propertyName} - ${totals.electricity_bills} elec + ${totals.water_bills} water = ${totals.total_overuse} overuse, ${totals.total_cost} €`, level: 'success' });
                    sendEvent({ type: 'log', level: 'success', message: `✅ COMPLETED: ${propertyName}` });
                    
                } catch (error) {
                    console.error(`❌ Error processing ${propertyName}:`, error.message);
                    
                    // Check if it's a browser disconnection error
                    const isBrowserDisconnected = error.message.includes('closed') || 
                                                error.message.includes('disconnected') || 
                                                error.message.includes('Target page, context or browser has been closed');
                    
                    if (isBrowserDisconnected) {
                        logs.push({ message: `🔄 Browser disconnected while processing ${propertyName}, attempting reconnection...`, level: 'warning' });
                        sendEvent({ type: 'log', level: 'warning', message: `🔄 Browser disconnected, attempting reconnection...` });
                        
                        // Attempt to reconnect
                        const reconnected = await reconnectBrowser();
                        if (reconnected) {
                            // Re-login after reconnection
                            try {
                                logs.push({ message: `🔑 Re-logging into Polaroo after reconnection...`, level: 'info' });
                                sendEvent({ type: 'log', level: 'info', message: '🔑 Re-logging into Polaroo...' });
                                
                                await page.goto('https://app.polaroo.com/login', { timeout: 60000, waitUntil: 'domcontentloaded' });
                                await sleep(2000);
                                
                                const ok = await safeFillAndSubmit(page, email, password);
                                if (ok) {
                                    const dashboardOk = await waitForUrlContains(page, 'dashboard', 30000);
                                    if (dashboardOk) {
                                        logs.push({ message: `✅ Re-login successful, continuing with next property...`, level: 'success' });
                                        sendEvent({ type: 'log', level: 'success', message: '✅ Re-login successful' });
                                        
                                        // Skip this property and continue with next
                                        const result = {
                                            property: propertyName,
                                            success: false,
                                            error: 'Browser disconnected, skipped after reconnection'
                                        };
                                        results.push(result);
                                        logs.push({ message: `⏭️ Skipped ${propertyName} due to browser disconnection`, level: 'warning' });
                                        continue; // Skip to next property
                                    }
                                }
                            } catch (loginError) {
                                logs.push({ message: `❌ Re-login failed: ${loginError.message}`, level: 'error' });
                            }
                        }
                    }
                    
                    const result = {
                        property: propertyName,
                        success: false,
                        error: error.message
                    };
                    results.push(result);
                    logs.push({ message: `❌ Failed to process ${propertyName}: ${error.message}`, level: 'error' });
                    sendEvent({ type: 'log', level: 'error', message: `❌ Failed: ${propertyName} - ${error.message}` });
                }
                // small jitter between properties to avoid rate-limits
                await sleep(WAIT_MS + jitter());
            }
            
        } finally {
            try {
                if (context && typeof context.close === 'function') {
                    await context.close();
                } else if (browser) {
                    await browser.close();
                }
            } catch (_) {}
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