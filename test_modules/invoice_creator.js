// Create invoice in HouseMonk for property overuse
async function createInvoiceForOveruse(auth, resolver, propertyData, pdfObjectKeys, jsonObjectKeys) {
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
        
        // 3. Build invoice payload
        const today = new Date().toISOString().split('T')[0];
        const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const payload = {
            users: [unitDetails.tenantId],
            type: 'Invoice',
            transactionBelongsTo: 'Home',
            home: unitDetails.homeId,
            project: unitDetails.projectId,
            listing: unitDetails.listingId,
            source: 'api_external',
            status: 'draft',
            dueDate,
            invoiceDate: today,
            taxable: true,
            totalAmount: propertyData.overuse_amount,
            openingBalance: propertyData.overuse_amount,
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
            documents: pdfObjectKeys.map(key => ({ objectKey: key, status: 'active' })),
            notes: `Generated from Polaroo overuse analysis for ${propertyData.property}. Electricity bills: ${propertyData.electricity_bills_count || 0}, Water bills: ${propertyData.water_bills_count || 0}. Total overuse: ${propertyData.overuse_amount.toFixed(2)}€`
        };
        
        console.log(`    📋 Invoice payload prepared (${propertyData.overuse_amount.toFixed(2)}€, ${pdfObjectKeys.length} PDFs)`);
        
        // 4. Create invoice via API
        const response = await auth.makeAuthenticatedRequest('POST', '/api/transaction', payload);
        
        console.log(`    ✅ Invoice created: ${response.data._id}`);
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

