CREATE TABLE `annotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`event_id` integer,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_annotations_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_annotations_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`file_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`byte_offset` integer NOT NULL,
	`byte_length` integer NOT NULL,
	`uuid` text,
	`parent_uuid` text,
	`timestamp_ms` integer,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`is_sidechain` integer DEFAULT false NOT NULL,
	`is_dead_branch` integer DEFAULT false NOT NULL,
	`is_meta` integer DEFAULT false NOT NULL,
	`is_interrupt` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_events_file_id_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_events_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`project_id` integer NOT NULL,
	`session_id` text,
	`path` text NOT NULL,
	`mtime_ms` integer NOT NULL,
	`size` integer NOT NULL,
	`parsed_offset` integer DEFAULT 0 NOT NULL,
	`compression` text DEFAULT 'none' NOT NULL,
	`last_ingested_at` integer,
	CONSTRAINT `fk_files_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_files_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `model_pricing` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`model` text NOT NULL,
	`effective_from` integer NOT NULL,
	`input_usd_per_mtok` numeric NOT NULL,
	`output_usd_per_mtok` numeric NOT NULL,
	`cache_read_usd_per_mtok` numeric NOT NULL,
	`cache_write_usd_per_mtok` numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_stats` (
	`session_id` text PRIMARY KEY,
	`user_turns` integer DEFAULT 0 NOT NULL,
	`assistant_turns` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`tok_input` integer DEFAULT 0 NOT NULL,
	`tok_output` integer DEFAULT 0 NOT NULL,
	`tok_cache_read` integer DEFAULT 0 NOT NULL,
	`tok_cache_write` integer DEFAULT 0 NOT NULL,
	`tok_dead_branch` integer DEFAULT 0 NOT NULL,
	`cost_usd` numeric DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_session_stats_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`source_session_id` text NOT NULL,
	`project_id` integer NOT NULL,
	`parent_id` text,
	`fork_of` text,
	`agent_id` text,
	`cwd` text NOT NULL,
	`git_branch` text,
	`claude_version` text,
	`started_at` integer,
	`ended_at` integer,
	CONSTRAINT `fk_sessions_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `sessions_parent_id_sessions_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
	CONSTRAINT `sessions_fork_of_sessions_id_fk` FOREIGN KEY (`fork_of`) REFERENCES `sessions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`source_event_id` integer NOT NULL,
	`result_event_id` integer,
	`tool_use_id` text NOT NULL,
	`name` text NOT NULL,
	`input_summary` text,
	`target_path` text,
	`started_at` integer,
	`ended_at` integer,
	`duration_ms` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`is_error` integer DEFAULT false NOT NULL,
	CONSTRAINT `fk_tool_calls_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tool_calls_source_event_id_events_id_fk` FOREIGN KEY (`source_event_id`) REFERENCES `events`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tool_calls_result_event_id_events_id_fk` FOREIGN KEY (`result_event_id`) REFERENCES `events`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `annotations_session_id_idx` ON `annotations` (`session_id`);--> statement-breakpoint
CREATE INDEX `annotations_event_id_idx` ON `annotations` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_session_id_seq_unique` ON `events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_file_id_idx` ON `events` (`file_id`);--> statement-breakpoint
CREATE INDEX `events_session_id_timestamp_ms_idx` ON `events` (`session_id`,`timestamp_ms`);--> statement-breakpoint
CREATE INDEX `events_session_id_uuid_idx` ON `events` (`session_id`,`uuid`);--> statement-breakpoint
CREATE INDEX `events_session_id_parent_uuid_idx` ON `events` (`session_id`,`parent_uuid`);--> statement-breakpoint
CREATE UNIQUE INDEX `files_path_unique` ON `files` (`path`);--> statement-breakpoint
CREATE INDEX `files_project_id_idx` ON `files` (`project_id`);--> statement-breakpoint
CREATE INDEX `files_session_id_idx` ON `files` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `model_pricing_model_effective_from_unique` ON `model_pricing` (`model`,`effective_from`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE INDEX `sessions_project_id_idx` ON `sessions` (`project_id`);--> statement-breakpoint
CREATE INDEX `sessions_source_session_id_idx` ON `sessions` (`source_session_id`);--> statement-breakpoint
CREATE INDEX `sessions_parent_id_idx` ON `sessions` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tool_calls_session_id_tool_use_id_unique` ON `tool_calls` (`session_id`,`tool_use_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_source_event_id_idx` ON `tool_calls` (`source_event_id`);--> statement-breakpoint
CREATE INDEX `tool_calls_result_event_id_idx` ON `tool_calls` (`result_event_id`);