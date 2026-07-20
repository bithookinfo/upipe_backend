declare module 'web-push' {
  export function setVapidDetails(
    subject: string,
    publicKey: string,
    privateKey: string
  ): void;

  export function sendNotification(
    subscription: PushSubscription | object,
    payload?: string | Buffer | null,
    options?: { vapidDetails?: object; TTL?: number; [key: string]: unknown }
  ): Promise<{ statusCode: number; [key: string]: unknown }>;

  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expirationTime?: number | null;
  }
}
