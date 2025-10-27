const { HouseMonkAuth, HouseMonkIDResolver } = require('./test_modules/housemonk_auth');
const { createInvoiceForOveruse } = require('./test_modules/invoice_creator');

const testProperties = [
    { property: 'Padilla 1º 1ª', unitCode: '68627691e9dc827f03be3faa', amount: 1.00 },
    { property: 'Pg Sant Joan 161 2-2', unitCode: '68768928e48f7e407fb26ec1', amount: 2.00 },
    { property: 'Valencia Pral 1ª', unitCode: '686688afbf87634e5e72b309', amount: 3.00 }
];

async function testFailedInvoices() {
    console.log('🧪 Testing invoice creation for 3 failed properties in sandbox...\n');
    
    const auth = new HouseMonkAuth();
    await auth.refreshMasterToken();
    await auth.getUserAccessToken(auth.config.userId);
    console.log('✅ Authentication successful\n');
    
    const resolver = new HouseMonkIDResolver(auth);
    
    for (const prop of testProperties) {
        console.log(`\n📝 Testing: ${prop.property} (Unit ID: ${prop.unitCode})`);
        console.log(`💰 Amount: €${prop.amount}\n`);
        
        try {
            // First, test if we can resolve the unit
            console.log('🔍 Step 1: Resolving unit IDs...');
            const unitDetails = await resolver.resolveFromUnitCode(prop.unitCode);
            console.log('✅ Unit resolved:', {
                propertyName: unitDetails.propertyName,
                homeId: unitDetails.homeId,
                projectId: unitDetails.projectId,
                listingId: unitDetails.listingId,
                tenantId: unitDetails.tenantId
            });
            
            // Create mock PDF document
            console.log('\n📄 Step 2: Creating mock PDF document...');
            const mockPdfDocument = {
                status: 'active',
                organizations: ['6715f9742b22a37e2a4a2bca'],
                newBucket: true,
                project: [],
                isDataDummy: false,
                shared: false,
                myMemories: false,
                _id: 'test_' + Date.now(),
                success: true,
                message: '',
                url: 'https://example.com/test.pdf',
                fileFormat: 'application/pdf',
                fileName: `test_${prop.property.replace(/\s+/g, '_')}.pdf`,
                objectKey: `test/${prop.property.replace(/\s+/g, '_')}.pdf`,
                createdBy: auth.config.userId,
                updatedBy: auth.config.userId,
                uploadedBy: auth.config.userId,
                uid: 'test_uid',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                __v: 0
            };
            console.log('✅ Mock PDF document created');
            
            // Create property data with amount
            console.log('\n📊 Step 3: Creating property data...');
            const propertyData = {
                property: prop.property,
                unitCode: prop.unitCode,
                overuse_amount: prop.amount,
                electricity_cost: prop.amount,
                water_cost: 0,
                electricity_bills_count: 1,
                water_bills_count: 0
            };
            console.log('✅ Property data:', propertyData);
            
            // Create invoice
            console.log('\n📝 Step 4: Creating invoice...');
            const invoice = await createInvoiceForOveruse(auth, resolver, propertyData, [mockPdfDocument], []);
            console.log('✅ Invoice created successfully!');
            console.log('   Invoice ID:', invoice._id);
            console.log('   URL:', `${auth.config.baseUrl}/dashboard/transactions/${invoice._id}`);
            
        } catch (error) {
            console.error('❌ ERROR:', error.message);
            console.error('   Details:', error.response?.data || error);
        }
        
        console.log('\n' + '='.repeat(80));
    }
    
    console.log('\n✅ Test completed');
}

testFailedInvoices().catch(console.error);

