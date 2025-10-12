const { HouseMonkAuth } = require('./test_modules/housemonk_auth');

async function getProperties800to900() {
    console.log('🔍 Fetching properties 800-900 from HouseMonk...');

    const auth = new HouseMonkAuth();

    try {
        // Initialize auth
        await auth.refreshMasterToken();
        await auth.getUserAccessToken(auth.config.userId);
        console.log('✅ HouseMonk Authentication successful');

        // Calculate page number for properties 800-900
        // Page 9 would be 800-900 (page 8 is 700-800, page 9 is 800-900)
        const pageNumber = 9; // Page 9 for properties 800-900
        const limit = 100;
        
        console.log(`📋 Fetching page ${pageNumber} (properties ${(pageNumber-1)*100 + 1} to ${pageNumber*100})...`);
        
        const response = await auth.makeAuthenticatedRequest('GET', `/api/home?limit=${limit}&page=${pageNumber}`, null, true);
        const homes = response.data.rows;
        
        console.log(`✅ Found ${homes.length} homes in this page.`);
        console.log(`📊 Total homes available: ${response.data.count}`);

        console.log('\n--- Properties 800-900 in HouseMonk ---');
        console.log('Index | Property Name | Unit ID');
        console.log('------|---------------|---------');

        homes.forEach((home, index) => {
            const globalIndex = (pageNumber - 1) * limit + index + 1;
            const name = home.name || 'No Name';
            const unitId = home._id;
            
            console.log(`${globalIndex.toString().padStart(5)} | ${name.padEnd(13)} | ${unitId}`);
        });

        console.log('\n--- Summary ---');
        console.log(`📊 Properties in this range: ${homes.length}`);
        
        // Group by name to see if there are different property types
        const nameGroups = {};
        homes.forEach(home => {
            const name = home.name || 'No Name';
            if (!nameGroups[name]) {
                nameGroups[name] = [];
            }
            nameGroups[name].push(home._id);
        });

        console.log('\n--- Properties by Name ---');
        for (const [name, ids] of Object.entries(nameGroups)) {
            console.log(`📋 "${name}" (${ids.length} properties)`);
            if (ids.length <= 5) {
                ids.forEach(id => console.log(`     ${id}`));
            } else {
                console.log(`     ${ids.slice(0, 3).join(', ')}... and ${ids.length - 3} more`);
            }
        }

        // Show unique names
        const uniqueNames = Object.keys(nameGroups);
        console.log(`\n📊 Unique property names in this range: ${uniqueNames.length}`);
        console.log('Unique names:', uniqueNames);

    } catch (error) {
        console.error('❌ Failed to fetch properties:', error.response?.data?.message || error.message);
        if (error.response?.data) {
            console.error('📋 Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

getProperties800to900();
