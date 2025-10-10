const axios = require('axios');

// Configuration - use environment variables or fallback to sandbox
const CONFIG = {
    baseUrl: process.env.HM_BASE_URL || 'https://qa1.thehousemonk.com',
    clientId: process.env.HM_CLIENT_ID || '3a93c900-a2a6-11f0-9ce0-5b6f0a5d9d66',
    clientSecret: process.env.HM_CLIENT_SECRET || '94d8d0ba-e92f-41ea-8642-d285852bb764',
    userId: process.env.HM_USER_ID || '68e3a508243a303bfc36884f'
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
            // Get home details
            const homeResponse = await this.auth.makeAuthenticatedRequest('GET', `/api/home/${unitCode}`);
            const home = homeResponse.data;
            
            const result = {
                unitCode: unitCode,
                homeId: home._id,
                projectId: home.project,
                listingId: home.listing,
                tenantId: home.tenant?._id || home.tenant,
                propertyName: home.name || home.address,
                tenantName: home.tenant?.firstName ? `${home.tenant.firstName} ${home.tenant.lastName}` : 'Unknown'
            };

            console.log('✅ Resolved IDs:', result);
            this.cache.set(unitCode, result);
            return result;
        } catch (error) {
            console.error('❌ Failed to resolve IDs from unit:', error.response?.data?.message || error.message);
            throw error;
        }
    }

    async getProductsForProject(projectId) {
        console.log(`📦 Fetching products for project: ${projectId}`);
        
        try {
            const response = await this.auth.makeAuthenticatedRequest('GET', `/api/product-and-service?projects=${projectId}`);
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
            const response = await this.auth.makeAuthenticatedRequest('GET', `/api/tax?projects=${projectId}`);
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
            const response = await this.auth.makeAuthenticatedRequest('GET', '/api/home');
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

