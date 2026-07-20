-- CreateTable
CREATE TABLE `orders` (
    `id` VARCHAR(36) NOT NULL,
    `external_order_id` VARCHAR(100) NOT NULL,
    `organization_id` VARCHAR(36) NOT NULL,
    `merchant_id` VARCHAR(36) NOT NULL,
    `provider_id` VARCHAR(36) NULL,
    `created_by_id` VARCHAR(36) NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'INR',
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `payment_method` ENUM('UPI', 'WALLET', 'BANK', 'CARD') NOT NULL DEFAULT 'UPI',
    `customer_name` VARCHAR(255) NULL,
    `customer_mobile` VARCHAR(15) NULL,
    `customer_email` VARCHAR(255) NULL,
    `description` TEXT NULL,
    `callback_url` VARCHAR(500) NULL,
    `redirect_url` VARCHAR(500) NULL,
    `webhook_sent` BOOLEAN NOT NULL DEFAULT false,
    `metadata` JSON NULL,
    `expires_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `orders_external_order_id_key`(`external_order_id`),
    INDEX `orders_external_order_id_idx`(`external_order_id`),
    INDEX `orders_organization_id_idx`(`organization_id`),
    INDEX `orders_merchant_id_idx`(`merchant_id`),
    INDEX `orders_status_idx`(`status`),
    INDEX `orders_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transactions` (
    `id` VARCHAR(36) NOT NULL,
    `order_id` VARCHAR(36) NULL,
    `merchant_id` VARCHAR(36) NOT NULL,
    `provider_id` VARCHAR(36) NOT NULL,
    `external_transaction_id` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `fee` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `tax` DECIMAL(15, 2) NOT NULL DEFAULT 0.00,
    `net_amount` DECIMAL(15, 2) NOT NULL,
    `currency` VARCHAR(3) NOT NULL DEFAULT 'INR',
    `status` ENUM('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `payment_method` ENUM('UPI', 'WALLET', 'BANK', 'CARD') NOT NULL,
    `provider_code` VARCHAR(50) NULL,
    `provider_response` JSON NULL,
    `failure_reason` TEXT NULL,
    `utr` VARCHAR(50) NULL,
    `bank_ref_number` VARCHAR(50) NULL,
    `initiated_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `failed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `customer_contact` VARCHAR(255) NULL,
    `customer_name` VARCHAR(255) NULL,
    `payment_app` VARCHAR(50) NULL,

    UNIQUE INDEX `transactions_external_transaction_id_key`(`external_transaction_id`),
    INDEX `transactions_order_id_idx`(`order_id`),
    INDEX `transactions_merchant_id_idx`(`merchant_id`),
    INDEX `transactions_external_transaction_id_idx`(`external_transaction_id`),
    INDEX `transactions_status_idx`(`status`),
    INDEX `transactions_utr_idx`(`utr`),
    INDEX `transactions_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_links` (
    `id` VARCHAR(36) NOT NULL,
    `order_id` VARCHAR(36) NOT NULL,
    `link_token` VARCHAR(100) NOT NULL,
    `short_url` VARCHAR(255) NULL,
    `long_url` VARCHAR(500) NULL,
    `qr_data` TEXT NULL,
    `state` ENUM('GENERATED', 'SCANNED', 'PAYMENT_INITIATED', 'COMPLETED', 'EXPIRED') NOT NULL DEFAULT 'GENERATED',
    `expires_at` DATETIME(3) NULL,
    `is_single_use` BOOLEAN NOT NULL DEFAULT true,
    `scanned_count` INTEGER NOT NULL DEFAULT 0,
    `first_scanned_at` DATETIME(3) NULL,
    `last_scanned_at` DATETIME(3) NULL,
    `payment_initiated_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `expired_at` DATETIME(3) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payment_links_order_id_key`(`order_id`),
    UNIQUE INDEX `payment_links_link_token_key`(`link_token`),
    UNIQUE INDEX `payment_links_short_url_key`(`short_url`),
    INDEX `payment_links_link_token_idx`(`link_token`),
    INDEX `payment_links_state_idx`(`state`),
    INDEX `payment_links_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `callback_logs` (
    `id` VARCHAR(36) NOT NULL,
    `order_id` VARCHAR(36) NOT NULL,
    `callback_url` VARCHAR(500) NOT NULL,
    `payload` JSON NOT NULL,
    `response` JSON NULL,
    `status_code` INTEGER NULL,
    `success` BOOLEAN NOT NULL DEFAULT false,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `next_retry_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `callback_logs_order_id_idx`(`order_id`),
    INDEX `callback_logs_success_idx`(`success`),
    INDEX `callback_logs_next_retry_at_idx`(`next_retry_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `transactions` ADD CONSTRAINT `transactions_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_links` ADD CONSTRAINT `payment_links_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `callback_logs` ADD CONSTRAINT `callback_logs_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
