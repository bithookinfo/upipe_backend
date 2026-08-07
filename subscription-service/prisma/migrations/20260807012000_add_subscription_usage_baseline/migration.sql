CREATE TABLE `subscription_usage_baselines` (
    `id` VARCHAR(36) NOT NULL,
    `org_subscription_id` VARCHAR(36) NOT NULL,
    `cycle_start` DATETIME(3) NOT NULL,
    `cycle_end` DATETIME(3) NOT NULL,
    `cutover_at` DATETIME(3) NOT NULL,
    `orders_used` INTEGER NOT NULL DEFAULT 0,
    `algorithm_version` VARCHAR(50) NOT NULL DEFAULT 'LEGACY_CHRONOLOGICAL_V1',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `subscription_usage_baselines_org_subscription_id_idx`(`org_subscription_id`),
    INDEX `subscription_usage_baselines_cutover_at_idx`(`cutover_at`),
    UNIQUE INDEX `subscription_usage_baselines_org_subscription_id_cycle_start_key`(`org_subscription_id`, `cycle_start`, `cycle_end`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `subscription_usage_baselines` ADD CONSTRAINT `subscription_usage_baselines_org_subscription_id_fkey` FOREIGN KEY (`org_subscription_id`) REFERENCES `org_subscriptions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

