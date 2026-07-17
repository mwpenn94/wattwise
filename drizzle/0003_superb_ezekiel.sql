CREATE TABLE `entities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`kind` enum('household','company','property_owner','other') NOT NULL DEFAULT 'other',
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `entities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `sites` ADD `entityId` int;--> statement-breakpoint
CREATE INDEX `entities_user_idx` ON `entities` (`userId`);--> statement-breakpoint
CREATE INDEX `sites_entity_idx` ON `sites` (`entityId`);