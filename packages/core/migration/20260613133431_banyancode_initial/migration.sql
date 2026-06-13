CREATE TABLE `codegraph_edges` (
	`id` text PRIMARY KEY,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`kind` text NOT NULL,
	CONSTRAINT `fk_codegraph_edges_from_node_id_codegraph_nodes_id_fk` FOREIGN KEY (`from_node_id`) REFERENCES `codegraph_nodes`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_codegraph_edges_to_node_id_codegraph_nodes_id_fk` FOREIGN KEY (`to_node_id`) REFERENCES `codegraph_nodes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `codegraph_embeddings` (
	`node_id` text PRIMARY KEY,
	`embedding` blob NOT NULL,
	`model` text NOT NULL,
	`dim` integer NOT NULL,
	CONSTRAINT `fk_codegraph_embeddings_node_id_codegraph_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `codegraph_nodes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `codegraph_files` (
	`id` text PRIMARY KEY,
	`path` text NOT NULL UNIQUE,
	`content_hash` text NOT NULL,
	`language` text NOT NULL,
	`indexed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `codegraph_nodes` (
	`id` text PRIMARY KEY,
	`file_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`signature` text,
	`start_line` integer NOT NULL,
	`end_line` integer NOT NULL,
	`code` text,
	CONSTRAINT `fk_codegraph_nodes_file_id_codegraph_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `codegraph_files`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`context` text,
	`tags` text NOT NULL,
	`scope` text NOT NULL,
	`session_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `subagent_messages` (
	`id` text PRIMARY KEY,
	`parent_session_id` text NOT NULL,
	`from_session` text NOT NULL,
	`from_agent` text NOT NULL,
	`to_session` text,
	`to_agent` text,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `codegraph_edge_from_idx` ON `codegraph_edges` (`from_node_id`);--> statement-breakpoint
CREATE INDEX `codegraph_edge_to_idx` ON `codegraph_edges` (`to_node_id`);--> statement-breakpoint
CREATE INDEX `codegraph_embedding_model_idx` ON `codegraph_embeddings` (`model`);--> statement-breakpoint
CREATE INDEX `codegraph_node_file_name_idx` ON `codegraph_nodes` (`file_id`,`name`);--> statement-breakpoint
CREATE INDEX `codegraph_node_kind_name_idx` ON `codegraph_nodes` (`kind`,`name`);--> statement-breakpoint
CREATE INDEX `memory_scope_key_idx` ON `memory_entries` (`scope`,`key`);--> statement-breakpoint
CREATE INDEX `memory_scope_session_idx` ON `memory_entries` (`scope`,`session_id`);--> statement-breakpoint
CREATE INDEX `subagent_msg_parent_delivered_idx` ON `subagent_messages` (`parent_session_id`,`delivered_at`);