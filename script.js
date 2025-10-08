let excelData = null;

document.addEventListener('DOMContentLoaded', function() {
    const uploadForm = document.getElementById('uploadForm');
    const secretsForm = document.getElementById('secretsForm');
    const messageDiv = document.getElementById('message');
    const uploadSection = document.getElementById('uploadSection');
    const mainInterface = document.getElementById('mainInterface');
    const backToUploadBtn = document.getElementById('backToUpload');
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabPanels = document.querySelectorAll('.tab-panel');
    const processBtn = document.getElementById('processBtn');
    const processingModal = document.getElementById('processingModal');
    const closeModal = document.getElementById('closeModal');
    const secretsTab = document.getElementById('secretsTab');
    const secretsButton = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.dataset.tab === 'secrets');

    // On load: ask server if secrets exist in env; if yes, hide Secrets tab
    fetch('/api/env-flags').then(r => r.json()).then(flags => {
        if (flags && flags.success && flags.hasPolaroo && flags.hasCohere) {
            // Hide secrets tab and panel
            if (secretsButton) secretsButton.style.display = 'none';
            if (secretsTab) secretsTab.style.display = 'none';
            // Activate properties tab by default
            document.querySelector('.tab-btn[data-tab="properties"]').click();
        }
    }).catch(() => {});

    // Upload form submission
    uploadForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const excelFile = document.getElementById('excelFile').files[0];
        
        if (!excelFile) {
            showMessage('Please select an Excel file', 'error');
            return;
        }
        
        // Validate file type
        const allowedTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 
                             'application/vnd.ms-excel'];
        if (!allowedTypes.includes(excelFile.type)) {
            showMessage('Please upload a valid Excel file (.xlsx or .xls)', 'error');
            return;
        }
        
        // Show loading state
        const submitBtn = document.querySelector('#uploadForm .submit-btn');
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Processing...';
        submitBtn.disabled = true;
        
        // Process Excel file locally
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const data = new Uint8Array(e.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                
                if (jsonData.length === 0) {
                    showMessage('The Excel file appears to be empty', 'error');
                    submitBtn.textContent = originalText;
                    submitBtn.disabled = false;
                    return;
                }
                
                // Store the data
                excelData = jsonData;
                
                // Show success and switch to main interface
                showMessage('Excel file uploaded successfully!', 'success');
                
                setTimeout(() => {
                    uploadSection.style.display = 'none';
                    mainInterface.style.display = 'block';
                    loadProperties();
                }, 1000);
                
            } catch (error) {
                console.error('Error processing Excel file:', error);
                showMessage('Error processing Excel file. Please try again.', 'error');
            } finally {
                submitBtn.textContent = originalText;
                submitBtn.disabled = false;
            }
        };
        
        reader.readAsArrayBuffer(excelFile);
    });
    
    // Secrets form submission
    secretsForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const cohereKey = document.getElementById('cohereKey').value;

        // This endpoint is optional now since Fly has secrets; keep for local/dev
        fetch('/api/secrets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password, cohereKey })
        })
        .then(async response => {
            const data = await response.json().catch(() => ({ success: false, message: 'Invalid server response' }));
            if (data.success) {
                showMessage(data.message, 'success');
                try { alert('Secrets saved successfully'); } catch(_) {}
            } else {
                showMessage(data.message, 'error');
            }
        })
        .catch(error => {
            console.error('Error saving secrets:', error);
            showMessage('Error saving secrets. Please try again.', 'error');
        });
    });
    
    // Back to upload button
    backToUploadBtn.addEventListener('click', function() {
        mainInterface.style.display = 'none';
        uploadSection.style.display = 'block';
        uploadForm.reset();
        excelData = null;
        processBtn.disabled = true;
        document.getElementById('resultsContainer').style.display = 'none';
    });
    
    // Tab switching
    tabBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            const targetTab = this.getAttribute('data-tab');
            
            // Remove active class from all tabs and panels
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanels.forEach(p => p.classList.remove('active'));
            
            // Add active class to clicked tab and corresponding panel
            this.classList.add('active');
            document.getElementById(targetTab + 'Tab').classList.add('active');
            
            // Enable process button when switching to properties tab
            if (targetTab === 'properties' && excelData) {
                processBtn.disabled = false;
            }
        });
    });
    
    // Process button functionality
    processBtn.addEventListener('click', async function() {
        if (!excelData || excelData.length === 0) {
            showMessage('No properties to process', 'error');
            return;
        }
        
        const period = document.getElementById('monthPair')?.value || 'Jul-Aug';
        const limit10 = document.getElementById('limit10')?.checked || false;
        
        // Get properties with names and room counts
        const properties = excelData
            .slice(1) // Remove header row
            .map(row => ({
                name: row[0] ? row[0].toString().trim() : '',
                rooms: row[1] ? parseInt(row[1]) || 0 : 0
            }))
            .filter(prop => prop.name !== '');
        
        if (properties.length === 0) {
            showMessage('No property names found', 'error');
            return;
        }
        
        // Show modal and start processing
        showProcessingModal();
        await processProperties(limit10 ? properties.slice(0, 10) : properties, period);
    });
    
    // Close modal
    closeModal.addEventListener('click', function() {
        processingModal.style.display = 'none';
    });
    
    // Close modal when clicking outside
    processingModal.addEventListener('click', function(e) {
        if (e.target === processingModal) {
            processingModal.style.display = 'none';
        }
    });
    
    function loadProperties() {
        if (!excelData || excelData.length === 0) {
            document.getElementById('propertiesList').innerHTML = '<p>No data available</p>';
            return;
        }
        
        const propertiesList = document.getElementById('propertiesList');
        propertiesList.innerHTML = '';
        
        // Get property names and room counts from first two columns
        const properties = excelData
            .slice(1) // Remove header row
            .map(row => ({
                name: row[0] ? row[0].toString().trim() : '',
                rooms: row[1] ? parseInt(row[1]) || 0 : 0
            }))
            .filter(prop => prop.name !== ''); // Remove empty property names
        
        if (properties.length === 0) {
            propertiesList.innerHTML = '<p>No property names found in the first column</p>';
            return;
        }
        
        properties.forEach((property, index) => {
            const propertyItem = document.createElement('div');
            propertyItem.className = 'property-item';
            propertyItem.textContent = `${index + 1}. ${property.name} (${property.rooms} rooms)`;
            propertiesList.appendChild(propertyItem);
        });
        
        // Enable process button
        processBtn.disabled = false;
    }
    
    function showProcessingModal() {
        processingModal.style.display = 'flex';
        document.getElementById('logContent').innerHTML = '';
        document.getElementById('progressFill').style.width = '0%';
        document.getElementById('progressText').textContent = '0%';
    }
    
    function addLogEntry(message, type = 'info') {
        const logContent = document.getElementById('logContent');
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logContent.appendChild(logEntry);
        logContent.scrollTop = logContent.scrollHeight;
    }
    
    function updateProgress(percentage) {
        document.getElementById('progressFill').style.width = `${percentage}%`;
        document.getElementById('progressText').textContent = `${Math.round(percentage)}%`;
    }
    
    async function processProperties(properties, period) {
        try {
            addLogEntry('Starting Polaroo processing...', 'info');
            addLogEntry(`Found ${properties.length} properties to process`, 'info');
            
            // Show initial progress
            updateProgress(10);
            addLogEntry('Sending request to server...', 'info');
            
            // Open SSE first to receive live logs
            try {
                if (window._sse) { try { window._sse.close(); } catch(_) {} }
                window._sse = new EventSource('/api/process-properties-stream');
                window._sse.onmessage = (e) => {
                    try {
                        const data = JSON.parse(e.data);
                        if (data.type === 'log') addLogEntry(data.message, data.level || 'info');
                        if (data.type === 'progress') updateProgress(data.percentage || 0);
                        if (data.type === 'error') addLogEntry(`Server Error: ${data.message}`, 'error');
                    } catch(_) {}
                };
            } catch(_) {}

            const response = await fetch('/api/process-properties', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    properties: properties,
                    period
                })
            });
            
            if (!response.ok) {
                let errText = response.statusText;
                try {
                    const errData = await response.json();
                    if (errData && (errData.error || errData.message)) {
                        errText = `${errData.error || errData.message}`;
                    }
                } catch(_) {}
                addLogEntry(`Server returned error: ${errText}`, 'error');
                throw new Error(`Processing failed: ${errText}`);
            }
            
            updateProgress(30);
            addLogEntry('Server is processing properties...', 'info');
            addLogEntry('This may take several minutes...', 'info');
            
            const data = await response.json();
            
            if (!data.success) {
                addLogEntry(`Server failure: ${data.message || 'Unknown error'}`, 'error');
                throw new Error(data.message || 'Processing failed');
            }
            
            // Progress proportional to number of properties processed if server streams counts; for now, jump to 80 on completion
            updateProgress(80);
            addLogEntry('Processing completed!', 'success');
            addLogEntry(`Successfully processed: ${data.successful}/${data.totalProcessed} properties`, 'success');
            
            // Display all logs from server
            if (data.logs && data.logs.length > 0) {
                data.logs.forEach(log => {
                    addLogEntry(log.message, log.level || 'info');
                });
            }
            
            updateProgress(100);
            
            // Show results
            displayResults(data.results);
            
            // Close modal after a delay
            setTimeout(() => {
                processingModal.style.display = 'none';
            }, 3000);
            
        } catch (error) {
            console.error('Processing error:', error);
            addLogEntry(`Error: ${error.message}`, 'error');
            updateProgress(0);
        }
    }
    
    function displayResults(results) {
        const resultsContainer = document.getElementById('resultsContainer');
        const resultsList = document.getElementById('resultsList');
        
        resultsList.innerHTML = '';
        
        results.forEach(result => {
            const resultItem = document.createElement('div');
            resultItem.className = 'result-item';
            
            resultItem.innerHTML = `
                <div class="result-header">
                    <span class="property-name">${result.property}</span>
                    <span class="status-badge ${result.success ? 'success' : 'error'}">
                        ${result.success ? 'Success' : 'Failed'}
                    </span>
                </div>
                ${result.success ? `
                    <div class="result-details">
                        <div class="detail-item">
                            <div class="detail-label">⚡ Electricity Bills</div>
                            <div class="detail-value electricity">${result.electricity_bills} bills</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">💧 Water Bills</div>
                            <div class="detail-value water">${result.water_bills} bills</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">⚡ Electricity Cost</div>
                            <div class="detail-value electricity">${result.electricity_cost ? result.electricity_cost.toFixed(2) : '0.00'} €</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">💧 Water Cost</div>
                            <div class="detail-value water">${result.water_cost ? result.water_cost.toFixed(2) : '0.00'} €</div>
                        </div>
                        <div class="detail-item" style="border-top: 2px solid #333; margin-top: 10px; padding-top: 10px;">
                            <div class="detail-label">💰 Total Overuse</div>
                            <div class="detail-value total" style="font-size: 18px; font-weight: bold;">${result.overuse_amount ? result.overuse_amount.toFixed(2) : '0.00'} €</div>
                        </div>
                        <div class="detail-item">
                            <div class="detail-label">🏠 Rooms</div>
                            <div class="detail-value">${result.rooms || 0}</div>
                        </div>
                    </div>
                ` : `
                    <div style="color: #dc3545; font-weight: 600;">
                        ${result.error || 'Unknown error'}
                    </div>
                `}
            `;
            
            resultsList.appendChild(resultItem);
        });
        
        resultsContainer.style.display = 'block';
    }
    
    function showMessage(text, type) {
        messageDiv.textContent = text;
        messageDiv.className = `message ${type}`;
        
        // Auto-hide success messages after 3 seconds
        if (type === 'success') {
            setTimeout(() => {
                messageDiv.style.display = 'none';
            }, 3000);
        }
    }
    
    // File input styling
    const fileInput = document.getElementById('excelFile');
    fileInput.addEventListener('change', function() {
        const fileName = this.files[0]?.name;
        if (fileName) {
            console.log('Selected file:', fileName);
        }
    });
});