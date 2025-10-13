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

function detectContentType(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (lower.endsWith('.pdf')) return 'application/pdf';
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
}

// Create/register a THM Document for an uploaded objectKey
async function createHouseMonkDocument(auth, { objectKey, fileName, fileFormat, status = 'active' }) {
    const body = { objectKey, fileName, fileFormat, status };
    const res = await auth.makeAuthenticatedRequest('POST', '/api/document', body, true);
    return res.data;
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
        // 1. Upload the main file (PDF or JSON)
        const contentType = detectContentType(fileName);
        const mainPresigned = await getPresignedUrl(auth, fileName);
        await uploadToS3(mainPresigned.url, pdfBuffer, contentType);
        mainPresigned.status = mainPresigned.status || 'active';
        mainPresigned.fileName = fileName;
        mainPresigned.fileFormat = contentType;
        console.log(`    ✅ Uploaded: ${mainPresigned.objectKey}`);

        // 2. Register the uploaded file as a THM Document
        const registeredMain = await createHouseMonkDocument(auth, {
            objectKey: mainPresigned.objectKey,
            fileName: mainPresigned.fileName,
            fileFormat: mainPresigned.fileFormat,
            status: mainPresigned.status
        });
        
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
        const summaryName = `${sanitize(overuseData.property)}_summary.json`;
        const summaryPresigned = await getPresignedUrl(auth, summaryName);
        await uploadToS3(summaryPresigned.url, Buffer.from(JSON.stringify(summary, null, 2)), 'application/json');
        summaryPresigned.status = summaryPresigned.status || 'active';
        summaryPresigned.fileName = summaryName;
        summaryPresigned.fileFormat = 'application/json';
        const summaryDoc = await createHouseMonkDocument(auth, {
            objectKey: summaryPresigned.objectKey,
            fileName: summaryPresigned.fileName,
            fileFormat: summaryPresigned.fileFormat,
            status: summaryPresigned.status
        });
        jsonObjectKeys.push(summaryPresigned.objectKey);
        jsonDocuments.push(summaryDoc);
        console.log(`    ✅ Summary JSON uploaded: ${summaryPresigned.objectKey}`);
        
        // Selected bills JSON
        if (overuseData.selected_bills && overuseData.selected_bills.length > 0) {
            const billsName = `${sanitize(overuseData.property)}_bills.json`;
            const billsPresigned = await getPresignedUrl(auth, billsName);
            await uploadToS3(billsPresigned.url, Buffer.from(JSON.stringify(overuseData.selected_bills, null, 2)), 'application/json');
            billsPresigned.status = billsPresigned.status || 'active';
            billsPresigned.fileName = billsName;
            billsPresigned.fileFormat = 'application/json';
            const billsDoc = await createHouseMonkDocument(auth, {
                objectKey: billsPresigned.objectKey,
                fileName: billsPresigned.fileName,
                fileFormat: billsPresigned.fileFormat,
                status: billsPresigned.status
            });
            jsonObjectKeys.push(billsPresigned.objectKey);
            jsonDocuments.push(billsDoc);
            console.log(`    ✅ Bills JSON uploaded: ${billsPresigned.objectKey}`);
        }
        
        // Monthly overuse JSON (if available)
        if (overuseData.monthly_overuse && overuseData.monthly_overuse.length > 0) {
            const monthlyName = `${sanitize(overuseData.property)}_monthly.json`;
            const monthlyPresigned = await getPresignedUrl(auth, monthlyName);
            await uploadToS3(monthlyPresigned.url, Buffer.from(JSON.stringify(overuseData.monthly_overuse, null, 2)), 'application/json');
            monthlyPresigned.status = monthlyPresigned.status || 'active';
            monthlyPresigned.fileName = monthlyName;
            monthlyPresigned.fileFormat = 'application/json';
            const monthlyDoc = await createHouseMonkDocument(auth, {
                objectKey: monthlyPresigned.objectKey,
                fileName: monthlyPresigned.fileName,
                fileFormat: monthlyPresigned.fileFormat,
                status: monthlyPresigned.status
            });
            jsonObjectKeys.push(monthlyPresigned.objectKey);
            jsonDocuments.push(monthlyDoc);
            console.log(`    ✅ Monthly overuse JSON uploaded: ${monthlyPresigned.objectKey}`);
        }
        // If the main file is a JSON, treat it as metadata (rare path)
        const isJsonMain = contentType === 'application/json';
        if (isJsonMain) {
            return {
                pdfObjectKey: undefined,
                jsonObjectKeys: [mainPresigned.objectKey, ...jsonObjectKeys],
                pdfDocument: undefined,
                jsonDocuments: [registeredMain, ...jsonDocuments]
            };
        }

        // Normal PDF main file
        return {
            pdfObjectKey: mainPresigned.objectKey,
            jsonObjectKeys,
            pdfDocument: registeredMain,
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

module.exports = { uploadPdfAndMetadata, getPresignedUrl, uploadToS3, createHouseMonkDocument };

