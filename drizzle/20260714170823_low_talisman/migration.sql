ALTER TABLE `projects` ADD `source_path` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_source_path_unique` ON `projects` (`source_path`);