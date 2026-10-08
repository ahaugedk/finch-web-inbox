CREATE TABLE `data_tables` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`physical_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`columns_json` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_tables_physical_name_unique` ON `data_tables` (`physical_name`);--> statement-breakpoint
CREATE INDEX `idx_data_tables_organization` ON `data_tables` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_data_tables_org_name_live` ON `data_tables` (`organization_id`,`name`) WHERE "data_tables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `stored_files` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_stored_files_organization_live` ON `stored_files` (`organization_id`,`deleted_at`);