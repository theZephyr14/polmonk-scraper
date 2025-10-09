const fs = require('fs');

function main() {
    const path = 'test_overuse_data.json';
    if (!fs.existsSync(path)) {
        console.log('NOT_FOUND test_overuse_data.json');
        process.exit(0);
    }
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    console.log('FOUND test_overuse_data.json');
    console.log('COUNT', Array.isArray(data) ? data.length : 0);
    console.log('PROPERTIES', (data || []).map(r => r.property));
}

main();


