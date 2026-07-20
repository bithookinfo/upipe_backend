-- Webhook deliveries dashboard: narrow composite indexes for org + completed + callback filter,
-- summary groupBy, and list ordered by updatedAt.

-- CreateIndex
CREATE INDEX `orders_organization_id_status_callback_url_idx` ON `orders`(`organization_id`, `status`, `callback_url`);

-- CreateIndex
CREATE INDEX `orders_organization_id_status_webhook_sent_webhook_failed_idx` ON `orders`(`organization_id`, `status`, `webhook_sent`, `webhook_failed`);

-- CreateIndex
CREATE INDEX `orders_organization_id_status_updated_at_idx` ON `orders`(`organization_id`, `status`, `updated_at`);
