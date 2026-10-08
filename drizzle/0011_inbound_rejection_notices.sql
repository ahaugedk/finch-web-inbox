CREATE TABLE `inbound_rejection_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`inbound_message_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`payload_json` text,
	`first_attempt_at` integer,
	`provider_message_id` text,
	`sent_at` integer,
	`lease_id` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`inbound_message_id`) REFERENCES `inbound_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbound_notice_message` ON `inbound_rejection_notices` (`inbound_message_id`);