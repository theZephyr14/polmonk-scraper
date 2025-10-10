const { chromium } = require('playwright');

async function testBrowserless() {
    console.log('🔍 Testing Browserless connection...');
    
    const browserWsUrl = 'wss://production-sfo.browserless.io?token=2TBdtRaSfCJdCtrf0150e386f6b4e285c10a465d3bcf4caf5';
    
    try {
        console.log('Connecting to:', browserWsUrl);
        const browser = await chromium.connectOverCDP(browserWsUrl);
        console.log('✅ Browserless connection successful!');
        
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto('https://google.com');
        console.log('✅ Page navigation successful!');
        
        await browser.close();
        console.log('✅ Test completed successfully!');
        
    } catch (error) {
        console.error('❌ Browserless test failed:', error.message);
        console.error('Full error:', error);
    }
}

testBrowserless();
