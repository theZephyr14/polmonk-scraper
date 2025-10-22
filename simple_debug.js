const { chromium } = require('playwright');

async function debugTableColumns() {
    console.log('🔍 Starting simple table debug...');
    
    const browser = await chromium.connectOverCDP('wss://production-sfo.browserless.io?token=2TBdtRaSfCJdCtrf0150e386f6b4e285c10a465d3bcf4caf5&timeout=600000');
    const context = await browser.newContext();
    const page = await context.newPage();
    
    try {
        // Just navigate directly to a property's invoices page
        // You'll need to manually login and navigate to the invoices page, then run this
        console.log('🌐 Please manually navigate to a property\'s invoices page in the browser...');
        console.log('🌐 Then press Enter to continue...');
        
        // Wait for user input
        await new Promise(resolve => {
            process.stdin.once('data', () => resolve());
        });
        
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
        console.log('🔍 Browser will stay open for 60 seconds for manual inspection...');
        await new Promise(resolve => setTimeout(resolve, 60000));
        await browser.close();
    }
}

debugTableColumns().catch(console.error);
