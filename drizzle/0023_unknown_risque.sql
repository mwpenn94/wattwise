CREATE TABLE `telecom_price_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`serviceId` int NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`periodStart` bigint NOT NULL,
	`periodEnd` bigint NOT NULL,
	`billedUsd` double NOT NULL,
	`normalizedMonthlyUsd` double NOT NULL,
	`source` enum('entered_bill','ocr_confirmed','manual') NOT NULL DEFAULT 'manual',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `telecom_price_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `telecom_price_period_unique` UNIQUE(`serviceId`,`periodStart`,`periodEnd`)
);
--> statement-breakpoint
CREATE INDEX `telecom_price_user_idx` ON `telecom_price_history` (`userId`,`serviceId`);