const { HouseMonkAuth } = require('../test_modules/housemonk_auth');

(async () => {
    try {
        const inputId = process.argv[2] || '687519da8b627233fbe419ef';
        console.log('🔧 Test: Create single invoice to target id:', inputId);

        // 1) Auth (user token)
        const auth = new HouseMonkAuth();
        await auth.refreshMasterToken();
        await auth.getUserAccessToken(auth.config.userId);
        console.log('✅ Auth ready');

        // 2) Fetch latest uploaded PDF document
        console.log('🔎 Fetching latest PDF document...');
        // Fetch several recent documents then pick a PDF explicitly
        const docsRes = await auth.makeAuthenticatedRequest(
            'GET',
            '/api/document?limit=10&sort=-createdAt',
            null,
            true
        );
        const rows = Array.isArray(docsRes.data?.rows) ? docsRes.data.rows : (Array.isArray(docsRes.data) ? docsRes.data : []);
        const latestDoc = rows.find(d => (d.fileFormat === 'application/pdf') || String(d.objectKey || '').toLowerCase().endsWith('.pdf'));
        if (!latestDoc || !latestDoc.objectKey) {
            throw new Error('Could not find a recently uploaded PDF document to attach');
        }
        console.log('📎 Latest PDF:', latestDoc.objectKey);

        // 3) Get listing details to resolve home/project (and organization)
        // Resolve project/home/listing from either a listing id or a home id
        let listingId;
        let homeId;
        let projectId;
        let organizationId;
        
        async function extractIdsFromListing(listing) {
            const project = listing.project || listing.projects?.[0] || listing.projectId;
            const home = listing.home || listing.homes?.[0] || listing.homeId;
            const org = listing.organization || listing.organizations?.[0];
            return {
                listingId: listing._id || listing.id,
                projectId: typeof project === 'object' ? (project._id || project.id) : project,
                homeId: typeof home === 'object' ? (home._id || home.id) : home,
                organizationId: typeof org === 'object' ? (org._id || org.id) : org
            };
        }

        // First try as listing
        try {
            console.log('🏷️ Trying target as listing...');
            const listingRes = await auth.makeAuthenticatedRequest('GET', `/api/listing/${inputId}`, null, true);
            if (listingRes?.data) {
                const ids = await extractIdsFromListing(listingRes.data);
                listingId = ids.listingId;
                homeId = ids.homeId;
                projectId = ids.projectId;
                organizationId = ids.organizationId;
            }
        } catch (_) {}

        // If not a listing, try as home and find a listing for that home
        if (!homeId || !projectId) {
            console.log('🏠 Trying target as home...');
            const homeRes = await auth.makeAuthenticatedRequest('GET', `/api/home/${inputId}`, null, true);
            const home = homeRes.data;
            if (!home) throw new Error('Target id is neither a valid listing nor a home');
            homeId = home._id || home.id || inputId;
            const proj = home.project || home.projects?.[0] || home.projectId;
            projectId = typeof proj === 'object' ? (proj._id || proj.id) : proj;
            const org = home.organization || home.organizations?.[0];
            organizationId = typeof org === 'object' ? (org._id || org.id) : org;

            // Find any listing for this home (optional)
            try {
                const listRes = await auth.makeAuthenticatedRequest('GET', `/api/listing?homes=${homeId}&limit=1`, null, true);
                const row = Array.isArray(listRes.data?.rows) ? listRes.data.rows[0] : (Array.isArray(listRes.data) ? listRes.data[0] : null);
                if (row) {
                    const ids = await extractIdsFromListing(row);
                    listingId = ids.listingId;
                    // Prefer project/organization from listing if available
                    projectId = ids.projectId || projectId;
                    organizationId = ids.organizationId || organizationId;
                }
            } catch (e) {
                // Listing may not exist; that's fine
            }
        }

        if (!homeId || !projectId) {
            throw new Error('Could not resolve required home/project identifiers');
        }
        console.log('🔗 Resolved:', { listingId, projectId, homeId, organizationId });

        // 4) Get a tax code for the project
        console.log('💰 Fetching tax codes...');
        const taxRes = await auth.makeAuthenticatedRequest('GET', `/api/tax?projects=${projectId}`, null, true);
        const taxCode = Array.isArray(taxRes.data?.rows) ? taxRes.data.rows[0] : (Array.isArray(taxRes.data) ? taxRes.data[0] : null);
        if (!taxCode) throw new Error('No tax code available for project');

        // 5) Build files array using Badri structure
        const files = [{
            status: 'active',
            organizations: latestDoc.organizations || (organizationId ? [organizationId] : []),
            newBucket: latestDoc.newBucket ?? true,
            project: latestDoc.project || [],
            isDataDummy: latestDoc.isDataDummy ?? false,
            shared: latestDoc.shared ?? false,
            myMemories: latestDoc.myMemories ?? false,
            _id: latestDoc._id,
            success: latestDoc.success ?? true,
            message: latestDoc.message ?? '',
            url: latestDoc.url,
            fileFormat: latestDoc.fileFormat || 'application/pdf',
            fileName: latestDoc.fileName || 'attachment.pdf',
            objectKey: latestDoc.objectKey,
            createdBy: latestDoc.createdBy,
            updatedBy: latestDoc.updatedBy,
            uploadedBy: latestDoc.uploadedBy,
            uid: latestDoc.uid,
            createdAt: latestDoc.createdAt,
            updatedAt: latestDoc.updatedAt,
            __v: latestDoc.__v || 0,
            id: latestDoc.id || latestDoc._id
        }];

        // 6) Build minimal invoice payload
        const today = new Date().toISOString().split('T')[0];
        const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const amount = 1; // test amount

        const payload = {
            type: 'Invoice',
            transactionBelongsTo: 'Home',
            home: homeId,
            project: projectId,
            listing: listingId,
            source: 'api_external',
            status: 'due',
            invoiceDate: today,
            dueDate,
            taxable: true,
            totalAmount: amount,
            openingBalance: amount,
            currency: 'EUR',
            paymentTerms: '30',
            organization: organizationId || projectId,
            createdBy: auth.config.userId,
            updatedBy: auth.config.userId,
            itemDetails: [{
                amount,
                taxable: true,
                taxAmount: 0,
                netAmount: amount,
                description: `Test invoice for listing ${listingId}`,
                quantity: 1,
                billedAt: 'none',
                addConvenienceFee: false,
                convenienceFee: 0,
                convenienceFeeType: 'fixed',
                product: undefined,
                rate: amount,
                unit: 'unit',
                taxCode: taxCode._id || taxCode.id
            }],
            files
        };

        // Remove undefined keys
        Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
        if (payload.itemDetails?.[0]) {
            Object.keys(payload.itemDetails[0]).forEach(k => payload.itemDetails[0][k] === undefined && delete payload.itemDetails[0][k]);
        }

        console.log('📤 Creating invoice with payload (truncated):');
        console.log(JSON.stringify({ ...payload, files: files.map(f => ({ objectKey: f.objectKey, fileName: f.fileName })) }, null, 2));

        // 7) Create invoice
        const createRes = await auth.makeAuthenticatedRequest('POST', '/api/transaction', payload, true);
        const invoiceId = createRes.data?._id;
        console.log('✅ Invoice created:', invoiceId);

        // 8) Verify/attach files if missing
        const current = await auth.makeAuthenticatedRequest('GET', `/api/transaction/${invoiceId}`, null, true);
        const attached = Array.isArray(current.data?.files) ? current.data.files.length : 0;
        if (attached === 0 && files.length > 0) {
            console.log('📎 No files attached after create. Attaching via PUT...');
            const putRes = await auth.makeAuthenticatedRequest('PUT', `/api/transaction/${invoiceId}`, { files }, true);
            console.log('📎 Attach via PUT result (files length):', Array.isArray(putRes.data?.files) ? putRes.data.files.length : 'unknown');
        }

        console.log('🎉 Done');
    } catch (err) {
        console.error('❌ Test failed:', err.response?.data?.message || err.message);
        if (err.response?.data) {
            console.error('📋 Details:', JSON.stringify(err.response.data, null, 2));
        }
        process.exit(1);
    }
})();


