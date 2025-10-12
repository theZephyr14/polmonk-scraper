const { HouseMonkAuth } = require('./test_modules/housemonk_auth');

async function testHouseMonkAPIFields() {
    console.log('🔍 Testing HouseMonk API fields and validation...');

    const auth = new HouseMonkAuth();

    try {
        // Initialize authentication
        await auth.refreshMasterToken();
        await auth.getUserAccessToken(auth.config.userId);
        console.log('✅ HouseMonk Authentication successful');

        // Test 1: Check transaction types by trying to create a minimal transaction
        console.log('\n📋 Testing valid transaction types...');
        const validTypes = ['Invoice', 'Bill', 'Expense', 'CreditNote', 'Proforma'];
        
        for (const type of validTypes) {
            try {
                console.log(`\n🧪 Testing type: "${type}"`);
                
                // Create minimal payload for testing
                const testPayload = {
                    type: type,
                    transactionBelongsTo: 'Home',
                    home: '687519db8b627233fbe41a26', // Use a valid home ID
                    project: '686fb07e0efaf475ceaf6d22', // Use a valid project ID
                    listing: '687519da8b627233fbe419f2', // Use a valid listing ID
                    source: 'api_external',
                    status: 'draft',
                    dueDate: '2025-11-11',
                    invoiceDate: '2025-10-12',
                    totalAmount: 1.00,
                    openingBalance: 1.00,
                    currency: 'EUR',
                    itemDetails: [{
                        amount: 1.00,
                        taxable: true,
                        taxAmount: 0,
                        netAmount: 1.00,
                        description: `Test ${type}`,
                        quantity: 1,
                        billedAt: 'none',
                        addConvenienceFee: false,
                        convenienceFee: 0,
                        convenienceFeeType: 'fixed',
                        product: '68065c1443b0d237f23d248d', // Use a valid product ID
                        rate: 1.00,
                        unit: 'unit',
                        taxCode: '67ee293b1e08ab0d6c5a42b7' // Use a valid tax code ID
                    }],
                    notes: `Test ${type} for API validation`
                };

                console.log(`  📤 Sending test payload for ${type}...`);
                const response = await auth.makeAuthenticatedRequest('POST', '/api/transaction', testPayload, true);
                
                console.log(`  ✅ ${type} - SUCCESS: ${response.data._id}`);
                
                // Clean up - delete the test transaction
                try {
                    await auth.makeAuthenticatedRequest('DELETE', `/api/transaction/${response.data._id}`, null, true);
                    console.log(`  🗑️ Cleaned up test ${type}`);
                } catch (cleanupError) {
                    console.log(`  ⚠️ Could not clean up test ${type}: ${cleanupError.message}`);
                }

            } catch (error) {
                console.log(`  ❌ ${type} - FAILED: ${error.response?.data?.message || error.message}`);
                if (error.response?.data) {
                    console.log(`  📋 Details:`, JSON.stringify(error.response.data, null, 2));
                }
            }
        }

        // Test 2: Check what fields are required for transactions
        console.log('\n📋 Testing required fields...');
        
        const minimalPayload = {
            type: 'Invoice',
            transactionBelongsTo: 'Home',
            home: '687519db8b627233fbe41a26',
            project: '686fb07e0efaf475ceaf6d22',
            listing: '687519db8b627233fbe419f2',
            source: 'api_external',
            status: 'draft',
            dueDate: '2025-11-11',
            invoiceDate: '2025-10-12',
            totalAmount: 1.00,
            openingBalance: 1.00,
            currency: 'EUR',
            itemDetails: [{
                amount: 1.00,
                taxable: true,
                taxAmount: 0,
                netAmount: 1.00,
                description: 'Test minimal invoice',
                quantity: 1,
                billedAt: 'none',
                addConvenienceFee: false,
                convenienceFee: 0,
                convenienceFeeType: 'fixed',
                product: '68065c1443b0d237f23d248d',
                rate: 1.00,
                unit: 'unit',
                taxCode: '67ee293b1e08ab0d6c5a42b7'
            }],
            notes: 'Test minimal invoice for field validation'
        };

        try {
            console.log('  📤 Testing minimal valid payload...');
            const response = await auth.makeAuthenticatedRequest('POST', '/api/transaction', minimalPayload, true);
            console.log(`  ✅ Minimal payload - SUCCESS: ${response.data._id}`);
            
            // Clean up
            try {
                await auth.makeAuthenticatedRequest('DELETE', `/api/transaction/${response.data._id}`, null, true);
                console.log('  🗑️ Cleaned up minimal test');
            } catch (cleanupError) {
                console.log(`  ⚠️ Could not clean up minimal test: ${cleanupError.message}`);
            }
        } catch (error) {
            console.log(`  ❌ Minimal payload - FAILED: ${error.response?.data?.message || error.message}`);
            if (error.response?.data) {
                console.log(`  📋 Details:`, JSON.stringify(error.response.data, null, 2));
            }
        }

        // Test 3: Check available statuses
        console.log('\n📋 Testing transaction statuses...');
        const statuses = ['draft', 'pending', 'sent', 'paid', 'overdue', 'void'];
        
        for (const status of statuses) {
            try {
                console.log(`\n🧪 Testing status: "${status}"`);
                
                const testPayload = {
                    ...minimalPayload,
                    status: status
                };

                const response = await auth.makeAuthenticatedRequest('POST', '/api/transaction', testPayload, true);
                console.log(`  ✅ ${status} - SUCCESS: ${response.data._id}`);
                
                // Clean up
                try {
                    await auth.makeAuthenticatedRequest('DELETE', `/api/transaction/${response.data._id}`, null, true);
                    console.log(`  🗑️ Cleaned up test ${status}`);
                } catch (cleanupError) {
                    console.log(`  ⚠️ Could not clean up test ${status}: ${cleanupError.message}`);
                }

            } catch (error) {
                console.log(`  ❌ ${status} - FAILED: ${error.response?.data?.message || error.message}`);
            }
        }

        // Test 4: Check file attachment structure
        console.log('\n📋 Testing file attachment structure...');
        
        const fileTestPayload = {
            ...minimalPayload,
            files: [
                {
                    objectKey: 'upload/Node Living/test-file.pdf',
                    status: 'active',
                    fileName: 'test-file.pdf',
                    fileFormat: 'application/pdf'
                }
            ]
        };

        try {
            console.log('  📤 Testing file attachment...');
            const response = await auth.makeAuthenticatedRequest('POST', '/api/transaction', fileTestPayload, true);
            console.log(`  ✅ File attachment - SUCCESS: ${response.data._id}`);
            
            // Clean up
            try {
                await auth.makeAuthenticatedRequest('DELETE', `/api/transaction/${response.data._id}`, null, true);
                console.log('  🗑️ Cleaned up file test');
            } catch (cleanupError) {
                console.log(`  ⚠️ Could not clean up file test: ${cleanupError.message}`);
            }
        } catch (error) {
            console.log(`  ❌ File attachment - FAILED: ${error.response?.data?.message || error.message}`);
            if (error.response?.data) {
                console.log(`  📋 Details:`, JSON.stringify(error.response.data, null, 2));
            }
        }

        console.log('\n🎉 API field testing completed!');

    } catch (error) {
        console.error('❌ Failed to test HouseMonk API fields:', error.response?.data?.message || error.message);
        if (error.response?.data) {
            console.error('📋 Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

testHouseMonkAPIFields();
