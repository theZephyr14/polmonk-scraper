#!/usr/bin/env node
/**
 * CLI: Map property names from an Excel/CSV to HouseMonk Home IDs
 *
 * Usage:
 *   node scripts/map_names_to_homes.js [inputPath] [sheetName]
 *
 * Defaults:
 *   inputPath: ./Book1 - test.xlsx
 *   sheetName: first sheet
 *
 * Output:
 *   ./housemonk_name_mapping.json
 *   ./housemonk_name_mapping.csv
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { HouseMonkAuth } = require('../test_modules/housemonk_auth');

function normalize(str) {
    return String(str || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // strip accents
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function similarity(a, b) {
    // Simple token-based Jaccard similarity
    const A = new Set(normalize(a).split(/\s+/).filter(Boolean));
    const B = new Set(normalize(b).split(/\s+/).filter(Boolean));
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return inter / union;
}

async function fetchHomes(auth, limit = 500, maxPages = 10) {
    const homes = [];
    for (let page = 0; page < maxPages; page++) {
        const offset = page * limit;
        const res = await auth.makeAuthenticatedRequest('GET', `/api/home?limit=${limit}&offset=${offset}&sort=createdAt`, null, true);
        const rows = Array.isArray(res.data?.rows) ? res.data.rows : [];
        homes.push(...rows);
        if (!rows.length) break;
    }
    return homes.map(h => ({
        _id: h._id,
        name: h.name || h.propertyName || h.unitCode || h.address || '',
        project: h.project,
        listing: h.listing
    }));
}

function readInput(inputPath, sheetName) {
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.csv') {
        const lines = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/).filter(Boolean);
        // Assume first column is name, optional rooms (ignored), optional unitCode
        return lines.map((line, i) => {
            const cols = line.split(',');
            return { name: (cols[0] || '').trim(), rooms: Number(cols[1] || 0) || 0, unitCode: (cols[2] || '').trim(), row: i + 1 };
        }).filter(r => r.name);
    }
    const wb = XLSX.readFile(inputPath);
    const wsName = sheetName || wb.SheetNames[0];
    const ws = wb.Sheets[wsName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    // First column: property name; second: rooms; third: unitCode
    return rows.slice(1).map((r, idx) => ({
        name: (r[0] || '').toString().trim(),
        rooms: Number(r[1] || 0) || 0,
        unitCode: (r[2] || '').toString().trim(),
        row: idx + 2
    })).filter(r => r.name);
}

async function main() {
    const inputPath = process.argv[2] || path.resolve(process.cwd(), 'Book1 - test.xlsx');
    const sheetName = process.argv[3];

    console.log(`🔎 Reading input from: ${inputPath}`);
    const entries = readInput(inputPath, sheetName);
    console.log(`📄 Rows: ${entries.length}`);

    const auth = new HouseMonkAuth();
    await auth.refreshMasterToken();
    await auth.getUserAccessToken(auth.config.userId);
    const homes = await fetchHomes(auth, 500, 10);
    console.log(`🏠 HouseMonk homes fetched: ${homes.length}`);

    const results = [];
    for (const e of entries) {
        const candidates = homes
            .map(h => ({ h, score: similarity(e.name, h.name) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);

        const best = candidates[0];
        const confidence = best ? Number(best.score.toFixed(3)) : 0;
        const exact = best && normalize(best.h.name) === normalize(e.name);
        const accepted = exact || confidence >= 0.6; // threshold

        results.push({
            row: e.row,
            property: e.name,
            rooms: e.rooms,
            providedUnitCode: e.unitCode || '',
            matchedName: best?.h.name || '',
            homeId: best?.h._id || '',
            projectId: best?.h.project || '',
            listingId: best?.h.listing || '',
            confidence,
            accepted,
            candidates: candidates.map(c => ({ name: c.h.name, homeId: c.h._id, score: Number(c.score.toFixed(3)) }))
        });
    }

    // Write outputs
    const jsonPath = path.resolve(process.cwd(), 'housemonk_name_mapping.json');
    const csvPath = path.resolve(process.cwd(), 'housemonk_name_mapping.csv');
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    const csvHeader = 'row,property,rooms,providedUnitCode,matchedName,homeId,projectId,listingId,confidence,accepted';
    const csvLines = [csvHeader, ...results.map(r => [r.row, r.property.replace(/,/g, ' '), r.rooms, r.providedUnitCode, (r.matchedName||'').replace(/,/g,' '), r.homeId, r.projectId, r.listingId, r.confidence, r.accepted].join(','))];
    fs.writeFileSync(csvPath, csvLines.join('\n'));

    console.log(`✅ Mapping written:
  - ${jsonPath}
  - ${csvPath}`);
}

main().catch(err => {
    console.error('❌ Mapping failed:', err.message);
    process.exit(1);
});


