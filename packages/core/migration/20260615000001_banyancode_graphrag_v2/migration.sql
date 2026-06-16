DROP TABLE IF EXISTS `codegraph_edges`;
--> statement-breakpoint
DROP TABLE IF EXISTS `codegraph_embeddings`;
--> statement-breakpoint
DROP TABLE IF EXISTS `codegraph_nodes`;
--> statement-breakpoint
DROP TABLE IF EXISTS `codegraph_files`;
--> statement-breakpoint
DROP TABLE IF EXISTS `codegraph_roots`;
--> statement-breakpoint
CREATE TABLE `codegraph_roots` (
  `id` text PRIMARY KEY,
  `root_path` text NOT NULL UNIQUE,
  `last_build_at` integer,
  `indexed_file_count` integer NOT NULL DEFAULT 0,
  `node_count` integer NOT NULL DEFAULT 0,
  `edge_count` integer NOT NULL DEFAULT 0,
  `embedding_model` text,
  `parser_version` text NOT NULL DEFAULT 'v1',
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `codegraph_files` (
  `id` text PRIMARY KEY,
  `root_id` text NOT NULL,
  `path` text NOT NULL,
  `content_hash` text NOT NULL,
  `byte_size` integer NOT NULL,
  `language` text NOT NULL,
  `parser_version` text NOT NULL DEFAULT 'v1',
  `indexed_at` integer NOT NULL,
  CONSTRAINT `fk_codegraph_files_root_id_codegraph_roots_id_fk` FOREIGN KEY (`root_id`) REFERENCES `codegraph_roots`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codegraph_files_root_path_idx` ON `codegraph_files` (`root_id`,`path`);
--> statement-breakpoint
CREATE INDEX `codegraph_files_language_idx` ON `codegraph_files` (`language`);
--> statement-breakpoint
CREATE TABLE `codegraph_nodes` (
  `id` text PRIMARY KEY,
  `file_id` text NOT NULL,
  `kind` text NOT NULL,
  `name` text NOT NULL,
  `qualified_name` text NOT NULL,
  `start_line` integer NOT NULL,
  `start_byte` integer NOT NULL,
  `end_line` integer NOT NULL,
  `end_byte` integer NOT NULL,
  `language` text NOT NULL,
  `signature` text,
  `doc` text,
  `text_excerpt` text NOT NULL,
  `node_code_hash` text NOT NULL,
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_codegraph_nodes_file_id_codegraph_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `codegraph_files`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `codegraph_nodes_file_idx` ON `codegraph_nodes` (`file_id`);
--> statement-breakpoint
CREATE INDEX `codegraph_nodes_qualified_idx` ON `codegraph_nodes` (`qualified_name`);
--> statement-breakpoint
CREATE INDEX `codegraph_nodes_kind_idx` ON `codegraph_nodes` (`kind`);
--> statement-breakpoint
CREATE UNIQUE INDEX `codegraph_nodes_file_qname_idx` ON `codegraph_nodes` (`file_id`,`qualified_name`);
--> statement-breakpoint
CREATE TABLE `codegraph_edges` (
  `id` text PRIMARY KEY,
  `from_node_id` text NOT NULL,
  `to_node_id` text,
  `to_target_key` text,
  `file_id` text NOT NULL,
  `line` integer NOT NULL,
  `kind` text NOT NULL,
  `weight` integer NOT NULL DEFAULT 1,
  CONSTRAINT `fk_codegraph_edges_from_node_id_codegraph_nodes_id_fk` FOREIGN KEY (`from_node_id`) REFERENCES `codegraph_nodes`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_codegraph_edges_file_id_codegraph_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `codegraph_files`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `codegraph_edges_from_idx` ON `codegraph_edges` (`from_node_id`);
--> statement-breakpoint
CREATE INDEX `codegraph_edges_to_idx` ON `codegraph_edges` (`to_node_id`);
--> statement-breakpoint
CREATE INDEX `codegraph_edges_kind_idx` ON `codegraph_edges` (`kind`);
--> statement-breakpoint
CREATE INDEX `codegraph_edges_target_key_idx` ON `codegraph_edges` (`to_target_key`);
--> statement-breakpoint
CREATE INDEX `codegraph_edges_file_idx` ON `codegraph_edges` (`file_id`);
--> statement-breakpoint
CREATE TABLE `codegraph_embeddings` (
  `id` text PRIMARY KEY,
  `node_id` text NOT NULL,
  `embedding` blob NOT NULL,
  `model` text NOT NULL,
  `base_url_hash` text NOT NULL,
  `input_hash` text NOT NULL,
  `dim` integer NOT NULL,
  `encoding_format` text NOT NULL DEFAULT 'float',
  `created_at` integer NOT NULL,
  CONSTRAINT `fk_codegraph_embeddings_node_id_codegraph_nodes_id_fk` FOREIGN KEY (`node_id`) REFERENCES `codegraph_nodes`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codegraph_embeddings_node_model_base_idx` ON `codegraph_embeddings` (`node_id`,`model`,`base_url_hash`);
--> statement-breakpoint
CREATE INDEX `codegraph_embeddings_model_idx` ON `codegraph_embeddings` (`model`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `codegraph_fts` USING fts5(
  node_id UNINDEXED,
  qualified_name,
  name,
  doc,
  text_excerpt,
  tokenize = 'porter unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `codegraph_fts_ai` AFTER INSERT ON `codegraph_nodes` BEGIN
  INSERT INTO `codegraph_fts`(node_id, qualified_name, name, doc, text_excerpt)
  VALUES (new.id, new.qualified_name, new.name, COALESCE(new.doc, ''), new.text_excerpt);
END;
--> statement-breakpoint
CREATE TRIGGER `codegraph_fts_ad` AFTER DELETE ON `codegraph_nodes` BEGIN
  DELETE FROM `codegraph_fts` WHERE node_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `codegraph_fts_au` AFTER UPDATE ON `codegraph_nodes` BEGIN
  UPDATE `codegraph_fts`
  SET qualified_name = new.qualified_name,
      name = new.name,
      doc = COALESCE(new.doc, ''),
      text_excerpt = new.text_excerpt
  WHERE node_id = new.id;
END;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `embedding_id` text REFERENCES `codegraph_embeddings`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `access_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `last_accessed_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `updated_at` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `memory_entries` ADD COLUMN `ttl_seconds` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_scope_session_key_idx` ON `memory_entries` (`scope`,`session_id`,`key`);
--> statement-breakpoint
CREATE INDEX `memory_expires_idx` ON `memory_entries` (`expires_at`);
