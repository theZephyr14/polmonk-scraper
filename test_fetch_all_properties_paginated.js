const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Use the working token from working_integration.js
const WORKING_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiI2ODkxZGZiZjA1MmQxZDdmMzM2ZDBkNjIiLCJ0eXBlcyI6WyJhZG1pbiJdLCJpYXQiOjE3NTg1MzUzNjEsImV4cCI6MTc2NjMxMTM2MX0.wGHFL1Gd3cOODn6uHVcV5IbJ2xMZBoCoMmvydet8fRY";
const CLIENT_ID = "1326bbe0-8ed1-11f0-b658-7dd414f87b53";

async function fetchAllPropertiesPaginated() {
    try {
        console.log('🏠 Fetching ALL properties from HouseMonk with pagination...\n');
        
        let allProperties = [];
        let page = 1;
        let limit = 100; // Fetch 100 per page
        let hasMore = true;
        
        while (hasMore) {
            console.log(`📄 Fetching page ${page} (limit: ${limit})...`);
            
            const response = await axios.get("https://dashboard.thehousemonk.com/api/home", {
                headers: {
                    "authorization": WORKING_TOKEN,
                    "x-api-key": CLIENT_ID
                },
                params: {
                    page: page,
                    limit: limit
                }
            });
            
            const data = response.data;
            const properties = data.rows || [];
            
            console.log(`  ✅ Page ${page}: Found ${properties.length} properties (Total: ${data.count})`);
            
            allProperties = allProperties.concat(properties);
            
            // Check if we have more pages
            if (properties.length < limit || allProperties.length >= data.count) {
                hasMore = false;
                console.log(`  📊 Reached end. Total properties fetched: ${allProperties.length}`);
            } else {
                page++;
                // Small delay to avoid overwhelming the API
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        
        console.log(`\n✅ FINAL RESULT: Found ${allProperties.length} total properties`);
        
        // Now check Book1 IDs against ALL properties
        console.log('\n📖 Reading Book1.xlsx...');
        const filePath = path.join(__dirname, 'New try - backup', 'New try', 'Book1.xlsx');
        const workbook = XLSX.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        const book1Data = jsonData
            .filter((row, index) => index > 0 && row.length >= 3)
            .map((row, index) => ({
                rowNumber: index + 2,
                propertyName: row[0] || '',
                unitId: row[2] || ''
            }))
            .filter(entry => entry.propertyName && entry.unitId);

        console.log(`✅ Found ${book1Data.length} Book1 entries`);
        
        // Check for matches
        console.log('\n🔍 Checking Book1 unit IDs against ALL properties...');
        const accessibleIds = allProperties.map(p => p._id);
        const matches = [];
        const notFound = [];
        
        book1Data.forEach(entry => {
            if (accessibleIds.includes(entry.unitId)) {
                const property = allProperties.find(p => p._id === entry.unitId);
                matches.push({
                    book1Name: entry.propertyName,
                    unitId: entry.unitId,
                    housemonkName: property.name || property.address || 'No name',
                    project: property.project,
                    status: property.status
                });
            } else {
                notFound.push(entry);
            }
        });
        
        // Results
        console.log('\n📊 FINAL RESULTS:');
        console.log(`✅ Book1 IDs found in HouseMonk: ${matches.length}`);
        console.log(`❌ Book1 IDs NOT found in HouseMonk: ${notFound.length}`);
        
        if (matches.length > 0) {
            console.log('\n✅ MATCHES FOUND:');
            matches.forEach(match => {
                console.log(`  "${match.book1Name}" (${match.unitId}) → "${match.housemonkName}"`);
                console.log(`    Project: ${match.project}, Status: ${match.status}`);
            });
        }
        
        if (notFound.length > 0) {
            console.log('\n❌ NOT FOUND IN HOUSEMONK:');
            notFound.slice(0, 10).forEach(entry => {
                console.log(`  "${entry.propertyName}" (${entry.unitId})`);
            });
            if (notFound.length > 10) {
                console.log(`  ... and ${notFound.length - 10} more`);
            }
        }
        
        // Show property distribution
        console.log('\n🏠 PROPERTY DISTRIBUTION:');
        const propertyGroups = {};
        allProperties.forEach(prop => {
            const name = prop.name || prop.address || 'No name';
            if (!propertyGroups[name]) {
                propertyGroups[name] = 0;
            }
            propertyGroups[name]++;
        });
        
        Object.entries(propertyGroups)
            .sort((a, b) => b[1] - a[1])
            .forEach(([name, count]) => {
                console.log(`  ${name}: ${count} units`);
            });
        
        // Save detailed report
        const reportData = {
            timestamp: new Date().toISOString(),
            summary: {
                totalProperties: allProperties.length,
                totalBook1Entries: book1Data.length,
                matches: matches.length,
                notFound: notFound.length
            },
            matches: matches,
            notFound: notFound,
            allProperties: allProperties.map(p => ({
                id: p._id,
                name: p.name || p.address || 'No name',
                project: p.project,
                status: p.status
            }))
        };
        
        fs.writeFileSync('all_properties_paginated_report.json', JSON.stringify(reportData, null, 2));
        console.log('\n💾 Detailed report saved to: all_properties_paginated_report.json');
        
    } catch (error) {
        console.error('❌ Error:', error.response?.data?.message || error.message);
        throw error;
    }
}

// Run the function
fetchAllPropertiesPaginated().catch(console.error);
