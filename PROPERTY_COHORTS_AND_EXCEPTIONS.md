# Property Cohorts and Exceptions Configuration

## 📊 Property Cohorts

### EVEN Cohort (Windows ending in even months)
**Periods:** Jan-Feb, Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec

**Properties:**
- **Llull** (Llull 250)
- **Blasco** (Blasco de Garay)
- **Torrent** (Torrent Olla)
- **Bisbe** (Bisbe Laguarda)
- **Aribau** (La Pedrera Community - Aribau)
- **Comte** (Comte Borrell)
- **Borrell** (Comte Borrell)
- **Providencia** (Providencia) ⚠️ Uses initial date for water bills

### ODD Cohort (Windows ending in odd months)
**Periods:** Feb-Mar, Apr-May, Jun-Jul, Aug-Sep, Oct-Nov, Dec-Jan

**Properties:**
- **Padilla** (Padilla)
- **Sardenya** (Sardenya)
- **Valencia** (Valencia)
- **Sant Joan** (Psg Sant Joan, Pg Sant Joan)
- **St Joan** (Psg Sant Joan, Pg Sant Joan)

## ⚠️ Property Exceptions

### NO_WATER_PROPERTIES (Electricity Only)
These properties **DO NOT** have water bills - only electricity bills are processed:

- **Aribau 2-1** (La Pedrera Community - Aribau, 2-1)
- **Bisbe 2-2** (Bisbe Laguarda 14, 2-2)
- **Comte** (Comte Borrell - all units)
- **Torrent** (Torrent Olla - all units)
- **Valencia Ático** (Valencia Ático - specific unit only)
- **Providencia 2º 1ª** (Providencia 2º 1ª - specific unit only)

### WATER_ONLY_PROPERTIES (Water Only)
These properties **ONLY** have water bills - no electricity bills are processed:

- **Aribau 3-2** (La Pedrera Community - Aribau, 3-2)
- **Aribau 1-2** (La Pedrera Community - Aribau, 1-2)
- **Aribau 4-2** (La Pedrera Community - Aribau, 4-2)

## 🔍 Special Billing Logic

### Water Bill Date Logic

**ALL properties use FINAL DATE with spillover logic (cutoff day 9) for water bills.**

**Examples:**
- Providencia: `08/07/2025 → 05/09/2025` - Final date 05/09 (day 5 ≤ 9) → billingMonth = **August** (for Jul-Aug period)
- Valencia: `31/07/2025 → 01/10/2025` - Final date 01/10 (day 1 ≤ 9) → billingMonth = **September** (for Aug-Sep period)
- Standard: `02/06/2025 → 31/07/2025` - Final date 31/07 (day 31 > 9) → billingMonth = **July** (for Jun-Jul period)

**Exceptions (No water bills):**
- **Providencia 2º 1ª** - No water bills (electricity only - in NO_WATER_PROPERTIES)
- **Valencia Ático** - No water bills (electricity only - in NO_WATER_PROPERTIES)

## 📅 Billing Month Calculation

### Spillover Logic (Cutoff = 9th day)
- If final date day ≤ 9 → Billing month = previous month
- If final date day > 9 → Billing month = current month

### Examples:
- `04/03–03/04` → Billing month = March (day 3 ≤ 9)
- `26/07–25/08` → Billing month = August (day 25 > 9)
- `15/10–14/11` → Billing month = November (day 14 > 9)
- `21/06–20/07` → Billing month = July (day 20 > 9)

## 🎯 Summary

**Total Properties by Cohort:**
- **EVEN Cohort:** 7 properties
- **ODD Cohort:** 6 properties

**Total Exceptions:**
- **NO_WATER_PROPERTIES:** 6 specific units/properties
- **WATER_ONLY_PROPERTIES:** 3 specific units

**Special Cases:**
- **ALL properties:** Use final date with spillover logic (cutoff day 9) for billing month calculation
- **Valencia Ático:** No water bills (electricity only)
- **Providencia 2º 1ª:** No water bills (electricity only)

## 📋 Usage Notes

1. **Cohort Assignment:** Properties are assigned to EVEN/ODD based on the ending month of the billing period
2. **Exception Handling:** NO_WATER and WATER_ONLY properties override normal electricity/water processing
3. **Valencia Special Case:** Water bills for Valencia properties use initial date instead of final date
4. **Year Filtering:** Only bills from 2025 are processed (2024 and earlier are ignored)
