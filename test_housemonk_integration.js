const fs = require('fs');
const { HouseMonkAuth, HouseMonkIDResolver } = require('./test_modules/housemonk_auth');
const { downloadPdfsForProperty } = require('./test_modules/pdf_downloader');
const { uploadPdfAndMetadata } = require('./test_modules/aws_uploader');
const { createInvoiceForOveruse } = require('./test_modules/invoice_creator');

// Load environment variables
const BROWSER_WS_URL = process.env.BROWSER_WS_URL || 'wss://production-sfo.browserless.io/';
const POLAROO_EMAIL = process.env.POLAROO_EMAIL || '';
const POLAROO_PASSWORD = process.env.POLAROO_PASSWORD || '';

async function main() {
    console.log('🚀 Starting HouseMonk Integration Test');
    console.log('=' .repeat(60));
    console.log('📁 Loading test_overuse_data.json...');
    
    // Check if test data file exists
    if (!fs.existsSync('test_overuse_data.json')) {
        console.error('❌ test_overuse_data.json not found!');
        console.error('Please run the main app, process properties, and click "Export Overuse Data" button');
        process.exit(1);
    }
    
    // Load test data
    const testData = JSON.parse(fs.readFileSync('test_overuse_data.json', 'utf8'));
    console.log(`✅ Loaded ${testData.length} properties with overuse`);
    
    // Validate environment variables
    if (!POLAROO_EMAIL || !POLAROO_PASSWORD) {
        console.error('❌ Missing POLAROO_EMAIL or POLAROO_PASSWORD environment variables');
        process.exit(1);
    }
    
    // Initialize HouseMonk auth
    console.log('\n🔐 Initializing HouseMonk authentication (sandbox)...');
    console.log('=' .repeat(60));
    const auth = new HouseMonkAuth();
    await auth.refreshMasterToken();
    await auth.getUserAccessToken(auth.config.userId);
    console.log('✅ Authentication successful');
    
    const resolver = new HouseMonkIDResolver(auth);
    
    const results = [];
    
    // Process each property
    console.log('\n📄 Processing Properties...');
    console.log('=' .repeat(60));
    
    for (let i = 0; i < testData.length; i++) {
        const prop = testData[i];
        console.log(`\n[${i+1}/${testData.length}] ${prop.property}`);
        console.log(`💰 Overuse: ${prop.overuse_amount.toFixed(2)} €`);
        console.log(`🏠 Rooms: ${prop.rooms}`);
        console.log(`📋 Selected bills: ${(prop.selected_bills || []).length}`);
        
        try {
            // 1. Download PDFs from Polaroo
            console.log('\n📥 Step 1: Downloading PDFs from Polaroo...');
            const pdfs = await downloadPdfsForProperty(
                prop.property,
                prop.selected_bills || [],
                BROWSER_WS_URL,
                POLAROO_EMAIL,
                POLAROO_PASSWORD
            );
            console.log(`✅ Downloaded ${pdfs.length} PDFs`);
            
            if (pdfs.length === 0) {
                console.warn('⚠️ No PDFs downloaded - skipping this property');
                results.push({
                    property: prop.property,
                    status: 'skipped',
                    reason: 'No PDFs downloaded'
                });
                continue;
            }
            
            // 2. Upload to HouseMonk AWS
            console.log('\n☁️ Step 2: Uploading to HouseMonk AWS S3...');
            const uploadResults = [];
            for (const pdf of pdfs) {
                const result = await uploadPdfAndMetadata(auth, pdf.buffer, pdf.fileName, prop);
                uploadResults.push(result);
            }
            console.log(`✅ Uploaded ${uploadResults.length} PDFs with metadata`);
            
            // 3. Create invoice
            console.log('\n📝 Step 3: Creating invoice in HouseMonk...');
            const invoice = await createInvoiceForOveruse(
                auth,
                resolver,
                prop,
                uploadResults.map(r => r.pdfObjectKey),
                uploadResults.flatMap(r => r.jsonObjectKeys)
            );
            console.log(`✅ Invoice created successfully!`);
            
            results.push({
                property: prop.property,
                status: 'success',
                invoiceId: invoice._id,
                pdfCount: pdfs.length,
                overuseAmount: prop.overuse_amount,
                awsObjectKeys: uploadResults,
                invoiceUrl: `https://qa1.thehousemonk.com/dashboard/transactions/${invoice._id}`
            });
            
            console.log(`🎉 Completed ${prop.property}`);
            
        } catch (error) {
            console.error(`\n❌ Failed: ${error.message}`);
            if (error.stack) {
                console.error(error.stack);
            }
            results.push({
                property: prop.property,
                status: 'failed',
                error: error.message
            });
        }
        
        // Delay between properties (Browserless throttle)
        if (i < testData.length - 1) {
            const delaySeconds = 30;
            console.log(`\n⏳ Waiting ${delaySeconds}s before next property...`);
            await new Promise(r => setTimeout(r, delaySeconds * 1000));
        }
    }
    
    // Save results
    fs.writeFileSync('test_housemonk_results.json', JSON.stringify(results, null, 2));
    
    // Print summary
    console.log(`\n${'='.repeat(60)}`);
    console.log('🎉 TEST COMPLETE');
    console.log(`${'='.repeat(60)}`);
    
    const successful = results.filter(r => r.status === 'success');
    const failed = results.filter(r => r.status === 'failed');
    const skipped = results.filter(r => r.status === 'skipped');
    
    console.log(`✅ Success: ${successful.length}`);
    console.log(`❌ Failed: ${failed.length}`);
    console.log(`⏭️ Skipped: ${skipped.length}`);
    
    console.log('\n📁 Results saved to test_housemonk_results.json');
    
    if (successful.length > 0) {
        console.log('\n🔗 Created Invoices:');
        successful.forEach((r, i) => {
            console.log(`  ${i+1}. ${r.property}: ${r.invoiceUrl}`);
        });
    }
    
    if (failed.length > 0) {
        console.log('\n❌ Failed Properties:');
        failed.forEach((r, i) => {
            console.log(`  ${i+1}. ${r.property}: ${r.error}`);
        });
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

