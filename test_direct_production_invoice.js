const axios = require("axios");

// Direct production test using the working integration approach
class DirectProductionInvoiceTest {
  constructor() {
    this.userToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiI2ODkxZGZiZjA1MmQxZDdmMzM2ZDBkNjIiLCJ0eXBlcyI6WyJhZG1pbiJdLCJpYXQiOjE3NTg1MzUzNjEsImV4cCI6MTc2NjMxMTM2MX0.wGHFL1Gd3cOODn6uHVcV5IbJ2xMZBoCoMmvydet8fRY";
    this.clientId = "1326bbe0-8ed1-11f0-b658-7dd414f87b53";
    this.baseUrl = "https://dashboard.thehousemonk.com";
  }

  async getUnitDetails(unitId) {
    try {
      console.log(`🔍 Getting details for unit: ${unitId}`);
      const response = await axios.get(`${this.baseUrl}/api/home/${unitId}`, {
        headers: {
          "authorization": this.userToken,
          "x-api-key": this.clientId
        }
      });
      console.log(`✅ Unit found: ${response.data.name || response.data.address}`);
      return response.data;
    } catch (error) {
      console.log(`❌ Failed to get unit details: ${error.response?.data?.message || error.message}`);
      return null;
    }
  }

  async getProducts(projectId) {
    try {
      const response = await axios.get(`${this.baseUrl}/api/product-and-service?projects=${projectId}`, {
        headers: {
          "authorization": this.userToken,
          "x-api-key": this.clientId
        }
      });
      return response.data.rows;
    } catch (error) {
      console.log(`❌ Failed to get products: ${error.response?.data?.message || error.message}`);
      return [];
    }
  }

  async getTaxCodes(projectId) {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tax?projects=${projectId}`, {
        headers: {
          "authorization": this.userToken,
          "x-api-key": this.clientId
        }
      });
      return response.data.rows;
    } catch (error) {
      console.log(`❌ Failed to get tax codes: ${error.response?.data?.message || error.message}`);
      return [];
    }
  }

  async createInvoice(propertyName, amount, unitId) {
    try {
      console.log(`\n📝 Creating invoice for ${propertyName} (€${amount})...`);
      
      // Get unit details
      const unit = await this.getUnitDetails(unitId);
      if (!unit) {
        console.log(`❌ Unit ${unitId} not found`);
        return null;
      }

      // Get products and tax codes
      const products = await this.getProducts(unit.project);
      const taxCodes = await this.getTaxCodes(unit.project);
      
      if (products.length === 0) {
        console.log(`❌ No products found for project ${unit.project}`);
        return null;
      }
      
      if (taxCodes.length === 0) {
        console.log(`❌ No tax codes found for project ${unit.project}`);
        return null;
      }

      const today = new Date().toISOString().split("T")[0];
      const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const invoicePayload = {
        users: [unit.tenant?._id || unit.tenant],
        type: "Invoice",
        transactionBelongsTo: "Home",
        home: unit._id,
        project: unit.project,
        listing: unit.listing,
        source: "api_external",
        status: "draft",
        dueDate: dueDate,
        invoiceDate: today,
        taxable: true,
        totalAmount: amount,
        openingBalance: amount,
        itemDetails: [{
          amount: amount,
          taxable: true,
          taxAmount: 0,
          netAmount: amount,
          description: `Test Invoice - ${propertyName}`,
          quantity: 1,
          billedAt: "none",
          addConvenienceFee: false,
          convenienceFee: 0,
          convenienceFeeType: "fixed",
          product: products[0]._id, // Use first available product
          rate: amount,
          unit: "unit",
          taxCode: taxCodes[0]._id // Use first available tax code
        }],
        notes: `Test invoice created for ${propertyName} - Amount: €${amount}`
      };

      console.log(`📋 Invoice payload prepared with product: ${products[0].name} and tax: ${taxCodes[0].name || taxCodes[0]._id}`);

      const response = await axios.post(`${this.baseUrl}/api/transaction`, invoicePayload, {
        headers: {
          "authorization": this.userToken,
          "x-api-key": this.clientId,
          "content-type": "application/json"
        }
      });
      
      console.log(`✅ Invoice created successfully: ${response.data._id}`);
      return response.data;
    } catch (error) {
      console.log(`❌ Failed to create invoice: ${error.response?.data?.message || error.message}`);
      if (error.response?.data) {
        console.log(`📋 Error details:`, JSON.stringify(error.response.data, null, 2));
      }
      return null;
    }
  }

  async run() {
    console.log("🧪 Testing invoice creation for specific units in PRODUCTION...");
    console.log("=" .repeat(60));
    
    // Test data - unit IDs and amounts
    const testUnits = [
      { id: '683933a7215de52a34b22a05', amount: 22 },
      { id: '67b30e1d77535c26171da829', amount: 33 },
      { id: '6784d82d3f4e941da109026c', amount: 44 },
      { id: '68c128947d2c005eb0a1c3aa', amount: 55 }
    ];
    
    const results = [];
    
    for (let i = 0; i < testUnits.length; i++) {
      const unit = testUnits[i];
      console.log(`\n🏠 Processing unit ${i + 1}/4: ${unit.id} (€${unit.amount})`);
      
      const invoice = await this.createInvoice(
        `Test Property ${i + 1}`,
        unit.amount,
        unit.id
      );
      
      if (invoice) {
        results.push({
          unitId: unit.id,
          amount: unit.amount,
          invoiceId: invoice._id,
          status: "success"
        });
      } else {
        results.push({
          unitId: unit.id,
          amount: unit.amount,
          status: "failed"
        });
      }
      
      // Small delay between invoices
      if (i < testUnits.length - 1) {
        console.log('⏳ Waiting 2 seconds before next invoice...');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Summary
    console.log("\n📊 FINAL RESULTS:");
    console.table(results);
    
    const successful = results.filter(r => r.status === "success").length;
    console.log(`✅ Successfully created: ${successful}/${testUnits.length} invoices`);
    
    return results;
  }
}

// Run the test
const test = new DirectProductionInvoiceTest();
test.run();
