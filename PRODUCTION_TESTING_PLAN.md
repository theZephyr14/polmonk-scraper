# Production Testing Plan

## Current Configuration
- Environment: **PRODUCTION** (`dashboard.thehousemonk.com`)
- Invoice Status: **DRAFT** (won't send to tenants)

## Safe Testing Approach

### Phase 1: Test with 2-3 Properties (DRAFT Invoices)
1. Select 2-3 lowest risk properties from your Excel
2. Run end-to-end processing
3. Check HouseMonk dashboard - invoices should be in **DRAFT** status
4. Verify:
   - ✅ Correct unit linked
   - ✅ Correct tenant assigned
   - ✅ Files uploaded
   - ✅ Amounts correct

### Phase 2: Review in HouseMonk (DRAFT Invoices)
1. Go to HouseMonk production dashboard
2. Navigate to Transactions/Invoices
3. Filter by today's date
4. Check each invoice:
   - Unit name matches Excel
   - Tenant is correct
   - File attachments work
   - Amount matches Excel calculation

### Phase 3: Switch to "Due" Status (LIVE Invoices)
Once you're satisfied with the draft invoices:

**Option A: Via Environment Variable (Recommended)**
```bash
# In Render dashboard, add environment variable:
INVOICE_STATUS=due
```

**Option B: Via Code Change**
In `test_modules/invoice_creator.js` line 139:
```javascript
status: 'due', // CHANGE FROM 'draft' TO 'due'
```

### Phase 4: Process All Properties
Once switching to "due", run full batch of all properties.

## How to Revert to Sandbox (If Needed)
```bash
# In Render dashboard, set environment variable:
HM_ENVIRONMENT=sandbox
```

## Emergency Rollback
If something goes wrong:
1. Go to HouseMonk dashboard
2. Find incorrect invoices by date
3. Delete or mark as deleted
4. Fix code and redeploy

## Success Criteria Before Going Full Production
- ✅ DRAFT invoices created for 2-3 test properties
- ✅ Correct unit IDs linked
- ✅ Correct tenants assigned
- ✅ Files attach correctly
- ✅ Amounts match Excel
- ✅ You can view invoices in HouseMonk

