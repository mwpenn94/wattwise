CREATE TABLE `report_artifacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`siteId` int NOT NULL,
	`token` varchar(64) NOT NULL,
	`kind` enum('energy_plan','verified_savings','practitioner') NOT NULL,
	`snapshot` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `report_artifacts_id` PRIMARY KEY(`id`),
	CONSTRAINT `report_artifacts_token_unique` UNIQUE(`token`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `digestOptIn` boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `digestAnchorDay` int DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `report_artifacts_user_idx` ON `report_artifacts` (`userId`);--> statement-breakpoint
CREATE INDEX `report_artifacts_token_idx` ON `report_artifacts` (`token`);