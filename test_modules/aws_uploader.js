const axios = require('axios');

// Get presigned URL from HouseMonk
async function getPresignedUrl(auth, fileName) {
    const response = await auth.makeAuthenticatedRequest(
        'POST',
        '/api/document/presigned',
        { fileName },
        true // use user token – required for presign
    );
    return response.data; // { url, objectKey, fileName, fileFormat, ... }
}

// Upload to S3 using presigned URL
async function uploadToS3(presignedUrl, buffer, contentType) {
    await axios.put(presignedUrl, buffer, {
        headers: { 'Content-Type': contentType }
    });
}

// Upload PDF and associated JSON metadata files
async function uploadPdfAndMetadata(auth, pdfBuffer, fileName, overuseData) {
    console.log(`  ☁️ Uploading ${fileName} to HouseMonk AWS...`);
    
    try {
        // 1. Upload PDF
        const pdfPresigned = await getPresignedUrl(auth, fileName);
        await uploadToS3(pdfPresigned.url, pdfBuffer, 'application/pdf');
        // normalize fields for attaching to invoice later
        pdfPresigned.status = pdfPresigned.status || 'active';
        pdfPresigned.fileName = fileName;
        pdfPresigned.fileFormat = 'application/pdf';
        console.log(`    ✅ PDF uploaded: ${pdfPresigned.objectKey}`);
        
        // 2. Upload JSON metadata files
        const jsonObjectKeys = [];
        const jsonDocuments = [];
        
        // Summary JSON
        const summary = {
            type: 'overuse_summary',
            property: overuseData.property,
            generatedAt: new Date().toISOString(),
            overuse: overuseData.overuse_amount,
            rooms: overuseData.rooms,
            electricityBills: overuseData.electricity_bills_count,
            waterBills: overuseData.water_bills_count,
            electricityCost: overuseData.electricity_cost,
            waterCost: overuseData.water_cost,
            period: overuseData.period || 'Unknown'
        };
        const summaryPresigned = await getPresignedUrl(auth, `${sanitize(overuseData.property)}_summary.json`);
        await uploadToS3(summaryPresigned.url, Buffer.from(JSON.stringify(summary, null, 2)), 'application/json');
        summaryPresigned.status = summaryPresigned.status || 'active';
        summaryPresigned.fileName = `${sanitize(overuseData.property)}_summary.json`;
        summaryPresigned.fileFormat = 'application/json';
        jsonObjectKeys.push(summaryPresigned.objectKey);
        jsonDocuments.push(summaryPresigned);
        console.log(`    ✅ Summary JSON uploaded: ${summaryPresigned.objectKey}`);
        
        // Selected bills JSON
        if (overuseData.selected_bills && overuseData.selected_bills.length > 0) {
            const billsPresigned = await getPresignedUrl(auth, `${sanitize(overuseData.property)}_bills.json`);
            await uploadToS3(billsPresigned.url, Buffer.from(JSON.stringify(overuseData.selected_bills, null, 2)), 'application/json');
            billsPresigned.status = billsPresigned.status || 'active';
            billsPresigned.fileName = `${sanitize(overuseData.property)}_bills.json`;
            billsPresigned.fileFormat = 'application/json';
            jsonObjectKeys.push(billsPresigned.objectKey);
            jsonDocuments.push(billsPresigned);
            console.log(`    ✅ Bills JSON uploaded: ${billsPresigned.objectKey}`);
        }
        
        // Monthly overuse JSON (if available)
        if (overuseData.monthly_overuse && overuseData.monthly_overuse.length > 0) {
            const monthlyPresigned = await getPresignedUrl(auth, `${sanitize(overuseData.property)}_monthly.json`);
            await uploadToS3(monthlyPresigned.url, Buffer.from(JSON.stringify(overuseData.monthly_overuse, null, 2)), 'application/json');
            monthlyPresigned.status = monthlyPresigned.status || 'active';
            monthlyPresigned.fileName = `${sanitize(overuseData.property)}_monthly.json`;
            monthlyPresigned.fileFormat = 'application/json';
            jsonObjectKeys.push(monthlyPresigned.objectKey);
            jsonDocuments.push(monthlyPresigned);
            console.log(`    ✅ Monthly overuse JSON uploaded: ${monthlyPresigned.objectKey}`);
        }
        
        return {
            // for backward compatibility
            pdfObjectKey: pdfPresigned.objectKey,
            jsonObjectKeys,
            // new full document objects for direct attachment
            pdfDocument: pdfPresigned,
            jsonDocuments
        };
        
    } catch (error) {
        console.error(`    ❌ Upload failed:`, error.response?.data?.message || error.message);
        throw error;
    }
}

// Sanitize filename
function sanitize(name) {
    return String(name || '').replace(/[^A-Za-z0-9_-]+/g, '_');
}

module.exports = { uploadPdfAndMetadata, getPresignedUrl, uploadToS3 };

