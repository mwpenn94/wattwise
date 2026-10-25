CREATE TABLE `import_batch_files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`batchId` int NOT NULL,
	`userId` int NOT NULL,
	`filename` varchar(512) NOT NULL,
	`sha256` varchar(64) NOT NULL,
	`fileKey` varchar(512),
	`sizeBytes` int NOT NULL,
	`sheetCount` int NOT NULL DEFAULT 0,
	`uploadId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `import_batch_files_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `import_batch_sheets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`batchId` int NOT NULL,
	`fileId` int NOT NULL,
	`userId` int NOT NULL,
	`sheetName` varchar(255) NOT NULL,
	`accountNumber` varchar(64),
	`serviceAgreementId` varchar(64),
	`servicePointId` varchar(64),
	`rateScheduleCode` varchar(32),
	`addressRaw` varchar(512),
	`baseAddress` varchar(512),
	`facilityLabel` varchar(255),
	`groupKey` varchar(512),
	`overrideSiteId` int,
	`status` enum('pending','importing','imported','duplicate','skipped','failed') NOT NULL DEFAULT 'pending',
	`siteId` int,
	`meterId` int,
	`pointsWritten` int NOT NULL DEFAULT 0,
	`detail` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `import_batch_sheets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`entityId` int,
	`status` enum('staging','previewed','committing','complete','partial','failed') NOT NULL DEFAULT 'staging',
	`groupingMode` enum('campus','building') NOT NULL DEFAULT 'campus',
	`plan` json,
	`summary` json,
	`error` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`completedAt` bigint,
	CONSTRAINT `import_batches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `recommendation_states` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`siteId` int NOT NULL,
	`measure` varchar(128) NOT NULL,
	`title` varchar(512),
	`status` enum('planned','in_progress','completed','deferred','dismissed') NOT NULL,
	`implementationId` int,
	`note` text,
	`savingsLowUsd` double,
	`savingsHighUsd` double,
	`deferUntil` bigint,
	`changedAt` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `recommendation_states_id` PRIMARY KEY(`id`),
	CONSTRAINT `rec_states_site_measure_uq` UNIQUE(`siteId`,`measure`)
);
--> statement-breakpoint
ALTER TABLE `meters` ADD `serviceAgreementId` varchar(64);--> statement-breakpoint
ALTER TABLE `meters` ADD `rateScheduleCode` varchar(32);--> statement-breakpoint
ALTER TABLE `meters` ADD `facilityLabel` varchar(255);--> statement-breakpoint
ALTER TABLE `meters` ADD `importBatchId` int;--> statement-breakpoint
CREATE INDEX `import_batch_files_batch_idx` ON `import_batch_files` (`batchId`);--> statement-breakpoint
CREATE INDEX `import_batch_sheets_batch_idx` ON `import_batch_sheets` (`batchId`);--> statement-breakpoint
CREATE INDEX `import_batches_user_idx` ON `import_batches` (`userId`);--> statement-breakpoint
CREATE INDEX `rec_states_user_idx` ON `recommendation_states` (`userId`);