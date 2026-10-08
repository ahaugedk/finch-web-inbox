CREATE TABLE `organization_invitation_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`decision` text,
	`decided_at` integer,
	`decision_id` text,
	FOREIGN KEY (`member_id`) REFERENCES `organization_members`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_invitation_token_member` ON `organization_invitation_tokens` (`member_id`);--> statement-breakpoint
CREATE INDEX `idx_invitation_token_expiry` ON `organization_invitation_tokens` (`expires_at`);