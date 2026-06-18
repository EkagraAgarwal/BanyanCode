--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `agent_id` text;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `version` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `updated_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `namespace` text;
--> statement-breakpoint
UPDATE `memory_entries` SET `updated_at` = `created_at` WHERE `updated_at` = 0;