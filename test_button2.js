const axios = require('axios');

async function testButton2() {
    console.log('🧪 Testing Button 2 endpoint...');
    
    const testData = {
        results: [
            {
                property: "Aribau 1º 1ª",
                rooms: 1,
                overuse_amount: 188.24,
                unitCode: "UNIT001",
                selected_bills: [
                    { "Service": "Electricity", "Final Date": "2023-01-31" },
                    { "Service": "Water", "Final Date": "2023-01-31" }
                ]
            }
        ]
    };
    
    try {
        console.log('📤 Sending request to Button 2 endpoint...');
        const response = await axios.post('http://localhost:3000/api/process-overuse-pdfs', testData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 // 60 second timeout
        });
        
        console.log('✅ Response received:');
        console.log(JSON.stringify(response.data, null, 2));
        
    } catch (error) {
        console.error('❌ Request failed:');
        console.error('Status:', error.response?.status);
        console.error('Message:', error.response?.data?.message || error.message);
        console.error('Full error:', error.response?.data);
    }
}

testButton2();
