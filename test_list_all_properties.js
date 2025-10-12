const { HouseMonkAuth } = require('./test_modules/housemonk_auth');

async function listAllProperties() {
    console.log('🔍 Fetching ALL properties from HouseMonk...');

    const auth = new HouseMonkAuth();

    try {
        await auth.refreshMasterToken();
        await auth.getUserAccessToken(auth.config.userId);
        console.log('✅ HouseMonk Authentication successful');

        const limit = 100; // Maximum per page
        let allHomes = [];
        let page = 1;
        let totalCount = 0;

        // Fetch all pages
        while (true) {
            console.log(`📋 Fetching page ${page}...`);
            const response = await auth.makeAuthenticatedRequest('GET', `/api/home?limit=${limit}&page=${page}`, null, true);
            const homes = response.data.rows;
            totalCount = response.data.count;
            
            if (homes.length === 0) {
                console.log('📄 No more properties found, stopping pagination');
                break;
            }
            
            allHomes = allHomes.concat(homes);
            console.log(`✅ Page ${page}: Found ${homes.length} properties (Total so far: ${allHomes.length})`);
            
            // If we got fewer than the limit, we're on the last page
            if (homes.length < limit) {
                console.log('📄 Last page reached');
                break;
            }
            
            page++;
            
            // Add a small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`\n✅ Total properties found: ${allHomes.length}`);
        console.log(`📊 Total available in HouseMonk: ${totalCount}`);

        console.log('\n--- ALL PROPERTIES IN HOUSEMONK ---');
        console.log('Index | Property Name | Unit ID | Address | Unit Code');
        console.log('------|---------------|---------|---------|----------');
        
        allHomes.forEach((home, index) => {
            const name = home.name || 'N/A';
            const id = home._id || 'N/A';
            const address = home.address || 'N/A';
            const unitCode = home.unitCode || 'N/A';
            console.log(`${String(index + 1).padStart(5)} | ${name.padEnd(13)} | ${id.padEnd(7)} | ${address.padEnd(20)} | ${unitCode}`);
        });

        console.log('\n--- PROPERTIES BY NAME (showing duplicates) ---');
        const nameCounts = {};
        allHomes.forEach(home => {
            const name = home.name || 'N/A';
            if (!nameCounts[name]) {
                nameCounts[name] = [];
            }
            nameCounts[name].push({
                id: home._id,
                unitCode: home.unitCode,
                address: home.address
            });
        });

        for (const name in nameCounts) {
            console.log(`\n📋 "${name}" (${nameCounts[name].length} properties):`);
            nameCounts[name].forEach(prop => {
                console.log(`     ID: ${prop.id} | UnitCode: ${prop.unitCode || 'N/A'} | Address: ${prop.address || 'N/A'}`);
            });
        }

        console.log('\n--- SUMMARY ---');
        console.log(`📊 Total properties: ${allHomes.length}`);
        console.log(`📊 Unique property names: ${Object.keys(nameCounts).length}`);
        
        // Find properties with unitCode
        const withUnitCode = allHomes.filter(home => home.unitCode);
        console.log(`📊 Properties with unitCode: ${withUnitCode.length}`);
        
        // Find Aribau properties
        const aribauProperties = allHomes.filter(home => 
            home.name && home.name.toLowerCase().includes('aribau')
        );
        console.log(`📊 Aribau properties: ${aribauProperties.length}`);
        
        if (aribauProperties.length > 0) {
            console.log('\n--- ARIBAU PROPERTIES FOUND ---');
            aribauProperties.forEach(prop => {
                console.log(`📋 "${prop.name}" | ID: ${prop._id} | UnitCode: ${prop.unitCode || 'N/A'}`);
            });
        }

        // Save to file for reference
        const fs = require('fs');
        const outputData = {
            totalCount: allHomes.length,
            properties: allHomes.map(home => ({
                name: home.name,
                id: home._id,
                unitCode: home.unitCode,
                address: home.address
            })),
            aribauProperties: aribauProperties.map(prop => ({
                name: prop.name,
                id: prop._id,
                unitCode: prop.unitCode,
                address: prop.address
            }))
        };
        
        fs.writeFileSync('all_housemonk_properties.json', JSON.stringify(outputData, null, 2));
        console.log('\n💾 Saved all properties to all_housemonk_properties.json');

    } catch (error) {
        console.error('❌ Failed to fetch properties:', error.response?.data?.message || error.message);
        if (error.response?.data) {
            console.error('📋 Details:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

listAllProperties();
