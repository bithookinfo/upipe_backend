-- AlterTable
ALTER TABLE `merchants` ADD COLUMN `org_subscription_id` VARCHAR(36) NULL;

-- CreateIndex
CREATE INDEX `merchants_org_subscription_id_idx` ON `merchants`(`org_subscription_id`);

-- CreateIndex
CREATE INDEX `merchants_organization_id_org_subscription_id_idx` ON `merchants`(`organization_id`, `org_subscription_id`);
