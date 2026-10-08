CREATE TABLE `data_work_requests` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`case_id` text NOT NULL,
	`file_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`, `request_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `stored_files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_data_work_file` ON `data_work_requests` (`organization_id`,`file_id`);