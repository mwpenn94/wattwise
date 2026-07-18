CREATE TABLE `plan_baskets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`measures` json NOT NULL,
	`composedResults` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `plan_baskets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `plan_baskets_site_idx` ON `plan_baskets` (`siteId`);--> statement-breakpoint
CREATE INDEX `plan_baskets_user_idx` ON `plan_baskets` (`userId`);