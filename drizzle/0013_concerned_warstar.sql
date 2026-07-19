ALTER TABLE `incentives` ADD `lastVerifiedAt` bigint;--> statement-breakpoint
ALTER TABLE `incentives` ADD `sourceVersion` varchar(64) DEFAULT 'seed.1' NOT NULL;--> statement-breakpoint
ALTER TABLE `service_territories` ADD `lastVerifiedAt` bigint;