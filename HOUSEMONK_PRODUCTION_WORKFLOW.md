# HouseMonk Production Workflow Documentation

## 🏠 Essential Files for HouseMonk Production

### Core Scripts
- **`test_housemonk_production.js`** - Main production API test script
- **`test_direct_production_invoice.js`** - Direct invoice creation for production
- **`test_modules/housemonk_auth.js`** - Authentication and API client
- **`test_modules/invoice_creator.js`** - Invoice creation with file attachments
- **`test_modules/aws_uploader.js`** - File upload to AWS S3 via HouseMonk

### Data Files
- **`Book1 - test.xlsx`** - Property mapping data

## 🔧 HouseMonk Production Workflow

### 1. Authentication
```javascript
// Production credentials
const userToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1aWQiOiI2ODkxZGZiZjA1MmQxZDdmMzM2ZDBkNjIiLCJ0eXBlcyI6WyJhZG1pbiJdLCJpYXQiOjE3NTg1MzUzNjEsImV4cCI6MTc2NjMxMTM2MX0.wGHFL1Gd3cOODn6uHVcV5IbJ2xMZBoCoMmvydet8fRY";
const clientId = "1326bbe0-8ed1-11f0-b658-7dd414f87b53";
const baseUrl = "https://dashboard.thehousemonk.com";
```

### 2. Invoice Creation Process

#### Step 1: Get Unit Details
```javascript
const response = await axios.get(`${baseUrl}/api/home/${unitId}`, {
  headers: {
    "authorization": userToken,
    "x-api-key": clientId
  }
});
```

#### Step 2: Get Products and Tax Codes
```javascript
// Get products for the project
const products = await axios.get(`${baseUrl}/api/product-and-service?projects=${projectId}`, {
  headers: { "authorization": userToken, "x-api-key": clientId }
});

// Get tax codes for the project
const taxCodes = await axios.get(`${baseUrl}/api/tax?projects=${projectId}`, {
  headers: { "authorization": userToken, "x-api-key": clientId }
});
```

#### Step 3: Create Invoice
```javascript
const invoicePayload = {
  users: [unit.tenant?._id],
  type: "Invoice",
  transactionBelongsTo: "Home",
  home: unit._id,
  project: unit.project,
  listing: unit.listing,
  source: "api_external",
  status: "due", // or "draft"
  dueDate: dueDate,
  invoiceDate: today,
  taxable: true,
  totalAmount: amount,
  openingBalance: amount,
  currency: 'EUR',
  paymentTerms: '30',
  organization: unit.organization || unit.project,
  createdBy: "6891dfbf052d1d7f336d0d62",
  updatedBy: "6891dfbf052d1d7f336d0d62",
  itemDetails: [{
    amount: amount,
    taxable: true,
    taxAmount: 0,
    netAmount: amount,
    description: `Utilities Overuse - Test Period`,
    quantity: 1,
    billedAt: "none",
    addConvenienceFee: false,
    convenienceFee: 0,
    convenienceFeeType: "fixed",
    product: utilityProduct._id,
    rate: amount,
    unit: "unit",
    taxCode: taxCode._id
  }],
  notes: `Generated from Polaroo overuse analysis for Test Period - ${propertyName}`
};

const response = await axios.post(`${baseUrl}/api/transaction`, invoicePayload, {
  headers: {
    "authorization": userToken,
    "x-api-key": clientId,
    "content-type": "application/json"
  }
});
```

### 3. File Upload Process

#### Step 1: Get Presigned URL
```javascript
const presignedResponse = await axios.post(`${baseUrl}/api/document/presigned`, {
  fileName: fileName
}, {
  headers: {
    "authorization": userToken,
    "x-api-key": clientId
  }
});
```

#### Step 2: Upload to S3
```javascript
await axios.put(presignedResponse.data.url, fileBuffer, {
  headers: { 'Content-Type': contentType }
});
```

#### Step 3: Attach Files to Invoice
```javascript
const files = [{
  objectKey: presignedResponse.data.objectKey,
  status: 'active',
  organizations: ['6715f9742b22a37e2a4a2bca'],
  newBucket: true,
  project: [],
  isDataDummy: false,
  shared: false,
  myMemories: false,
  success: true,
  message: '',
  fileName: fileName,
  fileFormat: contentType
}];

// Attach files to invoice
await axios.patch(`${baseUrl}/api/transaction/${invoiceId}`, { files });
```

## 🚀 How to Use

### Test Production API
```bash
node test_housemonk_production.js
```

### Create Direct Invoice
```bash
node test_direct_production_invoice.js
```

### Use Authentication Module
```javascript
const { HouseMonkAuth, HouseMonkIDResolver } = require('./test_modules/housemonk_auth');
const { createInvoiceForOveruse } = require('./test_modules/invoice_creator');

// Set environment to production
process.env.HM_ENVIRONMENT = 'production';

const auth = new HouseMonkAuth();
await auth.refreshMasterToken();
await auth.getUserAccessToken(auth.config.userId);

const resolver = new HouseMonkIDResolver(auth);

// Create invoice
const result = await createInvoiceForOveruse(auth, resolver, propertyData, pdfFiles, jsonFiles);
```

## 📋 Key Points

1. **Authentication**: Uses direct user token and client ID for production
2. **Invoice Creation**: Requires unit ID, project ID, products, and tax codes
3. **File Upload**: Uses presigned URLs to upload to S3, then attaches to invoice
4. **Status**: Use "due" for invoices that need to be paid, "draft" for review
5. **Error Handling**: 401 errors indicate permission issues, not API problems

## 🔍 Troubleshooting

- **401 Errors**: Check user token and client ID
- **Missing Products**: Ensure project has products configured
- **File Upload Issues**: Check presigned URL validity (2-hour expiry)
- **Invoice Creation Fails**: Verify unit ID exists and has required fields

## 📊 Production Environment

- **Base URL**: `https://dashboard.thehousemonk.com`
- **Client ID**: `1326bbe0-8ed1-11f0-b658-7dd414f87b53`
- **User ID**: `6891dfbf052d1d7f336d0d62`
- **Total Units**: 1,162 properties available
