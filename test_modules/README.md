# HouseMonk Integration Test System

## Overview

This is a standalone testing system for the HouseMonk invoice integration. It operates completely separately from the main production code, allowing safe testing before integration.

## How It Works

1. **Run main app** → Process properties → Get overuse results
2. **Click "Export Overuse Data"** button → Creates `test_overuse_data.json`
3. **Run test script** → Downloads PDFs → Uploads to AWS → Creates invoices
4. **Verify in sandbox** → Check HouseMonk sandbox for created invoices

## Files

- `housemonk_auth.js` - Authentication & ID resolution for HouseMonk sandbox
- `pdf_downloader.js` - Download PDFs from Polaroo for selected bills
- `aws_uploader.js` - Upload PDFs and JSON metadata to HouseMonk AWS S3
- `invoice_creator.js` - Create invoices in HouseMonk for overuse

## Setup

### 1. Install Dependencies

```bash
npm install axios playwright
```

### 2. Set Environment Variables

On Render or locally:

```bash
BROWSER_WS_URL=wss://production-sfo.browserless.io/
POLAROO_EMAIL=your-email@example.com
POLAROO_PASSWORD=your-password
```

### 3. Generate Test Data

1. Deploy your app to Render (or run locally)
2. Upload Excel file with properties
3. Process properties
4. Click "📥 Export Overuse Data for HouseMonk Test" button
5. This creates `test_overuse_data.json` with up to 5 properties with overuse

### 4. Run Test

```bash
node test_housemonk_integration.js
```

## Test Output

The script will:
- Authenticate with HouseMonk sandbox
- For each property:
  - Download PDFs from Polaroo (matching selected bills)
  - Upload PDFs to HouseMonk AWS S3
  - Upload JSON metadata (summary, bills, monthly overuse)
  - Create invoice in HouseMonk
  - Add 30s delay before next property
- Save results to `test_housemonk_results.json`

## Sandbox Configuration

All API calls go to HouseMonk **sandbox**:
- Base URL: `https://qa1.thehousemonk.com`
- Client ID: `3a93c900-a2a6-11f0-9ce0-5b6f0a5d9d66`
- User ID: `68e3a508243a303bfc36884f`

## Checking Results

1. **View console output** for detailed logs
2. **Check `test_housemonk_results.json`** for summary
3. **Login to HouseMonk sandbox**:
   - URL: https://qa1.thehousemonk.com
   - View created invoices in dashboard

## Troubleshooting

### PDF Download Fails
- Check Polaroo credentials in environment variables
- Verify Browserless connection is working
- Ensure property names match exactly

### Upload Fails
- Check HouseMonk authentication (master token refresh)
- Verify sandbox API is accessible
- Check network connectivity

### Invoice Creation Fails
- Ensure `unitCode` exists in test data (Excel column 2)
- Verify unit exists in HouseMonk sandbox
- Check if project has products and tax codes configured

## Next Steps

Once testing is successful:
1. Integrate modules into main `server.js`
2. Remove export endpoint and button
3. Add to main processing flow
4. Update frontend to show invoice info

