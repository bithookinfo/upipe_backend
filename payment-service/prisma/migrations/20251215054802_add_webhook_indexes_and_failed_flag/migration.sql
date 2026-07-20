-- AlterTable
ALTER TABLE `orders` ADD COLUMN `webhook_failed` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `webhook_failure_reason` TEXT NULL;

-- CreateIndex
CREATE INDEX `callback_logs_success_next_retry_at_retry_count_idx` ON `callback_logs`(`success`, `next_retry_at`, `retry_count`);

-- CreateIndex
CREATE INDEX `orders_status_webhook_sent_idx` ON `orders`(`status`, `webhook_sent`);
