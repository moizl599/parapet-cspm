ALTER TABLE `scans` ADD `analysis_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `scans` ADD `analysis_progress` text;--> statement-breakpoint
ALTER TABLE `scans` ADD `analysis_started_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `analysis_finished_at` integer;--> statement-breakpoint
ALTER TABLE `scans` ADD `analysis_error` text;