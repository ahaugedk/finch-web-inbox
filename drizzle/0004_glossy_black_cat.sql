CREATE TABLE `inbound_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider_email_id` text NOT NULL,
	`webhook_id` text NOT NULL,
	`sender` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`task_id` text,
	`content_json` text,
	`lease_id` text NOT NULL,
	`lease_until` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbound_org_email` ON `inbound_messages` (`organization_id`,`provider_email_id`);--> statement-breakpoint
CREATE INDEX `idx_inbound_org_recent` ON `inbound_messages` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `organization_inbound_settings` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`alias` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`allowed_senders_json` text DEFAULT '[]' NOT NULL,
	`blocked_members_json` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`write_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_inbound_settings_alias_unique` ON `organization_inbound_settings` (`alias`);