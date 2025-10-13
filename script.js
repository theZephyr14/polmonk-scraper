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
    const modalOkBtn = document.getElementById('modalOkBtn');
    const modalTitle = document.getElementById('modalTitle');
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
        const submitBtn = document.getElementById('uploadSubmit') || document.querySelector('#uploadForm .submit-btn');
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
        
        // Get properties with names, room counts, and unit codes
        const properties = excelData
            .slice(1) // Remove header row
            .map(row => ({
                name: row[0] ? row[0].toString().trim() : '',
                rooms: row[1] ? parseInt(row[1]) || 0 : 0,
                unitCode: row[2] ? row[2].toString().trim() : ''
            }))
            .filter(prop => prop.name !== '');
        
        if (properties.length === 0) {
            showMessage('No property names found', 'error');
            return;
        }
        
            // Show modal and start processing
            showProcessingModal('Processing Properties');
        await processProperties(limit10 ? properties.slice(0, 10) : properties, period);
    });
    
    // Modal close controls
    closeModal.classList.add('disabled');
    closeModal.addEventListener('click', function() {
        if (closeModal.classList.contains('disabled')) return;
        processingModal.style.display = 'none';
    });
    modalOkBtn.addEventListener('click', function() {
        processingModal.style.display = 'none';
        modalOkBtn.style.display = 'none';
        closeModal.classList.add('disabled');
    });
    processingModal.addEventListener('click', function(e) {
        if (e.target === processingModal) {
            // do not close while running
        }
    });
    
    function loadProperties() {
        if (!excelData || excelData.length === 0) {
            document.getElementById('propertiesList').innerHTML = '<p>No data available</p>';
            return;
        }
        
        const propertiesList = document.getElementById('propertiesList');
        propertiesList.innerHTML = '';
        
        // Get property names, room counts, and unit codes from first three columns
        const properties = excelData
            .slice(1) // Remove header row
            .map(row => ({
                name: row[0] ? row[0].toString().trim() : '',
                rooms: row[1] ? parseInt(row[1]) || 0 : 0,
                unitCode: row[2] ? row[2].toString().trim() : ''
            }))
            .filter(prop => prop.name !== ''); // Remove empty property names
        
        if (properties.length === 0) {
            propertiesList.innerHTML = '<p>No property names found in the first column</p>';
            return;
        }
        
        // Selection state
        const selected = new Set();
        const selectAll = document.getElementById('selectAllProps');
        selectAll.checked = true;

        properties.forEach((property, index) => {
            const wrapper = document.createElement('label');
            wrapper.className = 'property-item';
            wrapper.style.display = 'flex';
            wrapper.style.alignItems = 'center';
            wrapper.style.gap = '10px';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            selected.add(property.name);
            cb.addEventListener('change', () => {
                if (cb.checked) selected.add(property.name); else selected.delete(property.name);
            });
            const unitCodeText = property.unitCode ? ` - Unit: ${property.unitCode}` : '';
            const span = document.createElement('span');
            span.textContent = `${index + 1}. ${property.name} (${property.rooms} rooms${unitCodeText})`;
            wrapper.appendChild(cb);
            wrapper.appendChild(span);
            propertiesList.appendChild(wrapper);
        });

        selectAll.addEventListener('change', () => {
            const inputs = propertiesList.querySelectorAll('input[type="checkbox"]');
            inputs.forEach((cb, i) => {
                cb.checked = selectAll.checked;
                const name = properties[i].name;
                if (selectAll.checked) selected.add(name); else selected.delete(name);
            });
        });
        
        // Enable process button
        processBtn.disabled = false;

        // Override process handler to use selection
        processBtn.onclick = async function() {
            const period = document.getElementById('monthPair')?.value || 'Jul-Aug';
            const limit10 = document.getElementById('limit10')?.checked || false;
            const selectedProps = properties.filter(p => selected.has(p.name));
            if (selectedProps.length === 0) { showMessage('Please select at least one property', 'error'); return; }
            showProcessingModal('Processing Properties');
            await processProperties(limit10 ? selectedProps.slice(0, 10) : selectedProps, period);
        };
    }
    
    function showProcessingModal(title = 'Processing Properties') {
        processingModal.style.display = 'flex';
        modalTitle.textContent = title;
        document.getElementById('logContent').innerHTML = '';
        document.getElementById('progressFill').style.width = '0%';
        document.getElementById('progressText').textContent = '0%';
        closeModal.classList.add('disabled');
        modalOkBtn.style.display = 'none';
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
            
            // Keep modal open with OK button
            closeModal.classList.remove('disabled');
            modalOkBtn.style.display = 'block';
            
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
        
        // Add export button for HouseMonk testing (TEMPORARY)
        // Button 1 removed - not useful
        
        // Button 2: Download PDFs and Upload to AWS
        const pdfBtn = document.createElement('button');
        pdfBtn.className = 'submit-btn';
        pdfBtn.style.marginTop = '10px';
        pdfBtn.style.backgroundColor = '#28a745';
        pdfBtn.textContent = '📄 Step 1: Download PDFs & Upload to AWS';
        pdfBtn.onclick = async () => {
            try {
                showProcessingModal('Download PDFs & Upload to AWS');
                addLogEntry('Starting PDF download and AWS upload for overuse properties...', 'info');
                addLogEntry('This may take 2-3 minutes per property...', 'info');
                
                // Disable button during processing
                pdfBtn.disabled = true;
                pdfBtn.textContent = '⏳ Processing...';
                
                const response = await fetch('/api/process-overuse-pdfs', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ results })
                });
                
                const data = await response.json();
                
                if (data.success) {
                    addLogEntry(`✅ Processing completed: ${data.message}`, 'success');
                    
                    // Update the results with AWS object keys and unitCode for Button 3
                    if (data.properties) {
                        console.log('🔄 Updating results with AWS data from Button 2...');
                        console.log('📋 Button 2 response properties:', data.properties.map(p => ({ 
                            property: p.property, 
                            awsObjectKeys: p.awsObjectKeys?.length || 0,
                            jsonObjectKeys: p.jsonObjectKeys?.length || 0
                        })));
                        console.log('📋 Current results before update:', results.map(r => ({ 
                            property: r.property, 
                            awsObjectKeys: r.awsObjectKeys?.length || 0,
                            jsonObjectKeys: r.jsonObjectKeys?.length || 0
                        })));
                        
                        data.properties.forEach(updatedProp => {
                            const originalProp = results.find(r => r.property === updatedProp.property);
                            if (originalProp) {
                                originalProp.awsObjectKeys = updatedProp.awsObjectKeys || [];
                                originalProp.jsonObjectKeys = updatedProp.jsonObjectKeys || [];
                                originalProp.unitCode = updatedProp.unitCode || originalProp.unitCode || '';
                                console.log(`✅ Updated ${updatedProp.property} with ${originalProp.awsObjectKeys.length} AWS keys`);
                            } else {
                                console.log(`❌ Could not find original property for: ${updatedProp.property}`);
                            }
                        });
                        
                        console.log('📋 Results after update:', results.map(r => ({ 
                            property: r.property, 
                            awsObjectKeys: r.awsObjectKeys?.length || 0,
                            jsonObjectKeys: r.jsonObjectKeys?.length || 0
                        })));
                    }
                    
                    // Show detailed results
                    let resultMessage = `✅ Processing completed!\n\n${data.message}\n\n`;
                    if (data.properties) {
                        resultMessage += 'Details:\n';
                        data.properties.forEach(prop => {
                            resultMessage += `• ${prop.property}: ${prop.status.toUpperCase()}\n`;
                            if (prop.status === 'success') {
                                resultMessage += `  - Downloaded: ${prop.pdfCount} PDFs\n`;
                                resultMessage += `  - Uploaded to AWS: ${prop.uploadCount || 0} files\n`;
                            } else {
                                resultMessage += `  - Error: ${prop.message}\n`;
                            }
                        });
                    }
                    
                    // Persist uploads for resume
                    try { localStorage.setItem('polmonk:lastUploads', JSON.stringify(data.properties || [])); } catch(_) {}
                    closeModal.classList.remove('disabled');
                    modalOkBtn.style.display = 'block';
                } else {
                    addLogEntry(`❌ Processing failed: ${data.message}`, 'error');
                    closeModal.classList.remove('disabled');
                    modalOkBtn.style.display = 'block';
                }
            } catch (error) {
                addLogEntry(`❌ Processing failed: ${error.message}`, 'error');
                closeModal.classList.remove('disabled');
                modalOkBtn.style.display = 'block';
            } finally {
                // Re-enable button
                pdfBtn.disabled = false;
                pdfBtn.textContent = '📄 Step 1: Download PDFs & Upload to AWS';
            }
        };
        resultsList.appendChild(pdfBtn);
        
        // Button 3: Create HouseMonk Invoices
        const housemonkBtn = document.createElement('button');
        housemonkBtn.className = 'submit-btn';
        housemonkBtn.style.marginTop = '10px';
        housemonkBtn.style.backgroundColor = '#6f42c1';
        housemonkBtn.textContent = '📝 Step 2: Create HouseMonk Invoices';
        housemonkBtn.disabled = true;
        housemonkBtn.onclick = async () => {
            try {
                showProcessingModal('Create HouseMonk Invoices');
                addLogEntry('Starting HouseMonk invoice creation...', 'info');
                addLogEntry('This will: Use AWS links → Create Invoices in HouseMonk', 'info');
                
                // Debug: Log what we're sending to Button 3
                console.log('🔍 Sending to Button 3 (HouseMonk):');
                console.log('📋 Results data:', results.map(r => ({ 
                    property: r.property, 
                    awsObjectKeys: r.awsObjectKeys?.length || 0,
                    jsonObjectKeys: r.jsonObjectKeys?.length || 0,
                    unitCode: r.unitCode
                })));
                
                const response = await fetch('/api/housemonk/process-overuse', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ results })
                });
                const data = await response.json();
                
                if (data.success) {
                    addLogEntry(`✅ HouseMonk integration completed!`, 'success');
                    addLogEntry(`📊 Results: ${data.successCount} successful, ${data.failedCount} failed`, 'info');
                    
                    // Show invoice links
                    if (data.items && data.items.length > 0) {
                        addLogEntry('🔗 Created Invoices:', 'info');
                        data.items.forEach((item, i) => {
                            if (item.status === 'success') {
                                addLogEntry(`  ${i+1}. ${item.property}: ${item.invoiceUrl}`, 'success');
                            } else {
                                addLogEntry(`  ${i+1}. ${item.property}: FAILED - ${item.error}`, 'error');
                            }
                        });
                    }
                    
                    try { localStorage.setItem('polmonk:lastInvoices', JSON.stringify(data.items || [])); } catch(_) {}
                    closeModal.classList.remove('disabled');
                    modalOkBtn.style.display = 'block';
                } else {
                    addLogEntry(`❌ HouseMonk integration failed: ${data.message}`, 'error');
                    closeModal.classList.remove('disabled');
                    modalOkBtn.style.display = 'block';
                }
            } catch (error) {
                addLogEntry(`❌ HouseMonk integration failed: ${error.message}`, 'error');
                closeModal.classList.remove('disabled');
                modalOkBtn.style.display = 'block';
            }
        };
        resultsList.appendChild(housemonkBtn);
        
        resultsContainer.style.display = 'block';

        // Enable Step 3 only when uploads exist
        const hasUploads = (results || []).some(r => (r.awsObjectKeys && r.awsObjectKeys.length) || (r.awsDocuments && r.awsDocuments.length));
        housemonkBtn.disabled = !hasUploads;
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
});