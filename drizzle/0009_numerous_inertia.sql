CREATE TABLE `agent_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text,
	`connected_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_connections_expiry` ON `agent_connections` (`expires_at`);