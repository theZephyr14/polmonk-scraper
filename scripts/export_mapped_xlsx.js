#!/usr/bin/env node
// Build an Excel like the user's template: name, rooms, ID (homeId)
// Inputs:
//  - housemonk_name_mapping.json (from map_names_to_homes.js)
//  - optionally the original Excel to copy rooms if mapping lacks it

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readOriginalRooms(excelPath) {
    try {
        const wb = XLSX.readFile(excelPath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const map = new Map();
        rows.slice(1).forEach(r => {
            const name = (r[0] || '').toString().trim();
            const rooms = Number(r[1] || 0) || 0;
            if (name) map.set(name, rooms);
        });
        return map;
    } catch (_) {
        return new Map();
    }
}

function main() {
    const mappingPath = path.resolve(process.cwd(), 'housemonk_name_mapping.json');
    const originalPath = process.argv[2] || path.resolve(process.cwd(), 'Book1 - test.xlsx');
    const outPath = process.argv[3] || path.resolve(process.cwd(), 'Book1_mapped.xlsx');

    if (!fs.existsSync(mappingPath)) {
        console.error('Mapping file not found:', mappingPath);
        process.exit(1);
    }

    const mapping = readJson(mappingPath);
    const roomsMap = readOriginalRooms(originalPath);

    // Build rows: header + data
    const rows = [['name', 'rooms', 'ID']];
    for (const r of mapping) {
        const name = r.property || '';
        const rooms = r.rooms ?? roomsMap.get(name) ?? 0;
        const id = r.homeId || r.providedUnitCode || '';
        rows.push([name, rooms, id]);
    }

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, outPath);
    console.log(`✅ Wrote ${outPath}`);
}

main();


