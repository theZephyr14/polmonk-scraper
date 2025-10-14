const { HouseMonkAuth } = require('../test_modules/housemonk_auth');

async function run() {
    try {
        const auth = new HouseMonkAuth();
        await auth.refreshMasterToken();
        await auth.getUserAccessToken(auth.config.userId);

        const limit = Number(process.argv[2]) || 100; // default first 100
        const offset = Number(process.argv[3]) || 0;  // start at 0

        console.log(`🔎 Listing homes ${offset}..${offset + limit - 1}`);

        // Fetch homes
        const res = await auth.makeAuthenticatedRequest('GET', `/api/home?limit=${limit}&offset=${offset}&sort=createdAt`, null, true);
        const rows = Array.isArray(res.data?.rows) ? res.data.rows : (Array.isArray(res.data) ? res.data : []);

        if (!rows.length) {
            console.log('No homes found');
            return;
        }

        // Map: name (or address) and ids
        const list = rows.map(h => ({
            id: h._id || h.id,
            name: h.name || h.propertyName || h.addressLine || h.displayName || 'Unnamed',
            listing: (typeof h.listing === 'object') ? (h.listing?._id || h.listing?.id) : (h.listing || null),
            project: (typeof h.project === 'object') ? (h.project?._id || h.project?.id) : (h.project || null)
        }));

        console.table(list);
        console.log(`Count: ${list.length}`);

    } catch (err) {
        console.error('❌ Failed:', err.response?.data?.message || err.message);
        if (err.response?.data) {
            console.error('📋 Details:', JSON.stringify(err.response.data, null, 2));
        }
        process.exit(1);
    }
}

run();


