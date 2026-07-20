import * as fs from 'fs';
import * as path from 'path';

export interface StoredPushSubscription {
  id: string;
  userId: string;
  organizationId: string;
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expirationTime?: number | null;
  };
  createdAt: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE_PATH = path.join(DATA_DIR, 'push-subscriptions.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readAll(): StoredPushSubscription[] {
  ensureDir();
  if (!fs.existsSync(FILE_PATH)) return [];
  try {
    const raw = fs.readFileSync(FILE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.subscriptions) ? data.subscriptions : [];
  } catch {
    return [];
  }
}

function writeAll(subscriptions: StoredPushSubscription[]) {
  ensureDir();
  fs.writeFileSync(
    FILE_PATH,
    JSON.stringify({ subscriptions, updatedAt: new Date().toISOString() }, null, 2),
    'utf-8',
  );
}

export function addSubscription(
  userId: string,
  organizationId: string,
  subscription: StoredPushSubscription['subscription'],
): StoredPushSubscription {
  const all = readAll();
  const existing = all.find(
    (s) =>
      s.organizationId === organizationId &&
      s.subscription.endpoint === subscription.endpoint,
  );
  if (existing) {
    existing.subscription = subscription;
    existing.userId = userId;
    writeAll(all);
    return existing;
  }
  const id = `ps-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const record: StoredPushSubscription = {
    id,
    userId,
    organizationId,
    subscription,
    createdAt: new Date().toISOString(),
  };
  writeAll([...all, record]);
  return record;
}

export function getSubscriptionsByOrganization(organizationId: string): StoredPushSubscription[] {
  return readAll().filter((s) => s.organizationId === organizationId);
}

export function removeByEndpoint(endpoint: string): void {
  const all = readAll().filter((s) => s.subscription.endpoint !== endpoint);
  writeAll(all);
}
