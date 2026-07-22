CREATE TABLE `rate_sources` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceKey` varchar(96) NOT NULL,
	`utilityName` varchar(255) NOT NULL,
	`commodity` enum('electric','gas','water') NOT NULL,
	`state` varchar(8) NOT NULL,
	`sourceUrl` varchar(512) NOT NULL,
	`sourceLabel` varchar(255) NOT NULL,
	`governsUrdbIds` json NOT NULL,
	`adjustorCycle` varchar(32) NOT NULL DEFAULT 'none',
	`verifyCadenceDays` int NOT NULL DEFAULT 90,
	`contentFingerprint` varchar(64),
	`fingerprintAt` bigint,
	`changeDetectedAt` bigint,
	`lastVerifiedAt` bigint,
	`consecutiveFailures` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rate_sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `rate_sources_sourceKey_unique` UNIQUE(`sourceKey`)
);
--> statement-breakpoint
CREATE TABLE `rate_verifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sourceKey` varchar(96) NOT NULL,
	`urdbId` varchar(64),
	`checkedAt` bigint NOT NULL,
	`status` varchar(32) NOT NULL,
	`observed` json,
	`applied` boolean NOT NULL DEFAULT false,
	`evidence` varchar(1024),
	`method` varchar(32) NOT NULL DEFAULT 'agent_verify',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `rate_verifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `tariffs` ADD `sourceUrl` varchar(512);--> statement-breakpoint
ALTER TABLE `tariffs` ADD `lastVerifiedAt` bigint;--> statement-breakpoint
ALTER TABLE `tariffs` ADD `verifyStatus` enum('current','change_detected','due','superseded') DEFAULT 'current' NOT NULL;--> statement-breakpoint
CREATE INDEX `rate_verifications_source_idx` ON `rate_verifications` (`sourceKey`,`checkedAt`);