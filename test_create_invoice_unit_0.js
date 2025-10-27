const axios = require('axios');

// Test creating a 2 euro invoice for specific unit in PRODUCTION
// Using first accessible unit ID from the report (Carabanchel Long Stays)
const UNIT_ID = '68fb5253939deb769a1a9baf';

// Use the working token from working_integration.js (PRODUCTION)
const userToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiI2ODkxZGZiZjA1MmQxZDdmMzM2ZDBkNjIiLCJ0eXBlcyI6WyJhZG1pbiJdLCJpYXQiOjE3NTg1MzUzNjEsImV4cCI6MTc2NjMxMTM2MX0.wGHFL1Gd3cOODn6uHVcV5IbJ2xMZBoCoMmvydet8fRY";
const clientId = "1326bbe0-8ed1-11f0-b658-7dd414f87b53";
const baseUrl = "https://dashboard.thehousemonk.com";

async function testCreateInvoice() {
    try {
        console.log(`🧪 Testing invoice creation for unit ID: ${UNIT_ID}`);
        console.log('💰 Amount: 2 euros\n');
        
        // Step 1: Get unit details
        console.log('1️⃣ Fetching unit details...');
        const unitResponse = await axios.get(`${baseUrl}/api/home/${UNIT_ID}`, {
            headers: {
                authorization: userToken,
                'x-api-key': clientId
            }
        });
        
        const unit = unitResponse.data;
        console.log(`✅ Unit found: ${unit.name || unit.address || 'No name'}`);
        console.log(`   Project ID: ${unit.project}`);
        console.log(`   Listing ID: ${unit.listing}`);
        
        // Step 2: Get products for the project
        console.log('\n2️⃣ Fetching products...');
        const productsResponse = await axios.get(`${baseUrl}/api/product-and-service?projects=${unit.project}`, {
            headers: {
                authorization: userToken,
                'x-api-key': clientId
            }
        });
        
        const products = productsResponse.data.rows || [];
        console.log(`✅ Found ${products.length} products`);
        
        if (products.length === 0) {
            console.log('❌ NO PRODUCTS AVAILABLE - Cannot create invoice');
            return;
        }
        
        const selectedProduct = products[0];
        console.log(`   Using product: ${selectedProduct.name} (${selectedProduct._id})`);
        
        // Step 3: Get tax codes for the project
        console.log('\n3️⃣ Fetching tax codes...');
        const taxResponse = await axios.get(`${baseUrl}/api/tax?projects=${unit.project}`, {
            headers: {
                authorization: userToken,
                'x-api-key': clientId
            }
        });
        
        const taxCodes = taxResponse.data.rows || [];
        console.log(`✅ Found ${taxCodes.length} tax codes`);
        
        if (taxCodes.length === 0) {
            console.log('❌ NO TAX CODES AVAILABLE - Cannot create invoice');
            return;
        }
        
        const selectedTax = taxCodes[0];
        console.log(`   Using tax code: ${selectedTax.name} (${selectedTax._id})`);
        
        // Step 4: Create invoice with 2 euros
        console.log('\n4️⃣ Creating invoice for 2 euros...');
        
        const today = new Date().toISOString().split('T')[0];
        const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const invoicePayload = {
            users: unit.tenant ? [unit.tenant._id || unit.tenant] : undefined,
            type: 'Invoice',
            transactionBelongsTo: 'Home',
            home: UNIT_ID,
            project: unit.project,
            listing: unit.listing,
            source: 'api_test',
            status: 'due',
            dueDate,
            invoiceDate: today,
            taxable: true,
            totalAmount: 2,
            openingBalance: 2,
            currency: 'EUR',
            paymentTerms: '30',
            itemDetails: [{
                amount: 2,
                taxable: true,
                taxAmount: 0,
                netAmount: 2,
                description: 'Test Invoice - 2 euros',
                quantity: 1,
                product: selectedProduct._id,
                rate: 2,
                unit: 'unit',
                taxCode: selectedTax._id
            }],
            notes: 'Test invoice creation - 2 euros for unit testing'
        };
        
        // Remove undefined keys
        Object.keys(invoicePayload).forEach(k => invoicePayload[k] === undefined && delete invoicePayload[k]);
        
        console.log('📋 Invoice payload:');
        console.log(JSON.stringify(invoicePayload, null, 2));
        
        const invoiceResponse = await axios.post(`${baseUrl}/api/transaction`, invoicePayload, {
            headers: {
                authorization: userToken,
                'x-api-key': clientId,
                'content-type': 'application/json'
            }
        });
        
        console.log(`\n✅ SUCCESS! Invoice created successfully!`);
        console.log(`   Invoice ID: ${invoiceResponse.data._id}`);
        console.log(`   Document Number: ${invoiceResponse.data.documentNumber || 'N/A'}`);
        console.log(`   Amount: ${invoiceResponse.data.totalAmount} EUR`);
        
    } catch (error) {
        console.log('\n⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻');
        console.log('❌ FAILED - Stopping as requested');
        console.log('⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻⁻');
        console.log(`\nError: ${error.response?.data?.message || error.message}`);
        if (error.response?.status) {
            console.log(`Status: ${error.response.status}`);
        }
        if (error.response?.data) {
            console.log('\nFull error response:');
            console.log(JSON.stringify(error.response.data, null, 2));
        }
    }
}

// Run the test
testCreateInvoice();
