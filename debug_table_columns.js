const { chromium } = require('playwright');

// Copy the exact helper functions from server.js
const WAIT_MS = 2000;

// Mock sendEvent function
function sendEvent(data) {
    console.log(`📡 SSE: ${JSON.stringify(data)}`);
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function probeUrl(url, label) {
    try {
        const response = await fetch(url, { method: 'HEAD', timeout: 10000 });
        console.log(`✅ ${label}: ${response.status}`);
        return response.ok;
    } catch (error) {
        console.log(`❌ ${label}: ${error.message}`);
        return false;
    }
}

async function navigateWithWatchdog(page, url, label, timeoutMs = 30000) {
    console.log(`NAV: navigating to ${label} -> ${url}`);
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await sleep(2000);
        return true;
    } catch (error) {
        console.log(`❌ Navigation failed: ${error.message}`);
        return false;
    }
}

async function waitCloudflareIfPresent(page, timeoutMs = 30000) {
    try {
        await page.waitForSelector('text=Checking your browser', { timeout: 5000 });
        console.log('🛡️ Cloudflare detected, waiting...');
        await page.waitForSelector('text=Checking your browser', { state: 'hidden', timeout: timeoutMs });
        console.log('✅ Cloudflare cleared');
    } catch (error) {
        // No cloudflare, continue
    }
}

async function debugLoginDom(page) {
    const title = await page.title();
    const url = page.url();
    console.log(`🔍 Page: ${title} | ${url}`);
}

async function maybeRevealEmailLogin(page) {
    try {
        const emailToggle = page.locator('text=/email|correo/i').first();
        if (await emailToggle.count() > 0) {
            await emailToggle.click({ timeout: 2000 });
            await sleep(1000);
        }
    } catch (error) {
        // Ignore
    }
}

async function safeFillAndSubmit(page, email, password) {
    try {
        // Try multiple selectors for email
        const emailSelectors = [
            'input[type="email"]',
            'input[name="email"]',
            'input[placeholder*="email" i]',
            'input[type="text"]'
        ];
        
        let emailInput = null;
        for (const selector of emailSelectors) {
            try {
                emailInput = await page.waitForSelector(selector, { timeout: 2000 });
                if (emailInput) break;
            } catch (e) {}
        }
        
        if (!emailInput) return false;
        
        await emailInput.fill(email);
        await sleep(500);
        
        // Try multiple selectors for password
        const passwordSelectors = [
            'input[type="password"]',
            'input[name="password"]',
            'input[placeholder*="password" i]'
        ];
        
        let passwordInput = null;
        for (const selector of passwordSelectors) {
            try {
                passwordInput = await page.waitForSelector(selector, { timeout: 2000 });
                if (passwordInput) break;
            } catch (e) {}
        }
        
        if (!passwordInput) return false;
        
        await passwordInput.fill(password);
        await sleep(500);
        
        // Try multiple selectors for submit
        const submitSelectors = [
            'button[type="submit"]',
            'button:has-text("Login")',
            'button:has-text("Sign in")',
            'input[type="submit"]'
        ];
        
        let submitButton = null;
        for (const selector of submitSelectors) {
            try {
                submitButton = await page.waitForSelector(selector, { timeout: 2000 });
                if (submitButton) break;
            } catch (e) {}
        }
        
        if (!submitButton) return false;
        
        await submitButton.click();
        return true;
    } catch (error) {
        console.log(`❌ Fill and submit failed: ${error.message}`);
        return false;
    }
}

async function waitForUrlContains(page, fragment, timeoutMs = 30000) {
    const loops = Math.max(1, Math.floor(timeoutMs / 500));
    for (let i = 0; i < loops; i++) {
        if (page.url().includes(fragment)) return true;
        await sleep(500);
    }
    return false;
}

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

