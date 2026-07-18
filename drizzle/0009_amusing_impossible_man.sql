CREATE TABLE `alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`siteId` int NOT NULL,
	`kind` enum('anomaly','demand_spike','rate_opportunity','verdict','digest') NOT NULL,
	`title` varchar(255) NOT NULL,
	`body` text,
	`dollarImpactUsd` double NOT NULL,
	`confidence` varchar(32),
	`status` enum('open','read','dismissed') NOT NULL DEFAULT 'open',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `digestCronTaskUid` varchar(65);--> statement-breakpoint
CREATE INDEX `alerts_user_idx` ON `alerts` (`userId`);--> statement-breakpoint
CREATE INDEX `alerts_site_kind_idx` ON `alerts` (`siteId`,`kind`);--> statement-breakpoint
CREATE INDEX `alerts_status_idx` ON `alerts` (`userId`,`status`);