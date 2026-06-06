CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` text NOT NULL,
	`posture_score` integer,
	`executive_summary` text,
	`items` text,
	`quick_wins` text,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `environments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`target_account_id` text,
	`auth_mode` text DEFAULT 'base' NOT NULL,
	`role_arn` text,
	`external_id` text,
	`regions` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_scan_id` text,
	`last_scan_at` integer,
	`last_posture_score` integer
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` text NOT NULL,
	`check_id` text,
	`title` text,
	`service` text,
	`severity` text,
	`status` text,
	`region` text,
	`resource_id` text,
	`resource_type` text,
	`description` text,
	`remediation_text` text,
	`remediation_url` text,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `findings_scan_idx` ON `findings` (`scan_id`);--> statement-breakpoint
CREATE INDEX `findings_lookup_idx` ON `findings` (`check_id`,`resource_id`,`region`);--> statement-breakpoint
CREATE TABLE `scans` (
	`id` text PRIMARY KEY NOT NULL,
	`environment_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`summary` text,
	`ocsf_path` text,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
