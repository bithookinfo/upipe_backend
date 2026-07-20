-- CMS Migration for Organization Service (upipe-backend)
-- Creates all CMS tables matching Prisma schema

CREATE TABLE IF NOT EXISTS `cms_pages` (
  `id` VARCHAR(36) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `url` VARCHAR(500),
  `content` LONGTEXT NOT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
  `locale` VARCHAR(10),
  `seo_title` VARCHAR(255),
  `seo_description` TEXT,
  `seo_keywords` TEXT,
  `og_title` VARCHAR(255),
  `og_description` TEXT,
  `og_image` VARCHAR(500),
  `canonical_url` VARCHAR(500),
  `head_html` LONGTEXT,
  `body_html` LONGTEXT,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `cms_pages_slug_key`(`slug`),
  INDEX `cms_pages_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_sections` (
  `id` VARCHAR(36) NOT NULL,
  `page_slug` VARCHAR(255),
  `page_id` VARCHAR(36),
  `section_type` VARCHAR(50) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `is_visible` BOOLEAN NOT NULL DEFAULT true,
  `order` INTEGER NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `cms_sections_page_id_idx`(`page_id`),
  INDEX `cms_sections_page_slug_idx`(`page_slug`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `cms_sections` ADD CONSTRAINT `cms_sections_page_id_fkey` FOREIGN KEY (`page_id`) REFERENCES `cms_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS `cms_global_seo` (
  `id` VARCHAR(36) NOT NULL DEFAULT 'global-seo',
  `site_name` VARCHAR(255),
  `site_description` TEXT,
  `default_title` VARCHAR(255),
  `default_description` TEXT,
  `default_keywords` TEXT,
  `og_title` VARCHAR(255),
  `og_description` TEXT,
  `og_image` VARCHAR(500),
  `twitter_handle` VARCHAR(100),
  `robots_txt` LONGTEXT,
  `google_analytics_id` VARCHAR(100),
  `google_tag_manager_id` VARCHAR(100),
  `google_verification` VARCHAR(255),
  `bing_verification` VARCHAR(255),
  `schema_markup` LONGTEXT,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_brand_assets` (
  `id` VARCHAR(36) NOT NULL DEFAULT 'brand-assets',
  `logo_url` VARCHAR(500),
  `favicon_url` VARCHAR(500),
  `primary_color` VARCHAR(20),
  `secondary_color` VARCHAR(20),
  `accent_color` VARCHAR(20),
  `font_family` VARCHAR(100),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_navigation` (
  `id` VARCHAR(36) NOT NULL,
  `label` VARCHAR(255) NOT NULL,
  `url` VARCHAR(500),
  `icon` VARCHAR(100),
  `page_id` VARCHAR(36),
  `parent_id` VARCHAR(36),
  `nav_type` VARCHAR(20),
  `order` INTEGER NOT NULL DEFAULT 0,
  `is_visible` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `cms_navigation_nav_type_idx`(`nav_type`),
  INDEX `cms_navigation_parent_id_idx`(`parent_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_root_files` (
  `id` VARCHAR(36) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `content` LONGTEXT,
  `mime_type` VARCHAR(100),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `cms_root_files_filename_key`(`filename`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_media` (
  `id` VARCHAR(36) NOT NULL,
  `filename` VARCHAR(255) NOT NULL,
  `url` VARCHAR(500) NOT NULL,
  `mime_type` VARCHAR(100),
  `size` INTEGER,
  `folder` VARCHAR(255),
  `alt_text` TEXT,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_forms` (
  `id` VARCHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT,
  `fields` LONGTEXT NOT NULL,
  `is_public` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_form_submissions` (
  `id` VARCHAR(36) NOT NULL,
  `form_id` VARCHAR(36) NOT NULL,
  `data` LONGTEXT NOT NULL,
  `ip_address` VARCHAR(45),
  `user_agent` TEXT,
  `is_read` BOOLEAN NOT NULL DEFAULT false,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `cms_form_submissions_form_id_idx`(`form_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `cms_form_submissions` ADD CONSTRAINT `cms_form_submissions_form_id_fkey` FOREIGN KEY (`form_id`) REFERENCES `cms_forms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS `cms_themes` (
  `id` VARCHAR(36) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `is_active` BOOLEAN NOT NULL DEFAULT false,
  `config` LONGTEXT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_redirects` (
  `id` VARCHAR(36) NOT NULL,
  `old_url` VARCHAR(500) NOT NULL,
  `new_url` VARCHAR(500) NOT NULL,
  `status_code` INTEGER NOT NULL DEFAULT 301,
  `is_active` BOOLEAN NOT NULL DEFAULT true,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cms_blogs` (
  `id` VARCHAR(36) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `content` LONGTEXT NOT NULL,
  `excerpt` TEXT,
  `featured_image` VARCHAR(500),
  `status` VARCHAR(20) NOT NULL DEFAULT 'draft',
  `published_at` DATETIME(3),
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `cms_blogs_slug_key`(`slug`),
  INDEX `cms_blogs_slug_idx`(`slug`),
  INDEX `cms_blogs_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Insert default singleton records
INSERT IGNORE INTO `cms_global_seo` (`id`, `updated_at`) VALUES ('global-seo', NOW());
INSERT IGNORE INTO `cms_brand_assets` (`id`, `updated_at`) VALUES ('brand-assets', NOW());
