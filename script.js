let excelData = null;
// Global selection across steps
window._selectedProperties = null;

// Global cleanup function to prevent event listener buildup
function cleanupEventListeners() {
    // Clear any existing processing state
    window._processingInProgress = false;
    
    // Clear any existing SSE connections
    if (window._sse) {
        try { window._sse.close(); } catch(_) {}
        window._sse = null;
    }
    
    // Clear any existing process handlers
    if (window._currentProcessHandler) {
        const processBtn = document.getElementById('processBtn');
        if (processBtn) {
            processBtn.removeEventListener('click', window._currentProcessHandler);
        }
        window._currentProcessHandler = null;
    }
}

// Run cleanup on page load
cleanupEventListeners();

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

    // Secrets UI removed; default to Properties tab
    try {
        const propBtn = document.querySelector('.tab-btn[data-tab="properties"]');
        if (propBtn) propBtn.classList.add('active');
        const propTab = document.getElementById('propertiesTab');
        if (propTab) propTab.classList.add('active');
        if (secretsButton) secretsButton.style.display = 'none';
        if (secretsTab) secretsTab.style.display = 'none';
    } catch(_) {}

     // Clear any cached data to ensure fresh start
     localStorage.removeItem('polmonk:lastResults');
     localStorage.removeItem('polmonk:lastProcessedPeriod');
     console.log('🧹 Cleared cached data for fresh start');

    function handleExcelUpload(e) {
        if (e) { e.preventDefault(); }
        
        // Clean up any existing state before processing new Excel
        cleanupEventListeners();
        
        const excelFile = document.getElementById('excelFile').files[0];
        if (!excelFile) { showMessage('Please select an Excel file', 'error'); return false; }
        const allowedTypes = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel'];
        if (!allowedTypes.includes(excelFile.type)) { showMessage('Please upload a valid Excel file (.xlsx or .xls)', 'error'); return false; }

        const submitBtn = document.getElementById('uploadSubmit') || document.querySelector('#uploadForm .submit-btn');
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Processing...';
        submitBtn.disabled = true;
        
        const reader = new FileReader();
        reader.onload = function(ev) {
            try {
                const data = new Uint8Array(ev.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
                if (jsonData.length === 0) { showMessage('The Excel file appears to be empty', 'error'); reset(); return; }
                excelData = jsonData;
                showMessage('Excel file uploaded successfully!', 'success');
                setTimeout(() => {
                    uploadSection.style.display = 'none';
                    mainInterface.style.display = 'block';
                    loadProperties();
                }, 400);
            } catch (err) {
                console.error('Error processing Excel file:', err);
                showMessage('Error processing Excel file. Please try again.', 'error');
            } finally { reset(); }
        };
        reader.readAsArrayBuffer(excelFile);

        function reset(){ submitBtn.textContent = originalText; submitBtn.disabled = false; }
        return false;
    }
    uploadForm.addEventListener('submit', handleExcelUpload);
    const uploadSubmitBtn = document.getElementById('uploadSubmit');
    if (uploadSubmitBtn) uploadSubmitBtn.addEventListener('click', handleExcelUpload);
    
    // Secrets form removed; no-op if referenced
    if (secretsForm) {
        try {
            secretsForm.style.display = 'none';
        } catch(_) {}
    }
    
    // Back to upload button
    backToUploadBtn.addEventListener('click', function() {
        // Clean up any existing state when going back to upload
        cleanupEventListeners();
        
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
    
    // Default Process button functionality (named so we can remove it later)
    async function defaultProcessClick() {
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
        // Open SSE and ensure only one run at a time
        try { if (window._sse) { window._sse.close(); } } catch(_) {}
        await processProperties(limit10 ? properties.slice(0, 10) : properties, period);
    }
    processBtn.addEventListener('click', defaultProcessClick);
    
    // Modal close controls (acts as Cancel)
    closeModal.classList.add('disabled');
    closeModal.addEventListener('click', async function() {
        if (closeModal.classList.contains('disabled')) return;
        try {
            addLogEntry('🛑 Cancel requested...', 'warning');
            try { if (window._sse) { window._sse.close(); } } catch(_) {}
            await fetch('/api/cancel-current-run', { method: 'POST' }).catch(() => {});
        } finally {
            processingModal.style.display = 'none';
            modalOkBtn.style.display = 'none';
            closeModal.classList.add('disabled');
        }
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
    
    // Property cohorts for bimonthly water billing
    const PROPERTY_COHORTS = {
        // Windows ending in even months (Jan–Feb, Mar–Apr, May–Jun, Jul–Aug, Sep–Oct, Nov–Dec)
        // apply to these properties:
        EVEN: ['Llull', 'Blasco', 'Torrent', 'Bisbe', 'Aribau', 'Comte', 'Borrell'],
        // Windows ending in odd months (Feb–Mar, Apr–May, Jun–Jul, Aug–Sep, Oct–Nov, Dec–Jan)
        // apply to these properties:
        ODD: ['Padilla', 'Sardenya', 'Valencia', 'Sant Joan', 'St Joan', 'Providencia']
    };

    // Determine cohort from month pair (second month determines cohort)
    function getCohortForPeriod(targetMonths) {
        const secondMonth = targetMonths[1];
        // EVEN cohort: Jan-Feb(2), Mar-Apr(4), May-Jun(6), Jul-Aug(8), Sep-Oct(10), Nov-Dec(12) - ending in even months
        // ODD cohort: Feb-Mar(3), Apr-May(5), Jun-Jul(7), Aug-Sep(9), Oct-Nov(11), Dec-Jan(1) - ending in odd months
        const evenMonths = [2, 4, 6, 8, 10, 12];
        return evenMonths.includes(secondMonth) ? 'EVEN' : 'ODD';
    }

    // Check if property belongs to cohort
    function isPropertyInCohort(propertyName, cohort) {
        const properties = PROPERTY_COHORTS[cohort] || [];
        return properties.some(p => propertyName.toLowerCase().includes(p.toLowerCase()));
    }

    function loadProperties() {
        if (!excelData || excelData.length === 0) {
            document.getElementById('propertiesList').innerHTML = '<p>No data available</p>';
            return;
        }
        
        const propertiesList = document.getElementById('propertiesList');
        propertiesList.innerHTML = '';
        
        // Get property names, room counts, and unit codes from first three columns
        const allProperties = excelData
            .slice(1) // Remove header row
            .map(row => ({
                name: row[0] ? row[0].toString().trim() : '',
                rooms: row[1] ? parseInt(row[1]) || 0 : 0,
                unitCode: row[2] ? row[2].toString().trim() : ''
            }))
            .filter(prop => prop.name !== ''); // Remove empty property names
        
        if (allProperties.length === 0) {
            propertiesList.innerHTML = '<p>No property names found in the first column</p>';
            return;
        }

        // Filter properties by cohort based on selected period
        const period = document.getElementById('monthPair')?.value || 'Jul-Aug';
        const periodMap = {
            'Jan-Feb': [1, 2], 'Feb-Mar': [2, 3], 'Mar-Apr': [3, 4],
            'Apr-May': [4, 5], 'May-Jun': [5, 6], 'Jun-Jul': [6, 7],
            'Jul-Aug': [7, 8], 'Aug-Sep': [8, 9], 'Sep-Oct': [9, 10],
            'Oct-Nov': [10, 11], 'Nov-Dec': [11, 12], 'Dec-Jan': [12, 1]
        };
        const targetMonths = periodMap[period] || [7, 8];
        const cohort = getCohortForPeriod(targetMonths);
        
        const properties = allProperties.filter(prop => isPropertyInCohort(prop.name, cohort));
        const hiddenCount = allProperties.length - properties.length;
        
        // Show filtering note if properties were hidden
        if (hiddenCount > 0) {
            const noteDiv = document.createElement('div');
            noteDiv.style.cssText = 'background: #e3f2fd; border: 1px solid #2196f3; border-radius: 4px; padding: 8px; margin-bottom: 12px; font-size: 14px; color: #1565c0;';
            noteDiv.innerHTML = `ℹ️ ${hiddenCount} properties hidden - not in ${cohort} cohort for ${period} period`;
            propertiesList.appendChild(noteDiv);
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

        // Re-filter properties when period changes
        const monthPairSelect = document.getElementById('monthPair');
        monthPairSelect.addEventListener('change', function() {
            loadProperties(); // Re-run filtering
        });

        // Override process handler to use selection (single full run)
        processBtn.removeEventListener('click', defaultProcessClick);
        processBtn.removeEventListener('click', window._currentProcessHandler);
        
        window._currentProcessHandler = async function() {
            const period = document.getElementById('monthPair')?.value || 'Jul-Aug';
            const limit10 = document.getElementById('limit10')?.checked || false;
            const selectedProps = properties.filter(p => selected.has(p.name));
            window._selectedProperties = new Set(selectedProps.map(p => p.name));
            if (selectedProps.length === 0) { showMessage('Please select at least one property', 'error'); return; }

            const propsToProcess = limit10 ? selectedProps.slice(0, 10) : selectedProps;

            showProcessingModal('Processing Properties');
            try { if (window._sse) { window._sse.close(); } } catch(_) {}
            await processProperties(propsToProcess, period);
        };
        
        processBtn.addEventListener('click', window._currentProcessHandler);
    }
    
    function showProcessingModal(title = 'Processing Properties') {
        processingModal.style.display = 'flex';
        modalTitle.textContent = title;
        document.getElementById('logContent').innerHTML = '';
        document.getElementById('progressFill').style.width = '0%';
        document.getElementById('progressText').textContent = '0%';
        // Allow cancel via close icon while running
        closeModal.classList.remove('disabled');
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
        // Prevent multiple simultaneous requests
        if (window._processingInProgress) {
            addLogEntry('Processing already in progress, please wait...', 'warning');
            return;
        }
        
        window._processingInProgress = true;
        
        try {
            // No automatic cancellation - let the backend nuclear option handle it
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
                        if (data.type === 'error_summary') displayErrorSummary(data.properties);
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
            
            // Save results to localStorage for session persistence
            try { 
                localStorage.setItem('polmonk:lastResults', JSON.stringify(data.results));
                localStorage.setItem('polmonk:lastProcessedPeriod', period);
                localStorage.setItem('polmonk:lastProcessedLimit10', limit10);
            } catch(_) {}
            
            // Keep modal open with OK button
            closeModal.classList.remove('disabled');
            modalOkBtn.style.display = 'block';
            
        } catch (error) {
            console.error('Processing error:', error);
            addLogEntry(`Error: ${error.message}`, 'error');
            updateProgress(0);
        } finally {
            // Always clear the processing flag
            window._processingInProgress = false;
        }
    }

    // Batch processing (disabled) - kept for reference but not used now
    async function processPropertiesBatch(properties, period, batchNumber = 1) {
        try {
            // Ensure the log modal is visible for every batch
            try { showProcessingModal(`Batch ${batchNumber} Processing`); } catch(_) {}
            const BATCH_SIZE = 15;
            const totalBatches = Math.ceil(properties.length / BATCH_SIZE);
            
            addLogEntry(`Starting batch processing: ${totalBatches} batches of up to ${BATCH_SIZE} properties each`, 'info');
            addLogEntry(`Processing batch ${batchNumber}/${totalBatches}...`, 'info');
            
            // Show initial progress
            updateProgress(10);
            addLogEntry('Sending batch request to server...', 'info');
            
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
                        if (data.type === 'error_summary') displayErrorSummary(data.properties);
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
                throw new Error(`Batch processing failed: ${errText}`);
            }
            
            updateProgress(30);
            addLogEntry('Server is processing batch...', 'info');
            addLogEntry('This may take several minutes...', 'info');
            
            const data = await response.json();
            
            if (!data.success) {
                addLogEntry(`Server failure: ${data.message || 'Unknown error'}`, 'error');
                throw new Error(data.message || 'Batch processing failed');
            }
            
            updateProgress(80);
            addLogEntry(`Processing completed!`, 'success');
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
            try {
                localStorage.setItem('polmonk:lastResults', JSON.stringify(data.results));
                localStorage.setItem('polmonk:lastProcessedPeriod', period);
            } catch(_) {}
            
            // Keep modal open with OK button
            closeModal.classList.remove('disabled');
            modalOkBtn.style.display = 'block';
            
        } catch (error) {
            console.error('Batch processing error:', error);
            addLogEntry(`Error: ${error.message}`, 'error');
            updateProgress(0);
        }
    }
    
    function displayErrorSummary(errors) {
        if (!errors || errors.length === 0) return;
        
        const resultsContainer = document.getElementById('resultsContainer');
        const resultsList = document.getElementById('resultsList');
        
        // Create error summary element
        const summaryDiv = document.createElement('div');
        summaryDiv.className = 'error-summary';
        summaryDiv.innerHTML = `
            <h3>⚠️ Properties with Processing Issues (${errors.length})</h3>
            <ul>
                ${errors.map(err => `
                    <li>
                        <strong>${err.property}</strong>
                        <ul>
                            ${err.issues.map(issue => `<li>${issue}</li>`).join('')}
                        </ul>
                    </li>
                `).join('')}
            </ul>
        `;
        
        // Insert at the top of results
        resultsList.insertBefore(summaryDiv, resultsList.firstChild);
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
            
            // Add warnings section if present
            if (result.warnings && result.warnings.length > 0) {
                const warningsDiv = document.createElement('div');
                const isLLM = result.warnings.some(w => w.includes('LLM-assisted'));
                const bgColor = isLLM ? '#e3f2fd' : '#fff3cd';
                const borderColor = isLLM ? '#2196f3' : '#ffc107';
                const textColor = isLLM ? '#1565c0' : '#856404';
                const icon = isLLM ? '🤖' : '⚠️';
                
                warningsDiv.style.cssText = `grid-column: 1/-1; background: ${bgColor}; border-left: 3px solid ${borderColor}; padding: 8px; margin-top: 8px; border-radius: 4px;`;
                warningsDiv.innerHTML = `
                    <div style="font-weight: 600; color: ${textColor}; margin-bottom: 4px;">${icon} ${isLLM ? 'AI Analysis' : 'Validation Warnings'}:</div>
                    ${result.warnings.map(w => `<div style="color: ${textColor}; font-size: 13px;">• ${w}</div>`).join('')}
                `;
                resultItem.appendChild(warningsDiv);
            }
            
            resultsList.appendChild(resultItem);
        });
        
        // Add export button for HouseMonk testing (TEMPORARY)
        // Button 1 removed - not useful
        
        // Old buttons removed: we now only expose the End-to-End action

        // New: End-to-End Button (single full run based on last results)
        const endToEndBtn = document.createElement('button');
        endToEndBtn.className = 'submit-btn';
        endToEndBtn.style.marginTop = '10px';
        endToEndBtn.style.backgroundColor = '#d97706';
        endToEndBtn.textContent = '⚡ Step 2 (Fast): Download + Create Invoices (End-to-End)';
        endToEndBtn.onclick = async () => {
            try {
                showProcessingModal('End-to-End: Download → Upload → Create Invoices');
                addLogEntry('Starting end-to-end run...', 'info');

                // Open SSE for logs
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

                // Use results from last full run
                const results = JSON.parse(localStorage.getItem('polmonk:lastResults') || '[]');
                const filtered = (window._selectedProperties && window._selectedProperties.size)
                    ? results.filter(r => window._selectedProperties.has(r.property))
                    : results;

                addLogEntry(`Found ${filtered.length} properties to process`, 'info');
                addLogEntry(`Properties with overuse: ${filtered.filter(r => r.overuse_amount > 0).length}`, 'info');

                // Call end-to-end endpoint
                const response = await fetch('/api/run-overuse-end-to-end', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ results: filtered })
                });
                const data = await response.json();

                if (!response.ok || !data.success) {
                    addLogEntry(`❌ End-to-end failed: ${data.message || response.statusText}`, 'error');
                } else {
                    addLogEntry(`✅ End-to-end completed: ${data.successCount} successful, ${data.failedCount} failed`, 'success');
                    if (Array.isArray(data.items)) {
                        addLogEntry('🔗 Created Invoices:', 'info');
                        data.items.forEach((item, i) => {
                            if (item.status === 'success') {
                                addLogEntry(`  ${i+1}. ${item.property}: ${item.invoiceUrl}`, 'success');
                            } else {
                                addLogEntry(`  ${i+1}. ${item.property}: FAILED - ${item.error}`, 'error');
                            }
                        });
                    }
                }

                closeModal.classList.remove('disabled');
                modalOkBtn.style.display = 'block';
            } catch (error) {
                addLogEntry(`❌ End-to-end error: ${error.message}`, 'error');
                closeModal.classList.remove('disabled');
                modalOkBtn.style.display = 'block';
            }
        };
        resultsList.appendChild(endToEndBtn);
        
        resultsContainer.style.display = 'block';

        // Button 3 is always available - no need to check AWS data
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