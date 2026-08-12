CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`answer_given` text,
	`correct` integer,
	`confidence_rating` integer,
	`seconds_taken` real,
	`attempted_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attempts_question_idx` ON `attempts` (`question_id`);--> statement-breakpoint
CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`text` text NOT NULL,
	`embedding` blob,
	`page_no` integer,
	`slide_no` integer,
	`timestamp` real,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chunks_source_idx` ON `chunks` (`source_id`,`position`);--> statement-breakpoint
CREATE TABLE `concept_links` (
	`from_concept_id` text NOT NULL,
	`to_concept_id` text NOT NULL,
	`type` text NOT NULL,
	`note` text,
	PRIMARY KEY(`from_concept_id`, `to_concept_id`, `type`),
	FOREIGN KEY (`from_concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `concept_links_to_idx` ON `concept_links` (`to_concept_id`);--> statement-breakpoint
CREATE TABLE `concept_schedule` (
	`concept_id` text PRIMARY KEY NOT NULL,
	`stability` real,
	`difficulty` real,
	`due_date` integer,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`last_review` integer,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`section_id` text NOT NULL,
	`statement` text NOT NULL,
	`type` text NOT NULL,
	`bloom_ceiling` text,
	`difficulty` integer,
	`examinable_flag` integer DEFAULT false NOT NULL,
	`emphasis_score` real,
	`source_chunk_ids` text,
	`prerequisite_ids` text,
	`embedding` blob,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `concepts_section_idx` ON `concepts` (`section_id`);--> statement-breakpoint
CREATE TABLE `exams` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`title` text NOT NULL,
	`blueprint_json` text,
	`question_ids` text,
	`started_at` integer,
	`submitted_at` integer,
	`score` real,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `figures` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`path` text NOT NULL,
	`page_no` integer,
	`width` integer,
	`height` integer,
	`caption_extracted` text,
	`caption_ai` text,
	`alt_text` text,
	`embedding` blob,
	`type` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `figures_source_idx` ON `figures` (`source_id`,`page_no`);--> statement-breakpoint
CREATE TABLE `modules` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text,
	`title` text NOT NULL,
	`year` integer,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `note_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`section_id` text NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`figure_id` text,
	`target_section_id` text,
	`concept_ids` text,
	`source_refs` text,
	`origin` text DEFAULT 'user_written' NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`embedding` blob,
	`generated_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `note_blocks_section_idx` ON `note_blocks` (`section_id`,`position`);--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`blueprint_json` text,
	`concept_ids` text,
	`section_ids` text,
	`format` text NOT NULL,
	`stem` text NOT NULL,
	`options_json` text,
	`correct_answer` text,
	`worked_answer` text,
	`mark_scheme` text,
	`figure_id` text,
	`bloom_level` text,
	`difficulty_est` real,
	`embedding` blob,
	`source` text DEFAULT 'generated' NOT NULL,
	`times_served` integer DEFAULT 0 NOT NULL,
	`times_correct` integer DEFAULT 0 NOT NULL,
	`critic_score` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `questions_module_idx` ON `questions` (`module_id`);--> statement-breakpoint
CREATE TABLE `scenario_seeds` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`value` text NOT NULL,
	`compatible_with` text
);
--> statement-breakpoint
CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`learning_outcomes` text,
	`status` text DEFAULT 'empty' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sections_module_idx` ON `sections` (`module_id`);--> statement-breakpoint
CREATE INDEX `sections_parent_idx` ON `sections` (`parent_id`,`position`);--> statement-breakpoint
CREATE TABLE `source_sections` (
	`source_id` text NOT NULL,
	`section_id` text NOT NULL,
	`chunk_range` text,
	`score` real,
	`confirmed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`source_id`, `section_id`),
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_sections_section_idx` ON `source_sections` (`section_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`filename` text NOT NULL,
	`path` text NOT NULL,
	`lecture_date` text,
	`ingested_at` integer,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`error` text,
	`page_count` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sources_module_idx` ON `sources` (`module_id`);--> statement-breakpoint
CREATE TABLE `vec_map` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vec_map_entity_idx` ON `vec_map` (`kind`,`entity_id`);