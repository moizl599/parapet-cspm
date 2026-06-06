CREATE TABLE `attack_paths` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`title` text,
	`severity` text NOT NULL,
	`entry_key` text,
	`target_key` text,
	`hops` text,
	`capabilities` text,
	`narrative` text,
	`confidence` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attack_paths_scan_idx` ON `attack_paths` (`scan_id`);--> statement-breakpoint
CREATE TABLE `graph_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` text NOT NULL,
	`src_key` text NOT NULL,
	`dst_key` text NOT NULL,
	`relation` text NOT NULL,
	`evidence` text,
	`source` text DEFAULT 'prowler' NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_edges_scan_idx` ON `graph_edges` (`scan_id`);--> statement-breakpoint
CREATE TABLE `graph_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scan_id` text NOT NULL,
	`node_key` text NOT NULL,
	`type` text NOT NULL,
	`name` text,
	`region` text,
	`account_id` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'prowler' NOT NULL,
	FOREIGN KEY (`scan_id`) REFERENCES `scans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_nodes_scan_idx` ON `graph_nodes` (`scan_id`);