CREATE TABLE `measure_implementations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`siteId` int NOT NULL,
	`opportunityId` int,
	`measure` varchar(128) NOT NULL,
	`title` varchar(512) NOT NULL,
	`implementedAt` bigint NOT NULL,
	`expectedSavingsUsd` double,
	`status` enum('awaiting_data','on_track','verified','underperforming','inconclusive') NOT NULL DEFAULT 'awaiting_data',
	`verdicts` json,
	`verifiedSavingsUsd` double,
	`lastEvaluatedAt` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `measure_implementations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `mi_site_idx` ON `measure_implementations` (`siteId`);--> statement-breakpoint
CREATE INDEX `mi_user_idx` ON `measure_implementations` (`userId`);