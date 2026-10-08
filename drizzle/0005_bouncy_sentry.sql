CREATE TABLE `notification_preferences` (
	`user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`waiting_json` text DEFAULT '{}' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `organization_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
