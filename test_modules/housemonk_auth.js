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
            const response = await axios.post(`${this.config.baseUrl}/api/client/refresh-token`, {
                clientId: this.config.clientId,
                clientSecret: this.config.clientSecret
            });
            
            this.masterToken = response.data.token;
            this.tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
            
            console.log('✅ Master token refreshed successfully');
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
            const response = await axios.post(`${this.config.baseUrl}/integration/glynk/access-token`, {
                user: userId
            }, {
                headers: {
                    'x-api-key': this.config.clientId,
                    'authorization': `Bearer ${this.masterToken}`,
                    'content-type': 'application/json'
                }
            });

            this.userToken = response.data.accessToken;
            console.log('✅ User access token obtained');
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

            const config = {
                method,
                url: `${this.config.baseUrl}${endpoint}`,
                headers: {
                    'authorization': useUserToken ? this.userToken : this.masterToken,
                    'x-api-key': this.config.clientId,
                    'content-type': 'application/json'
                }
            };

            if (data) {
                config.data = data;
            }

            const response = await axios(config);
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

