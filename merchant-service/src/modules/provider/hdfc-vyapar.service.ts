import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HdfcCryptoUtil } from './hdfc-crypto.util';
import * as crypto from 'crypto';

@Injectable()
export class HdfcVyaparService {
  private readonly logger = new Logger(HdfcVyaparService.name);
  private readonly API_URL = "https://www.hdfcbankvyapar.com/api/secure-data-fetch";
  private tidCache = new Map<string, { tids: string[], expiresAt: number }>();

  constructor(private readonly cryptoUtil: HdfcCryptoUtil) {}

  /**
   * Internal helper to make encrypted calls to the HDFC secure proxy.
   */
  private async executeSecureCall(payloadObj: Record<string, any>) {
    try {
      this.logger.debug(`Executing secure call to HDFC: ${payloadObj.url}`);
      
      const pem = await this.cryptoUtil.fetchPublicKey();
      
      const aesKey = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const uid = aesKey.toString('base64') + "_" + Date.now();
      
      const finalPayload = { ...payloadObj, uid, allowBodyStringify: true };
      
      const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
      let encryptedPayload = cipher.update(JSON.stringify(finalPayload), 'utf8');
      encryptedPayload = Buffer.concat([encryptedPayload, cipher.final()]);
      
      const reqBody = {
        PAYLOAD: Buffer.concat([encryptedPayload, cipher.getAuthTag()]).toString('base64'),
        KEY: crypto.publicEncrypt({key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'}, aesKey).toString('base64'),
        IV: crypto.publicEncrypt({key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256'}, iv).toString('base64')
      };

      let response: Response;
      let lastError: any;
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await fetch(this.API_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Accept": "application/json",
              "Connection": "close",
              ...(payloadObj.headers || {})
            },
            body: JSON.stringify(reqBody),
            signal: AbortSignal.timeout(10000) // 10 second timeout per attempt
          });
          break; // network success
        } catch (err: any) {
          lastError = err;
          this.logger.warn(`HDFC API fetch attempt ${attempt} failed: ${err.message}`);
          if (attempt === 3) throw err;
          await new Promise(res => setTimeout(res, 1000 * attempt)); // backoff
        }
      }

      const text = await response.text();

      if (!response.ok) {
        this.logger.error(`HDFC API Error: HTTP ${response.status}`, text);
        throw new Error(`HDFC API returned status ${response.status}`);
      }

      const resJson = JSON.parse(text);

      if (resJson.error) {
         this.logger.error(`HDFC API returned error message:`, resJson.error);
         throw new BadRequestException(resJson.error);
      }

      if (resJson.PAYLOAD) {
        return this.cryptoUtil.decryptResponse(resJson.PAYLOAD, aesKey, iv);
      }

      return resJson;
    } catch (error) {
      this.logger.error(`Failed to execute secure call to HDFC:`, error.message);
      throw new BadRequestException(`HDFC Vyapar integration error: ${error.message}`);
    }
  }

  /**
   * Generates and sends OTP to the merchant's mobile number.
   */
  async sendOtp(mobileNumber: string, deviceId?: string) {
    this.logger.log(`Sending HDFC Vyapar OTP to ${mobileNumber}`);
    
    if (!deviceId) {
      deviceId = crypto.randomBytes(16).toString('hex');
    }

    const payload = {
      url: "VALIDATE_USER",
      method: "POST",
      type: true,
      body: {
        appVersion: "1.0.0",
        devicePlatform: "web",
        loginId: mobileNumber
      },
      headers: {
        "Content-Type": "application/json",
        "deviceId": deviceId
      }
    };

    const response = await this.executeSecureCall(payload);
    this.logger.debug("Send OTP response:", response);

    if (response?.status === "Success" || response?.statusCode === "L102" || response?.statusCode === "L120") {
       return { 
         success: true, 
         message: response.respMessage || "OTP sent successfully",
         data: {
           sessionId: response.sessionId,
           deviceId: deviceId,
           isMpinSet: response.isMpinSet,
           loginName: response.loginName
         }
       };
    }
    
    if (response?.status === "Failed") {
      throw new BadRequestException(response.respMessage || "Failed to send OTP");
    }

    throw new Error("Unexpected response from HDFC");
  }

