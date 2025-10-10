const axios = require("axios");

// Test AWS upload using the working logic from New try folder
class TestAWSUpload {
  constructor() {
    // Use the working credentials from the New try folder
    this.userToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiI2ODkxZGZiZjA1MmQxZDdmMzM2ZDBkNjIiLCJ0eXBlcyI6WyJhZG1pbiJdLCJpYXQiOjE3NTg1MzUzNjEsImV4cCI6MTc2NjMxMTM2MX0.wGHFL1Gd3cOODn6uHVcV5IbJ2xMZBoCoMmvydet8fRY";
    this.clientId = "1326bbe0-8ed1-11f0-b658-7dd414f87b53";
  }

  thmHeaders() {
    return { 
      authorization: this.userToken, 
      "x-api-key": this.clientId, 
      "content-type": "application/json" 
    };
  }

  async getPresigned(fileName) {
    console.log(`📄 Getting presigned URL for: ${fileName}`);
    const { data } = await axios.post(
      "https://dashboard.thehousemonk.com/api/document/presigned",
      { fileName },
      { headers: this.thmHeaders() }
    );
    console.log(`✅ Presigned URL obtained: ${data.objectKey}`);
    return data;
  }

  async putToS3(url, buffer, contentType) {
    console.log(`☁️ Uploading to S3...`);
    await axios.put(url, buffer, { 
      headers: { "Content-Type": contentType } 
    });
    console.log(`✅ Uploaded to S3 successfully`);
  }

  async uploadBufferAsFile({ buffer, fileName, contentType }) {
    const pre = await this.getPresigned(fileName);
    await this.putToS3(pre.url, buffer, contentType);
    return {
      ...pre,
      status: pre.status || "active",
      fileName,
      fileFormat: contentType,
    };
  }

  buildJsonBlobsForProperty(propertyName, overuseData) {
    const entry = Array.isArray(overuseData)
      ? overuseData.find(p => (p.property || "").toLowerCase() === (propertyName || "").toLowerCase())
      : null;

    const nowIso = new Date().toISOString();
    const files = [];

    const summary = {
      type: "overuse_summary",
      property: propertyName,
      generatedAt: nowIso,
      overage: entry?.overuse_amount ?? null,
      rooms: entry?.rooms ?? null,
    };
    files.push({ 
      name: `${this.sanitize(propertyName)}_summary.json`, 
      content: JSON.stringify(summary, null, 2) 
    });

    if (entry?.selected_bills) {
      files.push({ 
        name: `${this.sanitize(propertyName)}_selected_bills.json`, 
        content: JSON.stringify(entry.selected_bills, null, 2) 
      });
    }

    return files;
  }

  sanitize(name) {
    return String(name || "").replace(/[^A-Za-z0-9_\-]+/g, "_");
  }

  async testUpload() {
    console.log("🧪 Testing AWS Upload with Working Logic");
    console.log("=" .repeat(50));

    try {
      // Test data
      const testProperty = {
        property: "Aribau 1º 1ª",
        rooms: 1,
        overuse_amount: 188.24,
        selected_bills: [
          { "Service": "Electricity", "Final Date": "2023-01-31" },
          { "Service": "Water", "Final Date": "2023-01-31" }
        ]
      };

      console.log(`🏠 Testing with property: ${testProperty.property}`);

      // 1) Upload a mock PDF
      const mockPdfBuffer = Buffer.from('Mock PDF content for testing AWS upload');
      const pdfFileName = `${this.sanitize(testProperty.property)}_test.pdf`;
      
      console.log(`📄 Uploading PDF: ${pdfFileName}`);
      const pdfResult = await this.uploadBufferAsFile({ 
        buffer: mockPdfBuffer, 
        fileName: pdfFileName, 
        contentType: "application/pdf" 
      });

      // 2) Upload JSON metadata
      console.log(`📊 Uploading JSON metadata...`);
      const jsonFiles = this.buildJsonBlobsForProperty(testProperty.property, [testProperty]);
      const jsonResults = [];

      for (const jsonFile of jsonFiles) {
        const jsonBuffer = Buffer.from(jsonFile.content, "utf8");
        const jsonResult = await this.uploadBufferAsFile({ 
          buffer: jsonBuffer, 
          fileName: jsonFile.name, 
          contentType: "application/json" 
        });
        jsonResults.push(jsonResult);
      }

      // Results
      console.log("\n✅ UPLOAD SUCCESS!");
      console.log(`📄 PDF: ${pdfResult.objectKey}`);
      jsonResults.forEach(j => {
        console.log(`📊 JSON: ${j.objectKey} (${j.fileName})`);
      });

      return {
        success: true,
        pdf: { name: pdfFileName, objectKey: pdfResult.objectKey },
        jsons: jsonResults.map(x => ({ name: x.fileName, objectKey: x.objectKey }))
      };

    } catch (error) {
      console.error("❌ Upload failed:", error.response?.status, error.response?.data?.message || error.message);
      if (error.response?.data) {
        console.error("Details:", JSON.stringify(error.response.data, null, 2));
      }
      return { success: false, error: error.message };
    }
  }
}

// Run the test
const test = new TestAWSUpload();
test.testUpload().then(result => {
  console.log("\n📊 FINAL RESULT:");
  console.log(JSON.stringify(result, null, 2));
}).catch(err => {
  console.error("Fatal error:", err.message);
});
