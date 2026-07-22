CREATE TABLE `telecom_benchmarks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`serviceType` enum('internet','mobile','tv_bundle','phone_landline') NOT NULL,
	`tierKey` varchar(64) NOT NULL,
	`tierLabel` varchar(255) NOT NULL,
	`minMbps` double,
	`maxMbps` double,
	`perLine` boolean NOT NULL DEFAULT false,
	`typicalLowUsd` double NOT NULL,
	`medianUsd` double NOT NULL,
	`typicalHighUsd` double NOT NULL,
	`basis` varchar(512) NOT NULL,
	`sourceVersion` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `telecom_benchmarks_id` PRIMARY KEY(`id`),
	CONSTRAINT `telecom_benchmarks_tierKey_unique` UNIQUE(`tierKey`)
);
--> statement-breakpoint
CREATE TABLE `telecom_services` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`serviceType` enum('internet','mobile','tv_bundle','phone_landline') NOT NULL,
	`provider` varchar(128) NOT NULL,
	`planName` varchar(255),
	`monthlyCostUsd` double NOT NULL,
	`promoEndsAt` bigint,
	`postPromoCostUsd` double,
	`contractEndsAt` bigint,
	`downloadMbps` double,
	`isBusiness` boolean NOT NULL DEFAULT false,
	`lines` int,
	`dataAllowanceGb` double,
	`unlimitedData` boolean NOT NULL DEFAULT false,
	`actualDataUsedGb` double,
	`actualDownloadNeedMbps` double,
	`source` enum('manual','bill_parsed') NOT NULL DEFAULT 'manual',
	`notes` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `telecom_services_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `telecom_bench_type_idx` ON `telecom_benchmarks` (`serviceType`);--> statement-breakpoint
CREATE INDEX `telecom_site_idx` ON `telecom_services` (`siteId`);--> statement-breakpoint
CREATE INDEX `telecom_user_idx` ON `telecom_services` (`userId`);