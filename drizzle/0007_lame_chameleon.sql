CREATE TABLE `page_agent_requests` (
	`organization_id` text NOT NULL,
	`page_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`case_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `page_id`, `user_id`, `request_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `page_user_states` (
	`organization_id` text NOT NULL,
	`page_id` text NOT NULL,
	`user_id` text NOT NULL,
	`values_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `page_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
