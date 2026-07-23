CREATE TABLE `session_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`source_session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`source_event_id` integer,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_session_links_source_session_id_sessions_id_fk` FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_links_target_session_id_sessions_id_fk` FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_session_links_source_event_id_events_id_fk` FOREIGN KEY (`source_event_id`) REFERENCES `events`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_links_source_target_kind_unique` ON `session_links` (`source_session_id`,`target_session_id`,`kind`);--> statement-breakpoint
CREATE INDEX `session_links_source_session_id_idx` ON `session_links` (`source_session_id`);--> statement-breakpoint
CREATE INDEX `session_links_target_session_id_idx` ON `session_links` (`target_session_id`);--> statement-breakpoint
CREATE INDEX `session_links_source_event_id_idx` ON `session_links` (`source_event_id`);