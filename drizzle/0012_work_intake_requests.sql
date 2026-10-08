CREATE TABLE `work_intake_requests` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`task_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_work_intake_request` ON `work_intake_requests` (`organization_id`,`user_id`,`request_id`);