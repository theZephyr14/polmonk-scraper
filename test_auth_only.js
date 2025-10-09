const { HouseMonkAuth, HouseMonkIDResolver } = require('./test_modules/housemonk_auth');

async function testAuth() {
    console.log('🔐 Testing HouseMonk Authentication...');
    console.log('=' .repeat(50));
    
    try {
        // Test 1: Authentication
        console.log('\n🔄 Step 1: Getting master token...');
        const auth = new HouseMonkAuth();
        await auth.refreshMasterToken();
        console.log('✅ Master token obtained');
        
        console.log('\n🔄 Step 2: Getting user token...');
        await auth.getUserAccessToken(auth.config.userId);
        console.log('✅ User token obtained');
        
        // Test 2: API Call
        console.log('\n🔄 Step 3: Testing API call...');
        const response = await auth.makeAuthenticatedRequest('GET', '/api/home');
        console.log(`✅ API call successful - found ${response.data.rows?.length || 0} units`);
        
        // Test 3: ID Resolution
        console.log('\n🔄 Step 4: Testing ID resolution...');
        const resolver = new HouseMonkIDResolver(auth);
        const units = await resolver.getAvailableUnits();
        console.log(`✅ Found ${units.length} available units`);
        
        if (units.length > 0) {
            console.log('\n📋 Sample units:');
            units.slice(0, 3).forEach((unit, i) => {
                console.log(`  ${i+1}. ${unit.name} (Project: ${unit.project})`);
            });
        }
        
        console.log('\n🎉 All authentication tests passed!');
        console.log('✅ The HouseMonk integration is ready to use.');
        console.log('\nNext steps:');
        console.log('1. Set environment variables: POLAROO_EMAIL, POLAROO_PASSWORD, BROWSER_WS_URL');
        console.log('2. Run: node test_housemonk_integration.js');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.response?.data) {
            console.error('Response data:', error.response.data);
        }
    }
}

testAuth();

