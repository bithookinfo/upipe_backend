/**
 * Grants an identity permission (by code) to every org role the user is assigned to.
 *
 * Requires two DB URLs (identity and organization schemas are usually different databases):
 *   IDENTITY_DATABASE_URL     — identity-service DB (tables: users, permissions)
 *   ORGANIZATION_DATABASE_URL — organization-service DB (tables: org_users, role_permissions)
 *
 * Usage:
 *   cd services/organization-service
 *   IDENTITY_DATABASE_URL="mysql://..." ORGANIZATION_DATABASE_URL="mysql://..." \
 *     node scripts/grant-role-permission-by-email.mjs user@example.com payment:view
 *
 * After running: ask the user to log out and back in (or hard refresh) so the app reloads role permissions.
 */

import mysql from "mysql2/promise";
import { randomUUID } from "crypto";

const email = process.argv[2];
const permCode = process.argv[3] || "payment:view";
const identityUrl =
  process.env.IDENTITY_DATABASE_URL || process.env.IDENTITY_DB_URL;
const orgUrl =
  process.env.ORGANIZATION_DATABASE_URL ||
  process.env.ORG_DB_URL ||
  process.env.DATABASE_URL;

async function main() {
  if (!email || !identityUrl || !orgUrl) {
    console.error(`
Missing arguments or env.

  IDENTITY_DATABASE_URL=mysql://user:pass@host:3306/identity_db
  ORGANIZATION_DATABASE_URL=mysql://user:pass@host:3306/organization_db
  node scripts/grant-role-permission-by-email.mjs <email> [permission_code]

Example:
  node scripts/grant-role-permission-by-email.mjs someone@example.com payment:view
`);
    process.exit(1);
  }

  const idConn = await mysql.createConnection(identityUrl);
  const orgConn = await mysql.createConnection(orgUrl);

  try {
    const [[perm]] = await idConn.execute(
      "SELECT id, code FROM permissions WHERE code = ? AND is_active = 1 LIMIT 1",
      [permCode],
    );
    if (!perm) {
      console.error(`Permission not found or inactive in identity DB: ${permCode}`);
      process.exit(1);
    }

    const [[user]] = await idConn.execute(
      "SELECT id, email FROM users WHERE email = ? LIMIT 1",
      [email],
    );
    if (!user) {
      console.error(`No user with email: ${email}`);
      process.exit(1);
    }

    const [memberships] = await orgConn.execute(
      "SELECT organization_id, role_id FROM org_users WHERE user_id = ? AND is_active = 1",
      [user.id],
    );

    if (!memberships.length) {
      console.error(
        `User ${email} has no active org_users rows (check organization DB).`,
      );
      process.exit(1);
    }

    let added = 0;
    for (const m of memberships) {
      if (!m.role_id) {
        console.warn(
          `Skip org ${m.organization_id}: no role_id on org_users row.`,
        );
        continue;
      }
      const [[existing]] = await orgConn.execute(
        "SELECT id FROM role_permissions WHERE role_id = ? AND permission_id = ? LIMIT 1",
        [m.role_id, perm.id],
      );
      if (existing) {
        console.log(
          `Already granted ${permCode} on role ${m.role_id} (org ${m.organization_id})`,
        );
        continue;
      }
      await orgConn.execute(
        "INSERT INTO role_permissions (id, role_id, permission_id, created_at) VALUES (?, ?, ?, NOW())",
        [randomUUID(), m.role_id, perm.id],
      );
      console.log(
        `Granted ${permCode} → role ${m.role_id} (org ${m.organization_id})`,
      );
      added += 1;
    }

    console.log(
      added
        ? `\nDone. Added ${added} role_permission row(s). User should re-login or refresh the app.`
        : `\nNo new rows (already had access or missing roles).`,
    );
  } finally {
    await idConn.end();
    await orgConn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
