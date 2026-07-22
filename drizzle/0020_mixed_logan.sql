CREATE TABLE `rate_acquisition_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`utilityName` varchar(255) NOT NULL,
	`state` varchar(8) NOT NULL,
	`commodity` enum('electric','gas','water') NOT NULL,
	`requestedBySiteId` int,
	`status` enum('pending','dispatched','acquired','failed') NOT NULL DEFAULT 'pending',
	`demandCount` int NOT NULL DEFAULT 1,
	`lastError` varchar(512),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rate_acquisition_queue_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `rate_sources` ADD `sourceKind` enum('tariff','docket') DEFAULT 'tariff' NOT NULL;--> statement-breakpoint
CREATE INDEX `raq_utility_idx` ON `rate_acquisition_queue` (`utilityName`,`state`,`commodity`);