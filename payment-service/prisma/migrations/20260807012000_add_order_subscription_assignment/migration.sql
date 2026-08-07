-- AlterTable
ALTER TABLE `orders` ADD COLUMN `org_subscription_id` VARCHAR(36) NULL;

-- CreateIndex
CREATE INDEX `orders_org_subscription_id_idx` ON `orders`(`org_subscription_id`);

-- CreateIndex
CREATE INDEX `orders_organization_id_org_subscription_id_created_at_idx` ON `orders`(`organization_id`, `org_subscription_id`, `created_at`);
