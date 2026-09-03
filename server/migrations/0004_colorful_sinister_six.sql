ALTER TABLE `concept_schedule` ADD `state` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `concept_schedule` ADD `scheduled_days` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `concept_schedule` ADD `elapsed_days` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `concept_schedule` ADD `learning_steps` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `concept_schedule` ADD `confidently_wrong` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `concept_schedule` ADD `last_grade` integer;