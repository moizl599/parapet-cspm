ALTER TABLE `analyses` ADD `partial` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `analyses` ADD `analyzed_groups` integer;--> statement-breakpoint
ALTER TABLE `analyses` ADD `total_groups` integer;