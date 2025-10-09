# HouseMonk Integration Guide

## 🎯 Overview

This system integrates Polaroo overuse analysis with HouseMonk invoice creation. It automatically:
1. Scrapes utility bills from Polaroo
2. Calculates overuse amounts based on room allowances
3. Downloads PDF bills from Polaroo
4. Uploads PDFs and metadata to HouseMonk AWS S3
5. Creates invoices in HouseMonk sandbox

## 🚀 Quick Start

### 1. Test HouseMonk Connection
```bash
npm run test:hm:smoke
```

### 2. Full Integration Test
1. Run the main app: `npm start`
2. Upload Excel file with properties (Column 1: Name, Column 2: Rooms, Column 3: Unit Code)
3. Process properties and get overuse results
4. Click "📥 Export Overuse Data for HouseMonk Test"
5. Run full test: `npm run test:hm:full`

## 📋 Excel File Format

| Property Name | Rooms | Unit Code |
|---------------|-------|-----------|
| Property A    | 2     | UNIT001   |
| Property B    | 3     | UNIT002   |

## 🔧 Environment Variables

Required for HouseMonk integration:
```bash
POLAROO_EMAIL=your-email@example.com
POLAROO_PASSWORD=your-password
BROWSER_WS_URL=wss://production-sfo.browserless.io/
```

## 📁 File Structure

```
├── server.js                          # Main application
├── script.js                          # Frontend JavaScript
├── auth_manager.js                    # HouseMonk auth (production)
├── test_modules/                      # HouseMonk integration modules
│   ├── housemonk_auth.js             # Authentication & ID resolution
│   ├── pdf_downloader.js             # Download bills from Polaroo
│   ├── aws_uploader.js               # Upload to HouseMonk S3
│   └── invoice_creator.js            # Create invoices
├── test_housemonk_integration.js     # Full integration test
├── test_housemonk_smoke.js           # Quick connection test
└── test_overuse_data.json            # Generated test data
```

## 🔄 Workflow

### Phase 1: Data Collection
1. User uploads Excel file
2. System processes properties through Polaroo
3. Calculates overuse amounts
4. Exports data to `test_overuse_data.json`

### Phase 2: HouseMonk Integration
1. Authenticate with HouseMonk sandbox
2. For each property with overuse:
   - Download PDF bills from Polaroo
   - Upload PDFs to HouseMonk AWS S3
   - Upload JSON metadata
   - Create invoice in HouseMonk
3. Save results to `test_housemonk_results.json`

## 🧪 Testing

### Smoke Test
Tests basic HouseMonk connectivity:
```bash
npm run test:hm:smoke
```

### Full Integration Test
Tests complete workflow:
```bash
npm run test:hm:full
```

## 📊 Results

After running the full test, check:
- `test_housemonk_results.json` - Detailed results
- HouseMonk sandbox dashboard - Created invoices
- Console output - Real-time progress

## 🔧 Configuration

### HouseMonk Sandbox
- Base URL: `https://qa1.thehousemonk.com`
- Client ID: `3a93c900-a2a6-11f0-9ce0-5b6f0a5d9d66`
- User ID: `68e3a508243a303bfc36884f`

### Room-Based Allowances
- 1 room: 50€/month
- 2 rooms: 70€/month  
- 3 rooms: 100€/month
- 4+ rooms: 130€/month
- Special: Padilla 1-3: 150€/month

## 🚨 Troubleshooting

### Common Issues

1. **Authentication Failed**
   - Check HouseMonk credentials
   - Verify sandbox access

2. **PDF Download Failed**
   - Check Polaroo credentials
   - Verify Browserless connection

3. **Invoice Creation Failed**
   - Check unit codes in Excel
   - Verify HouseMonk project setup

### Debug Mode
Set `DEBUG=true` for verbose logging.

## 📈 Next Steps

1. **Test with Real Data**: Use actual property data
2. **Production Setup**: Configure production HouseMonk
3. **UI Integration**: Add HouseMonk features to main interface
4. **Error Handling**: Improve error recovery
5. **Monitoring**: Add logging and alerts

## 🔗 Links

- [HouseMonk Sandbox](https://qa1.thehousemonk.com)
- [Polaroo Dashboard](https://app.polaroo.com)
- [Browserless](https://browserless.io)
