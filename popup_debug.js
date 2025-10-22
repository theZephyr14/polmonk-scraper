const { chromium } = require('playwright');

async function popupDebug() {
    console.log('🔍 Starting popup browser debug...');
    
    // Launch browser with visible UI
    const browser = await chromium.launch({ 
        headless: false,  // Show browser window
        slowMo: 1000     // Slow down for visibility
    });
    
    const context = await browser.newContext();
    const page = await context.newPage();
    
    try {
        console.log('🌐 Opening Polaroo login page...');
        await page.goto('https://app.polaroo.com/login');
        
        console.log('👤 Please login manually in the browser window...');
        console.log('📧 Email: kevin@thmrentals.com');
        console.log('🔑 Password: Thmrentals2024!');
        console.log('⏳ Waiting for you to login and navigate to a property\'s invoices page...');
        console.log('⏳ Press Enter here when you\'re ready to extract table data...');
        
        // Wait for user to press Enter
        await new Promise(resolve => {
            process.stdin.once('data', () => resolve());
        });
        
        console.log('🔍 Extracting table data...');
        
        // Extract table data with detailed analysis
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
        console.log('='.repeat(60));
        
        for (const table of tableData) {
            console.log(`\n🔍 Table ${table.tableIndex}:`);
            console.log(`  📋 Headers: [${table.headers.join(', ')}]`);
            console.log(`  📊 Rows: ${table.rowCount}`);
            
            if (table.data.length > 0) {
                console.log(`  📝 Sample row:`, JSON.stringify(table.data[0], null, 2));
                
                // Check for electricity and water bills
                const electricityBills = table.data.filter(row => 
                    row.Service && row.Service.toLowerCase().includes('electricity')
                );
                const waterBills = table.data.filter(row => 
                    row.Service && row.Service.toLowerCase().includes('water')
                );
                
                console.log(`  ⚡ Electricity bills: ${electricityBills.length}`);
                console.log(`  💧 Water bills: ${waterBills.length}`);
                
                if (electricityBills.length > 0) {
                    console.log(`  ⚡ Electricity sample:`, JSON.stringify(electricityBills[0], null, 2));
                }
                if (waterBills.length > 0) {
                    console.log(`  💧 Water sample:`, JSON.stringify(waterBills[0], null, 2));
                }
            }
        }
        
        console.log('\n✅ Table analysis complete!');
        console.log('🔍 Browser will stay open for 30 seconds for inspection...');
        
        // Keep browser open for inspection
        await new Promise(resolve => setTimeout(resolve, 30000));
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await browser.close();
    }
}

popupDebug().catch(console.error);
