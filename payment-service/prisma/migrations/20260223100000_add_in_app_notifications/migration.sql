-- CreateTable
CREATE TABLE `in_app_notifications` (
    `id` VARCHAR(36) NOT NULL,
    `organization_id` VARCHAR(36) NOT NULL,
    `order_id` VARCHAR(36) NULL,
    `external_order_id` VARCHAR(100) NULL,
    `type` VARCHAR(50) NOT NULL DEFAULT 'order_completed',
    `title` VARCHAR(255) NOT NULL,
    `message` VARCHAR(500) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `in_app_notifications_organization_id_idx`(`organization_id`),
    INDEX `in_app_notifications_created_at_idx`(`created_at`),
    INDEX `in_app_notifications_organization_id_created_at_idx`(`organization_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_reads` (
    `id` VARCHAR(36) NOT NULL,
    `notification_id` VARCHAR(36) NOT NULL,
    `user_id` VARCHAR(36) NOT NULL,
    `read_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notification_reads_notification_id_user_id_key`(`notification_id`, `user_id`),
    INDEX `notification_reads_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `notification_reads` ADD CONSTRAINT `notification_reads_notification_id_fkey` FOREIGN KEY (`notification_id`) REFERENCES `in_app_notifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
