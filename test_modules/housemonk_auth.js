const axios = require('axios');

// Environment configuration - switch between sandbox and production
const ENVIRONMENT = process.env.HM_ENVIRONMENT || 'sandbox';

const SANDBOX_CONFIG = {
    baseUrl: 'https://qa1.thehousemonk.com',
    clientId: '3a93c900-a2a6-11f0-9ce0-5b6f0a5d9d66',
    clientSecret: '94d8d0ba-e92f-41ea-8642-d285852bb764',
    userId: '68e3a508243a303bfc36884f'
};

const PRODUCTION_CONFIG = {
    baseUrl: 'https://dashboard.thehousemonk.com',
    clientId: '1326bbe0-8ed1-11f0-b658-7dd414f87b53',
    clientSecret: '94d8d0ba-e92f-41ea-8642-d285852bb764', // Same as sandbox
    userId: '6891dfbf052d1d7f336d0d62'
};

// Configuration - use environment variables or fallback to environment-specific config
const CONFIG = {
    baseUrl: process.env.HM_BASE_URL || (ENVIRONMENT === 'production' ? PRODUCTION_CONFIG.baseUrl : SANDBOX_CONFIG.baseUrl),
    clientId: process.env.HM_CLIENT_ID || (ENVIRONMENT === 'production' ? PRODUCTION_CONFIG.clientId : SANDBOX_CONFIG.clientId),
    clientSecret: process.env.HM_CLIENT_SECRET || (ENVIRONMENT === 'production' ? PRODUCTION_CONFIG.clientSecret : SANDBOX_CONFIG.clientSecret),
    userId: process.env.HM_USER_ID || (ENVIRONMENT === 'production' ? PRODUCTION_CONFIG.userId : SANDBOX_CONFIG.userId),
    environment: ENVIRONMENT
};

// Enhanced authentication with auto-refresh
class HouseMonkAuth {
    constructor() {
        this.config = CONFIG;
        this.masterToken = null;
        this.userToken = null;
        this.tokenExpiry = null;
    }