async function debugTableColumns() {
    console.log('🔍 Starting table column debug...');
    
    const browser = await chromium.connectOverCDP('wss://production-sfo.browserless.io?token=2TBdtRaSfCJdCtrf0150e386f6b4e285c10a465d3bcf4caf5&timeout=600000');
    const context = await browser.newContext();
    const page = await context.newPage();
    
    try {
        // Login using the exact same logic as server.js
        console.log('🔐 Logging into Polaroo...');
        await performPolarooLogin(page, 'kevin@thmrentals.com', 'Thmrentals2024!');
        console.log('✅ Login successful!');
        
        // Navigate to a property with bills
        console.log('🏠 Navigating to properties...');
        await page.goto('https://app.polaroo.com/properties');
        await page.waitForSelector('a[href*="/properties/"]', { timeout: 10000 });
        
        // Click on first property
        const propertyLink = await page.$('a[href*="/properties/"]');
        if (propertyLink) {
            await propertyLink.click();
            await page.waitForURL('**/properties/**', { timeout: 10000 });
        }
        
        // Navigate to invoices
        console.log('📄 Navigating to invoices...');
        await page.goto(page.url() + '/invoices');
        await page.waitForSelector('table, .table, [role="table"]', { timeout: 30000 });
        
        // Extract table data with detailed column analysis
        console.log('🔍 Extracting table data...');
        const tableData = await page.evaluate(() => {
            const tables = document.querySelectorAll('table, .table, [role="table"]');
            const results = [];
            
            console.log(`Found ${tables.length} tables`);
            
            for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
                const table = tables[tableIndex];
                const rows = table.querySelectorAll('tr');
                const headers = [];
                
                console.log(`Table ${tableIndex + 1}: ${rows.length} rows`);
                
                if (rows.length > 0) {
                    const headerRow = rows[0];
                    const headerCells = headerRow.querySelectorAll('th, td');
                    
                    console.log(`Table ${tableIndex + 1} headers:`, headerCells.length);
                    
                    for (const cell of headerCells) {
                        const headerText = cell.textContent.trim();
                        headers.push(headerText);
                        console.log(`  - Header: "${headerText}"`);
                    }
                }
                
                const tableData = [];
                for (let i = 1; i < rows.length; i++) {
                    const row = rows[i];
                    const cells = row.querySelectorAll('td, th');
                    const rowData = {};
                    
                    for (let j = 0; j < cells.length && j < headers.length; j++) {
                        const cellText = cells[j].textContent.trim();
                        const header = headers[j];
                        rowData[header] = cellText;
                    }
                    
                    if (Object.keys(rowData).length > 0) {
                        tableData.push(rowData);
                    }
                }
                
                results.push({
                    tableIndex: tableIndex + 1,
                    headers: headers,
                    rowCount: tableData.length,
                    data: tableData
                });
            }
            
            return results;
        });
        
        // Analyze results
        console.log('\n📊 TABLE ANALYSIS:');
        console.log('='.repeat(50));
        
        for (const table of tableData) {
            console.log(`\nTable ${table.tableIndex}:`);
            console.log(`  Headers: [${table.headers.join(', ')}]`);
            console.log(`  Rows: ${table.rowCount}`);
            
            if (table.data.length > 0) {
                console.log(`  Sample row:`, JSON.stringify(table.data[0], null, 2));
                
                // Check for electricity and water bills
                const electricityBills = table.data.filter(row => 
                    row.Service && row.Service.toLowerCase().includes('electricity')
                );
                const waterBills = table.data.filter(row => 
                    row.Service && row.Service.toLowerCase().includes('water')
                );
                
                console.log(`  Electricity bills: ${electricityBills.length}`);
                console.log(`  Water bills: ${waterBills.length}`);
                
                if (electricityBills.length > 0) {
                    console.log(`  Electricity sample:`, JSON.stringify(electricityBills[0], null, 2));
                }
                if (waterBills.length > 0) {
                    console.log(`  Water sample:`, JSON.stringify(waterBills[0], null, 2));
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await browser.close();
    }
}

debugTableColumns().catch(console.error);