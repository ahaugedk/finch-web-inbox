CREATE TABLE `task_assignments` (
	`organization_id` text NOT NULL,
	`task_id` text NOT NULL,
	`assignee_id` text NOT NULL,
	`reason` text NOT NULL,
	`basis_json` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`organization_id`, `task_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_assignments_member` ON `task_assignments` (`organization_id`,`assignee_id`);