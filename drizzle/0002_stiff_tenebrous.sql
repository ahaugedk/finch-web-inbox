CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`display_name` text DEFAULT '' NOT NULL,
	`role_id` text,
	`include_in_graph` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer,
	`invited_by` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`role_id`) REFERENCES `organization_roles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_org_members_email` ON `organization_members` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `idx_org_members_user_status` ON `organization_members` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_org_members_invites` ON `organization_members` (`email`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `organization_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_org_roles_live` ON `organization_roles` (`organization_id`,`deleted_at`);