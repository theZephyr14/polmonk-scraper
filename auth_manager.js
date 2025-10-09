const axios = require('axios');

class HouseMonkAuthManager {
    constructor() {
        this.masterToken = null;
        this.userToken = null;
        this.tokenExpiry = null;
        this.clientId = process.env.HM_CLIENT_ID;
        this.clientSecret = process.env.HM_CLIENT_SECRET;
        this.userId = process.env.HM_USER_ID;
    }

    async getValidMasterToken() {
        try {
            // Always get a fresh master token
            const response = await axios.post('https://dashboard.thehousemonk.com/api/client/refresh-token', {
                clientId: this.clientId,
                clientSecret: this.clientSecret
            });
            
            this.masterToken = response.data.token;
            return this.masterToken;
        } catch (error) {
            console.error('Failed to get master token:', error.response?.data || error.message);
            throw new Error(`Master token refresh failed: ${error.response?.data?.message || error.message}`);
        }
    }

    async getValidUserToken() {
        try {
            // Get fresh master token first
            const masterToken = await this.getValidMasterToken();
            
            // Get user access token
            const response = await axios.post('https://dashboard.thehousemonk.com/integration/glynk/access-token', 
                { user: this.userId },
                {
                    headers: {
                        'x-api-key': this.clientId,
                        'Authorization': `Bearer ${masterToken}`,
                        'Content-Type': 'application/json'
                    }
                }
            );
            
            this.userToken = response.data.accessToken || response.data.token;
            return this.userToken;
        } catch (error) {
            console.error('Failed to get user token:', error.response?.data || error.message);
            throw new Error(`User token refresh failed: ${error.response?.data?.message || error.message}`);
        }
    }

    getTokenStatus() {
        return {
            masterToken: Boolean(this.masterToken),
            userToken: Boolean(this.userToken),
            clientId: Boolean(this.clientId),
            userId: this.userId
        };
    }

    async makeAuthenticatedRequest(method, endpoint, data = null) {
        const userToken = await this.getValidUserToken();
        
        const config = {
            method,
            url: `https://dashboard.thehousemonk.com${endpoint}`,
            headers: {
                'x-api-key': this.clientId,
                'Authorization': `Bearer ${userToken}`,
                'Content-Type': 'application/json'
            }
        };
        
        if (data) {
            config.data = data;
        }
        
        const response = await axios(config);
        return response.data;
    }
}

module.exports = HouseMonkAuthManager;