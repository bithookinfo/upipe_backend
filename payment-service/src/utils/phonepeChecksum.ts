import * as crypto from 'crypto';

export function generateChecksum(payload: string, saltKey: string, saltIndex: string): string {
    const hash = crypto.createHash('sha256').update(payload + "/pg/v1/pay" + saltKey).digest('hex'); // Standard for pay
    return hash + "###" + saltIndex;
}

export function verifyPhonePeChecksum(
    payloadBase64: string,
    saltKey: string,
    saltIndex: string,
    signature: string
): boolean {
    try {
        const stringToHash = payloadBase64 + saltKey;
        const sha256 = crypto.createHash('sha256').update(stringToHash).digest('hex');
        const calculatedChecksum = sha256 + "###" + saltIndex;

        return calculatedChecksum === signature;
    } catch (error) {
        console.error("PhonePe Checksum Verify Error:", error);
        return false;
    }
}
