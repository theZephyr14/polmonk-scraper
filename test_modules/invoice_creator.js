// Create invoice in HouseMonk for property overuse
async function createInvoiceForOveruse(auth, resolver, propertyData, pdfFilesOrKeys, jsonFilesOrKeys) {
    console.log(`  📝 Creating invoice for ${propertyData.property}...`);
    
    try {
        // 1. Resolve IDs from unit code
        if (!propertyData.unitCode) {
            throw new Error('Property missing unitCode - cannot resolve HouseMonk IDs');
        }
        
        const unitDetails = await resolver.resolveFromUnitCode(propertyData.unitCode);
        console.log(`    ✅ Resolved unit: ${unitDetails.propertyName} (tenant: ${unitDetails.tenantName})`);
        
        // 2. Get products and tax codes for project
        const products = await resolver.getProductsForProject(unitDetails.projectId);
        const taxCodes = await resolver.getTaxCodesForProject(unitDetails.projectId);
        
        // Find utilities/overuse product (or use first product for testing)
        const utilityProduct = products.find(p => /utilit|overuse|supplies/i.test(p.name)) || products[0];
        if (!utilityProduct) {
            throw new Error('No products found for this project');
        }
        console.log(`    ✅ Using product: ${utilityProduct.name}`);
        
        // Use first tax code
        const taxCode = taxCodes[0];
        if (!taxCode) {
            throw new Error('No tax codes found for this project');
        }
        console.log(`    ✅ Using tax code: ${taxCode.name || taxCode._id}`);
        
        // Normalize files list: allow full docs or plain objectKeys
        const asArray = v => Array.isArray(v) ? v : (v ? [v] : []);
        const pdfInputs = asArray(pdfFilesOrKeys);
        const jsonInputs = asArray(jsonFilesOrKeys);
        const files = [
            ...pdfInputs.map(f => {
                if (f && typeof f === 'object' && f.objectKey) {
                    return { status: 'active', ...f };
                }
                return {
                    objectKey: String(f),
                    status: 'active',
                    fileName: `utility_bill_${propertyData.property.replace(/\s+/g, '_')}.pdf`,
                    fileFormat: 'application/pdf'
                };
            }),
            ...jsonInputs.map(f => {
                if (f && typeof f === 'object' && f.objectKey) {
                    return { status: 'active', ...f };
                }
                return {
                    objectKey: String(f),
                    status: 'active',
                    fileName: `metadata_${propertyData.property.replace(/\s+/g, '_')}.json`,
                    fileFormat: 'application/json'
                };
            })
        ];

        // 3. Build invoice payload
        const today = new Date().toISOString().split('T')[0];
        const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const payload = {
            users: [unitDetails.tenantId],
            type: 'Utilities', // Fixed: Changed from 'Invoice' to 'Utilities'
            transactionBelongsTo: 'Home',
            home: unitDetails.homeId,
            project: unitDetails.projectId,
            listing: unitDetails.listingId,
            source: 'api_external',
            status: 'due', // ensure document number is generated
            dueDate,
            invoiceDate: today,
            taxable: true,
            totalAmount: propertyData.overuse_amount,
            openingBalance: propertyData.overuse_amount,
            // Add required fields that might be missing
            currency: 'EUR',
            paymentTerms: '30',
            // Additional fields that might be required
            organization: unitDetails.organizationId || unitDetails.projectId, // Use project as fallback
            createdBy: auth.config.userId, // Add creator
            updatedBy: auth.config.userId, // Add updater
            itemDetails: [{
                amount: propertyData.overuse_amount,
                taxable: true,
                taxAmount: 0,
                netAmount: propertyData.overuse_amount,
                description: `Utilities Overuse - ${propertyData.period || 'Current Period'} (Electricity: ${propertyData.electricity_cost || 0}€, Water: ${propertyData.water_cost || 0}€)`,
                quantity: 1,
                billedAt: 'none',
                addConvenienceFee: false,
                convenienceFee: 0,
                convenienceFeeType: 'fixed',
                product: utilityProduct._id,
                rate: propertyData.overuse_amount,
                unit: 'unit',
                taxCode: taxCode._id
            }],
            files,
            notes: `Generated from Polaroo overuse analysis for ${propertyData.property}. Electricity bills: ${propertyData.electricity_bills_count || 0}, Water bills: ${propertyData.water_bills_count || 0}. Total overuse: ${propertyData.overuse_amount.toFixed(2)}€`
        };
        
        console.log(`    📋 Invoice payload prepared (${propertyData.overuse_amount.toFixed(2)}€, ${files.length} files)`);
        console.log(`    📋 Full payload:`, JSON.stringify(payload, null, 2));
        
        // 4. Create invoice via API
        const response = await auth.makeAuthenticatedRequest('POST', '/api/transaction', payload, true);
        
        console.log(`    ✅ Invoice created: ${response.data._id}`);
        console.log(`    📋 Invoice response:`, JSON.stringify(response.data, null, 2));
        
        // 5. Verify invoice was created properly by fetching it
        try {
            const verifyResponse = await auth.makeAuthenticatedRequest('GET', `/api/transaction/${response.data._id}`, null, true);
            console.log(`    ✅ Invoice verification:`, JSON.stringify(verifyResponse.data, null, 2));
        } catch (verifyError) {
            console.log(`    ⚠️ Could not verify invoice:`, verifyError.message);
        }
        
        return response.data;
        
    } catch (error) {
        console.error(`    ❌ Invoice creation failed:`, error.response?.data?.message || error.message);
        if (error.response?.data) {
            console.error(`    📋 Details:`, JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

module.exports = { createInvoiceForOveruse };