  /**
   * Verifies the OTP and returns the session/token data.
   */
  async verifyOtp(mobileNumber: string, otp: string, sessionId: string, deviceId: string, mPin?: string) {
    this.logger.log(`Verifying HDFC Vyapar OTP for ${mobileNumber}`);
    
    const resolvedMPin = mPin || otp;
    
    // We pass both otp and mPin as they seem to map the same way in their JS depending on flow
    const payload = {
      url: "VERIFY_OTP",
      method: "POST",
      type: true,
      body: {
        appVersion: "1.0.0",
        devicePlatform: "web",
        loginId: mobileNumber,
            otp: otp,
        mPin: resolvedMPin
      },
      headers: {
        "Content-Type": "application/json",
        "deviceId": deviceId,
        "sessionId": sessionId
      }
    };

    this.logger.debug(`[HDFC VERIFY] Session ID: ${sessionId}`);
    this.logger.debug(`[HDFC VERIFY] Device ID: ${deviceId}`);

    const response = await this.executeSecureCall(payload);
    this.logger.debug("Verify OTP response:", response);

    if (response?.status === "Success" || response?.statusCode === "S101") {
        let upiId = mobileNumber;
        let fetchedVpa = null;
        
        const extractVpa = (resObj: any) => {
            const str = JSON.stringify(resObj);
            const matches = str.match(/"([a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+)"/g);
            if (matches) {
                for (const match of matches) {
                    const clean = match.replace(/"/g, '');
                    if (clean.toLowerCase().includes('hdfc') && !clean.toLowerCase().includes('support')) {
                        return clean;
                    }
                }
            }
            return null;
        };

        // Try USER_PROFILE
        try {
            const profileResponse = await this.executeSecureCall({
               url: "USER_PROFILE",
               method: "POST",
               type: true,
               body: { appVersion: "1.0.0", devicePlatform: "web", loginId: mobileNumber },
               headers: { "Content-Type": "application/json", "deviceId": deviceId, "sessionId": sessionId }
            });
            this.logger.debug(`USER_PROFILE response: ${JSON.stringify(profileResponse)}`);
            fetchedVpa = extractVpa(profileResponse);
        } catch (e) { }

        // Try GET_USER_TERMINAL_INFO with permutations
        let tidResponse = null;
        if (!fetchedVpa) {
            
      // Try VERIFY_PIN
      this.logger.debug("Testing VERIFY_PIN before user-terminal-info...");
      try {
        const verifyPinPayload = {
          url: "VERIFY_PIN",
          method: "POST",
          type: true,
          body: {
            appInstanceId: "112",
            authType: "mPin",
            loginId: mobileNumber,
            mPin: resolvedMPin,
            fcmToken: ""
          },
          headers: {
            "Content-Type": "application/json",
            "sessionId": sessionId
          }
        };
        const verifyPinRes = await this.executeSecureCall(verifyPinPayload);
        this.logger.debug("VERIFY_PIN Result:", verifyPinRes);
      } catch (e) {
        this.logger.error("VERIFY_PIN failed:", e.message);
      }

      try {
        const payload: any = {
          url: "GET_USER_TERMINAL_INFO",
          method: "POST",
          type: true,
          body: {},
          headers: {
            "Content-Type": "application/json",
            "sessionId": sessionId
          }
        };
        const res = await this.executeSecureCall(payload);
        this.logger.debug(`Result for GET_USER_TERMINAL_INFO: ${JSON.stringify(res)}`);
        
        if (res && res.status !== 401 && res.status !== 405 && res.status !== 500 && !res.error && (res.terminalInfo || res.user_profile)) {
          tidResponse = res;
        }
      } catch (e) {
        this.logger.error(`GET_USER_TERMINAL_INFO failed with exception: ${e.message}`);
      }

            if (tidResponse) {
                // Extract legalName and tid if available
                if (!fetchedVpa && tidResponse?.terminalInfo) {
                   const terminalObj = Array.isArray(tidResponse.terminalInfo) ? tidResponse.terminalInfo[0] : tidResponse.terminalInfo;
                   const tid = Object.keys(terminalObj)[0];
                   const terminalData = terminalObj[tid];
                   
                   const legalNameRaw = terminalData?.companyName || terminalData?.dba || terminalData?.legalName || terminalData?.merchantProfile?.legalName;
                   
                   if (tid && legalNameRaw) {
                       const legalName = String(legalNameRaw).replace(/\s+/g, '').substring(0, 20);
                       fetchedVpa = `${legalName}.${tid}@hdfcbank`.toUpperCase();
                       this.logger.debug(`Constructed VPA from GET_USER_TERMINAL_INFO: ${fetchedVpa}`);
                   }
                } else if (!fetchedVpa && tidResponse?.user_profile) {
                   // Fallback to checking if it's deeply nested
                   const firstKey = Object.keys(tidResponse.user_profile)[0];
                   const profile = firstKey ? tidResponse.user_profile[firstKey] : null;
                   if (profile && profile.legalName && profile.tid) {
                       const legalName = String(profile.legalName).replace(/\s+/g, '').substring(0, 20);
                       const tid = profile.tid;
                       fetchedVpa = `${legalName}.${tid}@hdfcbank`.toUpperCase();
                       this.logger.debug(`Constructed VPA from GET_USER_TERMINAL_INFO (user_profile): ${fetchedVpa}`);
                   }
                }
            }
                
                if (!fetchedVpa) {
                   fetchedVpa = extractVpa(tidResponse);
                }
            
        }

        // Try GET_OUTLETS (data-mapper)
        let outletsResponse = null;
        if (!fetchedVpa) {
            try {
                const payload: any = {
                    url: "GET_OUTLETS",
                    method: "POST",
                    type: true,
                    body: {},
                    headers: {
                        "Content-Type": "application/json",
                        "sessionId": sessionId
                    }
                };
                const res = await this.executeSecureCall(payload);
                this.logger.debug(`Result for GET_OUTLETS: ${JSON.stringify(res)}`);
                
                if (res && res.status !== 401 && res.status !== 405 && res.status !== 500 && !res.error) {
                    outletsResponse = res;
                }
            } catch (e) {
                this.logger.error(`GET_OUTLETS failed with exception: ${e.message}`);
            }

            if (outletsResponse) {
                fetchedVpa = extractVpa(outletsResponse);
                // If regex didn't find VPA but we found Legal Name & TID, construct it!
                if (!fetchedVpa && outletsResponse?.merchantName && outletsResponse?.tid) {
                   // This is just a fallback in case it's in a different format
                   const legalName = String(outletsResponse.merchantName).replace(/\s+/g, '').substring(0, 20);
                   const tid = outletsResponse.tid;
                   fetchedVpa = `${legalName}.${tid}@hdfcbank`.toUpperCase();
                   this.logger.debug(`Constructed VPA from Outlets: ${fetchedVpa}`);
                }
            } // Close if (outletsResponse)
        }

        if (fetchedVpa) {
            upiId = fetchedVpa.toLowerCase();
            this.logger.log(`✅ Found HDFC VPA: ${upiId}`);
        } else {
            this.logger.warn(`⚠️ Could not find HDFC VPA, defaulting to mobile number.`);
        }

        let extractedMerchantData = null;
        if (tidResponse?.terminalInfo) {
           const terminalObj = Array.isArray(tidResponse.terminalInfo) ? tidResponse.terminalInfo[0] : tidResponse.terminalInfo;
           const tid = Object.keys(terminalObj)[0];
           extractedMerchantData = terminalObj[tid];
        } else if (outletsResponse) {
           extractedMerchantData = outletsResponse;
        }

        return {
            success: true,
            accountDetails: response.accountDetails || response,
            sessionId: sessionId,
            deviceId: deviceId,
            upiId: upiId,
            merchantData: extractedMerchantData
        };
    }
    
    if (response?.status === "Failed") {
       throw new BadRequestException(response.respMessage || "Invalid OTP provided");
    }

    throw new BadRequestException("Verification failed");
  }

  /**
   * Fetch Merchant details once logged in
   */
  async fetchMerchantDetails(sessionId: string, deviceId: string) {
     let successfulResponse = null;
     try {
         const payload: any = {
            url: "GET_USER_TERMINAL_INFO",
            method: "POST",
            type: true,
            body: {},
            headers: {
                "Content-Type": "application/json",
                "sessionId": sessionId
            }
         };

         const res = await this.executeSecureCall(payload);
         
         if (res && res.status !== 401 && res.status !== 405 && !res.error && res.terminalInfo) {
             successfulResponse = res;
         }
     } catch (e) {
         this.logger.error(`GET_USER_TERMINAL_INFO failed with exception: ${e.message}`);
     }
     return successfulResponse;
  }

  /**
   * Refresh an expired HDFC session by re-authenticating with mobileNumber + mPin.
   * Returns a new { sessionId, deviceId } or null on failure.
   */
  async refreshSession(mobileNumber: string, mPin: string, existingDeviceId?: string): Promise<{ sessionId: string; deviceId: string } | null> {
    this.logger.log(`🔄 Refreshing HDFC session for ${mobileNumber}`);

    const deviceId = existingDeviceId || crypto.randomBytes(16).toString('hex');

    try {
      if (!mPin || mPin.length !== 4) {
        this.logger.warn(`⚠️ Cannot refresh HDFC session for ${mobileNumber} - mPin is missing or is an OTP instead of a 4-digit mPin.`);
        return null; // Return null so the system marks the provider as EXPIRED eventually.
      }

      // Step 1: VALIDATE_USER to get a new sessionId
      const validatePayload = {
        url: "VALIDATE_USER",
        method: "POST",
        type: true,
        body: {
          appVersion: "1.0.0",
          deviceId: deviceId,
          devicePlatform: "web",
          loginId: mobileNumber,
        },
        headers: {
          "Content-Type": "application/json",
          "deviceId": deviceId,
        },
      };

      const validateRes = await this.executeSecureCall(validatePayload);

      if (!validateRes?.sessionId) {
        this.logger.warn(`⚠️ HDFC VALIDATE_USER did not return sessionId: ${JSON.stringify(validateRes)}`);
        return null;
      }

      const newSessionId = validateRes.sessionId;

      // Step 2: VERIFY_MPIN to authenticate the session
      const verifyPayload = {
        url: "VERIFY_MPIN",
        method: "POST",
        type: true,
        body: {
          appInstanceId: "112",
          authType: "mPin",
          loginId: mobileNumber,
          mPin: mPin,
          fcmToken: "",
        },
        headers: {
          "Content-Type": "application/json",
          "deviceId": deviceId,
          "sessionId": newSessionId,
        },
      };

      const verifyRes = await this.executeSecureCall(verifyPayload);

      if (verifyRes?.status === "Success" || verifyRes?.statusCode === "S101") {
        this.logger.log(`✅ HDFC session refreshed successfully for ${mobileNumber}`);
        return { sessionId: newSessionId, deviceId };
      }

      this.logger.warn(`⚠️ HDFC VERIFY_MPIN failed: ${JSON.stringify(verifyRes)}`);
      return null;
    } catch (error) {
      this.logger.error(`❌ HDFC session refresh failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch terminal info (TIDs) for the authenticated session.
   */
  async fetchTerminalInfo(sessionId: string): Promise<string[]> {
    const cached = this.tidCache.get(sessionId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.tids;
    }

    try {
      const res = await this.executeSecureCall({
        url: "GET_USER_TERMINAL_INFO",
        method: "POST",
        type: true,
        body: {},
        headers: {
          "Content-Type": "application/json",
          "sessionId": sessionId,
        }
      });

      if (res?.terminalInfo) {
        const terminalObj = Array.isArray(res.terminalInfo) ? res.terminalInfo[0] : res.terminalInfo;
        const tids = Object.keys(terminalObj);
        // Cache for 15 minutes
        this.tidCache.set(sessionId, { tids, expiresAt: Date.now() + 15 * 60000 });
        return tids;
      }

      return [];
    } catch (e) {
      this.logger.warn(`Could not fetch HDFC terminal info: ${e.message}`);
      return [];
    }
  }

  /**
   * Fetch transaction history from HDFC Vyapar.
   * Uses GET_TRANSACTIONS endpoint which returns actual raw transactions.
   */
  async fetchTransactionHistory(
    sessionId: string,
    deviceId: string,
    startDate: string,
    endDate: string,
    tidList?: string[],
  ): Promise<{ transactions: any[]; sessionExpired: boolean }> {
    try {
      let tids = tidList;
      if (!tids || tids.length === 0) {
        this.logger.debug(`No TIDs provided for sync, fetching from GET_USER_TERMINAL_INFO...`);
        tids = await this.fetchTerminalInfo(sessionId);
      }

      this.logger.debug(`Fetching HDFC transactions: ${startDate} to ${endDate}, tids=${tids?.join(',') || 'all'}`);

      const payload = {
        url: "GET_TRANSACTIONS",
        method: "POST",
        type: true,
        removeDeviceId: true,
        body: {
          txnsType: ["SaleSuccess"],
          type: "terminal",
          startDate,
          endDate,
          paymentType: ["Cards", "UPI", "BharatQR", "SMS Pay", "Cash"],
          tidList: tids && tids.length > 0 ? tids : null,
        },
        headers: {
          "Content-Type": "application/json",
          "sessionId": sessionId,
        }
      };

      const res = await this.executeSecureCall(payload);

      // Check for session expiry indicators
      if (res?.status === 401 || res?.error === "Unauthorized" || res?.message === "Invalid Request" && res?.errorCode === "P101" && (!tids || tids.length === 0)) {
         // Note: Invalid Request happens if tidList is null, which shouldn't happen now, but keeping check
      }
      
      if (res?.status === 401 || res?.error === "Unauthorized") {
        this.logger.warn(`HDFC session expired during transaction fetch`);
        return { transactions: [], sessionExpired: true };
      }

      // Extract transactions from response
      let transactions: any[] = [];
      if (res?.transactionParams) {
        transactions = res.transactionParams;
      } else if (res?.transactions) {
        transactions = res.transactions;
      } else if (res?.data && Array.isArray(res.data)) {
        transactions = res.data;
      } else if (res?.txnList && Array.isArray(res.txnList)) {
        transactions = res.txnList;
      } else if (res?.statusCode === "S101" && res?.transactionList) {
        transactions = res.transactionList;
      }

      this.logger.log(`📊 HDFC returned ${transactions.length} transactions for ${startDate} to ${endDate}`);

      return { transactions, sessionExpired: false };
    } catch (error) {
      // 500 errors from call.js typically mean expired session
      if (error.message?.includes('500') || error.message?.includes('call.js')) {
        this.logger.warn(`HDFC session likely expired (500 from call.js)`);
        return { transactions: [], sessionExpired: true };
      }
      this.logger.error(`❌ HDFC fetchTransactionHistory failed: ${error.message}`);
      return { transactions: [], sessionExpired: false };
    }
  }
}