    async refreshMasterToken() {
        try {
            console.log('🔄 Refreshing master token...');
            
            const requestUrl = `${this.config.baseUrl}/api/client/refresh-token`;
            const requestBody = {
                clientId: this.config.clientId,
                clientSecret: this.config.clientSecret
            };
            
            console.log('📤 Master Token Request:');
            console.log('  URL:', requestUrl);
            console.log('  Method: POST');
            console.log('  Body:', JSON.stringify(requestBody, null, 2));
            
            const response = await axios.post(requestUrl, requestBody);
            
            console.log('📥 Master Token Response:');
            console.log('  Status:', response.status);
            console.log('  Data:', JSON.stringify(response.data, null, 2));
            
            this.masterToken = response.data.token;
            this.tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
            
            console.log('✅ Master token refreshed successfully');
            console.log('  Token (first 50 chars):', this.masterToken.substring(0, 50) + '...');
            return this.masterToken;
        } catch (error) {
            console.error('❌ Failed to refresh master token:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    async getUserAccessToken(userId) {
        try {
            if (!this.masterToken || this.isTokenExpired()) {
                await this.refreshMasterToken();
            }

            console.log(`🔑 Getting user access token for user: ${userId}`);
            
            const requestUrl = `${this.config.baseUrl}/integration/glynk/access-token`;
            const requestBody = { user: userId };
            const requestHeaders = {
                'x-api-key': this.config.clientId,
                'Authorization': this.masterToken,
                'Content-Type': 'application/json'
            };
            
            console.log('📤 API Request Details:');
            console.log('  URL:', requestUrl);
            console.log('  Method: POST');
            console.log('  Headers:', JSON.stringify(requestHeaders, null, 2));
            console.log('  Body:', JSON.stringify(requestBody, null, 2));
            console.log('  Master Token (first 50 chars):', this.masterToken.substring(0, 50) + '...');
            
            const response = await axios.post(requestUrl, requestBody, {
                headers: requestHeaders
            });
            
            console.log('📥 API Response Details:');
            console.log('  Status:', response.status);
            console.log('  Headers:', JSON.stringify(response.headers, null, 2));
            console.log('  Data:', JSON.stringify(response.data, null, 2));

            this.userToken = response.data[0].accessToken;
            console.log('✅ User access token obtained');
            console.log('  User Token (first 50 chars):', this.userToken.substring(0, 50) + '...');
            return this.userToken;
        } catch (error) {
            console.error('❌ Failed to get user access token:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    isTokenExpired() {
        if (!this.tokenExpiry) return true;
        return new Date() >= this.tokenExpiry;
    }

    async makeAuthenticatedRequest(method, endpoint, data = null, useUserToken = false) {
        try {
            const token = useUserToken ? this.userToken : this.masterToken;
            
            if (!token || this.isTokenExpired()) {
                await this.refreshMasterToken();
                if (useUserToken) {
                    await this.getUserAccessToken(this.config.userId);
                }
            }

            const requestUrl = `${this.config.baseUrl}${endpoint}`;
            const requestHeaders = {
                'Authorization': useUserToken ? this.userToken : this.masterToken,
                'x-api-key': this.config.clientId,
                'Content-Type': 'application/json'
            };
            
            const config = {
                method,
                url: requestUrl,
                headers: requestHeaders
            };

            if (data) {
                config.data = data;
            }
            
            console.log('📤 Authenticated API Request:');
            console.log('  URL:', requestUrl);
            console.log('  Method:', method);
            console.log('  Headers:', JSON.stringify(requestHeaders, null, 2));
            console.log('  Body:', data ? JSON.stringify(data, null, 2) : 'None');
            console.log('  Token Type:', useUserToken ? 'User Token' : 'Master Token');
            console.log('  Token (first 50 chars):', (useUserToken ? this.userToken : this.masterToken)?.substring(0, 50) + '...');

            const response = await axios(config);
            
            console.log('📥 Authenticated API Response:');
            console.log('  Status:', response.status);
            console.log('  Data (first 500 chars):', JSON.stringify(response.data, null, 2).substring(0, 500) + '...');
            
            return response;
        } catch (error) {
            if (error.response?.status === 401) {
                console.log('🔄 401 Error - Attempting token refresh...');
                await this.refreshMasterToken();
                if (useUserToken) {
                    await this.getUserAccessToken(this.config.userId);
                }
                
                // Retry the request
                const retryConfig = {
                    method,
                    url: `${this.config.baseUrl}${endpoint}`,
                    headers: {
                        'authorization': useUserToken ? this.userToken : this.masterToken,
                        'x-api-key': this.config.clientId,
                        'content-type': 'application/json'
                    }
                };
                if (data) retryConfig.data = data;
                
                return await axios(retryConfig);
            }
            throw error;
        }
    }
}

// ID Resolution System
class HouseMonkIDResolver {
    constructor(auth) {
        this.auth = auth;
        this.cache = new Map();
    }

    async resolveFromUnitCode(unitCode) {
        console.log(`🔍 Resolving IDs from unit code: ${unitCode}`);
        
        try {
            // Try getting listing details first (since unitCode might be a listing ID)
            let listingData = null;
            try {
                const listingResponse = await this.auth.makeAuthenticatedRequest('GET', `/api/listing/${unitCode}`, null, true);
                listingData = listingResponse.data;
                console.log('✅ Found as listing:', listingData.name || listingData.address);
            } catch (listingError) {
                console.log('⚠️ Not a listing, trying as home...');
            }
            
            // Try getting home details
            let homeData = null;
            try {
                const homeResponse = await this.auth.makeAuthenticatedRequest('GET', `/api/home/${unitCode}`, null, true);
                homeData = homeResponse.data;
                console.log('✅ Found as home:', homeData.name || homeData.address);
            } catch (homeError) {
                console.log('⚠️ Not a home...');
            }
            
            // If we found a listing, search for the home (contract) linked to it
            if (listingData) {
                // Extract project ID if it's an object
                const projectId = typeof listingData.project === 'object' ? listingData.project._id : listingData.project;
                
                // Search for homes linked to this listing
                let homeId = null;
                let tenantId = null;
                let homeName = null;
                
                try {
                    // Try multiple query approaches
                    const homeQueries = [
                        `/api/home?listing=${unitCode}&limit=50`,
                        `/api/home?listings=${unitCode}&limit=50`,
                        `/api/home?project=${projectId}&limit=500`
                    ];
                    
                    for (const query of homeQueries) {
                        try {
                            const homesResponse = await this.auth.makeAuthenticatedRequest('GET', query, null, true);
                            const rows = homesResponse.data.rows || [];
                            
                            // Filter for homes linked to this specific listing
                            const matchingHomes = rows.filter(h => 
                                h.listing === unitCode || 
                                h.listing?._id === unitCode ||
                                (typeof h.listing === 'object' && h.listing._id === unitCode)
                            );
                            
                            if (matchingHomes.length > 0) {
                                // Prefer active with tenant, else with tenant, else any
                                const withTenantActive = matchingHomes.find(h => (h.status === "active") && (h.tenant?._id || h.tenant));
                                const withTenant = matchingHomes.find(h => (h.tenant?._id || h.tenant));
                                const chosen = withTenantActive || withTenant || matchingHomes[0];
                                
                                homeId = chosen._id;
                                tenantId = chosen.tenant?._id || chosen.tenant;
                                homeName = chosen.name || chosen.address;
                                console.log(`✅ Found home for listing: ${homeId}, tenant: ${tenantId || 'none'}`);
                                break;
                            }
                        } catch (err) {
                            // Try next query
                            continue;
                        }
                    }
                } catch (homeError) {
                    console.log('⚠️ Could not search for homes');
                }
                
                const result = {
                    unitCode: unitCode,
                    homeId: homeId,
                    projectId: projectId,
                    listingId: listingData._id,
                    tenantId: tenantId,
                    propertyName: listingData.doorNo || listingData.name || listingData.address,
                    tenantName: tenantId ? 'Found tenant' : 'No tenant found'
                };
                console.log('✅ Resolved from listing:', result);
                this.cache.set(unitCode, result);
                return result;
            }
            
            // If we found a home, use it
            if (homeData) {
                // Extract project ID if it's an object
                const projectId = typeof homeData.project === 'object' ? homeData.project._id : homeData.project;
                const result = {
                    unitCode: unitCode,
                    homeId: homeData._id,
                    projectId: projectId,
                    listingId: homeData.listing,
                    tenantId: homeData.tenant?._id || homeData.tenant,
                    propertyName: homeData.doorNo || homeData.name || homeData.address,
                    tenantName: homeData.tenant?.firstName ? `${homeData.tenant.firstName} ${homeData.tenant.lastName}` : 'Unknown'
                };
                console.log('✅ Resolved from home:', result);
                this.cache.set(unitCode, result);
                return result;
            }
            
            // Neither worked
            throw new Error('Unit not found as either listing or home');
        } catch (error) {
            console.error('❌ Failed to resolve IDs from unit:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    async getProductsForProject(projectId) {
        console.log(`📦 Fetching products for project: ${projectId}`);
        
        try {
            const response = await this.auth.makeAuthenticatedRequest('GET', `/api/product-and-service?projects=${projectId}`, null, true);
            const products = response.data.rows || [];
            
            console.log(`✅ Found ${products.length} products`);
            return products;
        } catch (error) {
            console.error('❌ Failed to fetch products:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    async getTaxCodesForProject(projectId) {
        console.log(`💰 Fetching tax codes for project: ${projectId}`);
        
        try {
            const response = await this.auth.makeAuthenticatedRequest('GET', `/api/tax?projects=${projectId}`, null, true);
            const taxCodes = response.data.rows || [];
            
            console.log(`✅ Found ${taxCodes.length} tax codes`);
            return taxCodes;
        } catch (error) {
            console.error('❌ Failed to fetch tax codes:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    async getAvailableUnits() {
        console.log('📋 Fetching all available units...');
        
        try {
            const response = await this.auth.makeAuthenticatedRequest('GET', '/api/home', null, true);
            const units = response.data.rows || [];
            
            console.log(`✅ Found ${units.length} units`);
            return units.map(unit => ({
                id: unit._id,
                name: unit.name || unit.address,
                project: unit.project,
                tenant: unit.tenant?.firstName ? `${unit.tenant.firstName} ${unit.tenant.lastName}` : 'No tenant'
            }));
        } catch (error) {
            console.error('❌ Failed to fetch units:', error.response?.data?.message || error.message);
            throw error;
        }
    }
}

module.exports = { HouseMonkAuth, HouseMonkIDResolver, CONFIG };

