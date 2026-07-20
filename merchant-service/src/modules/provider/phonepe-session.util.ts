import { createHash } from "crypto";

export type PhonePeSessionSignals = {
  hasAuthToken: boolean;
  hasRefreshToken: boolean;
  hasCsrfSignal: boolean;
  hasTrustCid: boolean;
  hasTrustSid: boolean;
};

export function getPhonePeSessionSignals(
  cookiesString?: string | null,
  csrfToken?: string | null,
): PhonePeSessionSignals {
  const cookies = String(cookiesString || "");
  const csrf = String(csrfToken || "");
  return {
    hasAuthToken: cookies.includes("MERCHANT_USER_A_TOKEN="),
    hasRefreshToken: cookies.includes("MERCHANT_USER_R_TOKEN="),
    hasCsrfSignal:
      !!csrf ||
      cookies.includes("_X52F70K3N=") ||
      cookies.includes("_CKB2N1BHVZ="),
    hasTrustCid: cookies.includes("_ppabwdcid="),
    hasTrustSid: cookies.includes("_ppabwdsid="),
  };
}

export function formatPhonePeSessionSignals(
  signals: PhonePeSessionSignals,
): string {
  return `auth=${signals.hasAuthToken} refresh=${signals.hasRefreshToken} csrf=${signals.hasCsrfSignal} trustCid=${signals.hasTrustCid} trustSid=${signals.hasTrustSid}`;
}

export function shouldTreatAsTransientPhonePeSessionDrift(
  signals: PhonePeSessionSignals,
): boolean {
  return (
    signals.hasAuthToken && signals.hasRefreshToken && signals.hasCsrfSignal
  );
}

export function generateDeterministicPhonePeFingerprint(seed: string): string {
  const base = seed || "phonepe-default";
  const hash = createHash("sha256").update(base).digest("hex").slice(0, 32);
  const suffix = hash.slice(0, 5);
  const segment = `pbweb_${hash}_${suffix}`;
  return `${segment}.${segment}.${segment}.${segment}`;
}
