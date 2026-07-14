ALTER TABLE `events` ADD `message_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `has_usage` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `is_usage_duplicate` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `events_message_id_request_id_idx` ON `events` (`message_id`,`request_id`);