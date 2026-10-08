CREATE TABLE `organization_onboarding` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`profile_json` text NOT NULL,
	`phase` text DEFAULT 'offered' NOT NULL,
	`case_id` text,
	`tutorial_step` integer DEFAULT 0 NOT NULL,
	`tutorial_done` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
