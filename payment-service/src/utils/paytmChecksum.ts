import * as crypto from 'crypto';

export class PaytmChecksum {

    private static iv = "@@@@&&&&####$$$$";

    static encrypt(input: string, key: string): string {
        const cipher = crypto.createCipheriv('aes-128-cbc', key, this.iv);
        let encrypted = cipher.update(input, 'utf8', 'base64');
        encrypted += cipher.final('base64');
        return encrypted;
    }

    static decrypt(encrypted: string, key: string): string {
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, this.iv);
        let decrypted = decipher.update(encrypted, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }

    static generateSalt(length: number): string {
        const data = "AbcDE123IJKLMN67QRSTUVWXYZ" + "aBCdefghijklmn123opq45rs67tuv89wxyz" + "0FGH45OP89";
        let random = "";
        for (let i = 0; i < length; i++) {
            random += data.charAt(Math.floor(Math.random() * data.length));
        }
        return random;
    }

    private static calculateHash(params: string, salt: string): string {
        const finalString = params + "|" + salt;
        const hash = crypto.createHash('sha256').update(finalString).digest('hex');
        return hash + salt;
    }

    static generateSignature(params: Record<string, any>, key: string): string {
        const keys = Object.keys(params).sort();

        let paramStr = "";
        let flag = true;

        for (const k of keys) {
            const value = params[k];
            if (typeof value === 'object' || Array.isArray(value)) continue;
            // Skip CHECKSUMHASH if present (though generate usually doesn't have it)
            if (k === 'CHECKSUMHASH') continue;
            if (value === 'null' || value === undefined) continue; // Match checkString_e logic? PHP: if value=='null' value=''

            const v = (value === null || value === 'null') ? '' : String(value);

            if (flag) {
                paramStr += v;
                flag = false;
            } else {
                paramStr += "|" + v;
            }
        }

        const salt = this.generateSalt(4);

        // 4. Calculate Hash
        const hashString = this.calculateHash(paramStr, salt);

        // 5. Encrypt
        const checksum = this.encrypt(hashString, key);
        return checksum;
    }

    static verifySignature(params: Record<string, any>, key: string, checksum: string): boolean {
        // 1. Remove CHECKSUMHASH
        const paramsCopy = { ...params };
        delete paramsCopy['CHECKSUMHASH'];

        // 2. Sort keys
        const keys = Object.keys(paramsCopy).sort();

        // 3. Create param string
        let paramStr = "";
        let flag = true;

        for (const k of keys) {
            const value = paramsCopy[k];
            if (k === 'CHECKSUMHASH') continue; // double check

            const v = (value === null || value === 'null' || value === undefined) ? '' : String(value);

            if (flag) {
                paramStr += v;
                flag = false;
            } else {
                paramStr += "|" + v;
            }
        }

        // 4. Decrypt checksum to get hash + salt
        try {
            const paytm_hash = this.decrypt(checksum, key);
            const salt = paytm_hash.substr(paytm_hash.length - 4);

            // 5. Calculate new hash
            const calculatedHash = this.calculateHash(paramStr, salt);

            // 6. Compare
            return calculatedHash === paytm_hash;
        } catch (e) {
            console.error("Paytm Checksum Decryption Failed:", e);
            return false;
        }
    }
}
