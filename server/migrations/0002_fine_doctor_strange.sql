CREATE TABLE `note_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`section_id` text,
	`label` text NOT NULL,
	`reason` text NOT NULL,
	`block_count` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`seq` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_snapshots_module_idx` ON `note_snapshots` (`module_id`,`seq`);