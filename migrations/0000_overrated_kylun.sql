CREATE TABLE `access_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `access_keys_token_hash_unique` ON `access_keys` (`token_hash`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `masters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`object_key` text NOT NULL,
	`row_count` integer NOT NULL,
	`cpi_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`source_hash` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shortlists` (
	`id` text PRIMARY KEY NOT NULL,
	`company` text NOT NULL,
	`role` text NOT NULL,
	`round` text NOT NULL,
	`season` text NOT NULL,
	`notes` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_version_id` text
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`filename` text NOT NULL,
	`object_key` text NOT NULL,
	`size` integer NOT NULL,
	`content_type` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`shortlist_id` text NOT NULL,
	`number` integer NOT NULL,
	`object_key` text NOT NULL,
	`row_count` integer NOT NULL,
	`master_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`processing_notes` text NOT NULL,
	`warnings` text NOT NULL,
	`source_upload_ids` text NOT NULL,
	`published_at` text,
	FOREIGN KEY (`shortlist_id`) REFERENCES `shortlists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`master_id`) REFERENCES `masters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shortlist_version_number` ON `versions` (`shortlist_id`,`number`);