CREATE TABLE `site_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`name` varchar(128) NOT NULL,
	`kind` varchar(32) NOT NULL DEFAULT 'business',
	`days` json NOT NULL,
	`startHour` int NOT NULL,
	`endHour` int NOT NULL,
	`months` json,
	`usageSharePct` double NOT NULL DEFAULT 100,
	`source` varchar(32) NOT NULL DEFAULT 'user',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `site_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_site_schedules_site` ON `site_schedules` (`siteId`);