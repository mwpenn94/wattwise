CREATE TABLE `site_geometry` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`footprint` json,
	`footprintSource` enum('assessor_gis','microsoft','osm','user_drawn'),
	`footprintSqft` double,
	`heightM` double,
	`heightSource` enum('lidar','footprint_dataset','stories_estimate'),
	`stories` int,
	`roofType` enum('flat','pitched','complex'),
	`roofSegments` json,
	`orientationDeg` double,
	`exposedWallAreaByOrientation` json,
	`neighborShadingFactor` double,
	`exposureScore` double,
	`treeCanopyPct` double,
	`geometryConfidence` json,
	`odblDerived` boolean NOT NULL DEFAULT false,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `site_geometry_id` PRIMARY KEY(`id`),
	CONSTRAINT `site_geometry_site_unique` UNIQUE(`siteId`)
);
--> statement-breakpoint
CREATE TABLE `site_group_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`groupId` int NOT NULL,
	`siteId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `site_group_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `sgm_unique` UNIQUE(`groupId`,`siteId`)
);
--> statement-breakpoint
CREATE TABLE `site_groups` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`entityId` int,
	`name` varchar(128) NOT NULL,
	`kind` enum('region','manager','brand','custom') NOT NULL DEFAULT 'custom',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `site_groups_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `meters` ADD `meterRole` enum('main','submeter','generation','ev','virtual_total') DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `meters` ADD `parentMeterId` int;--> statement-breakpoint
CREATE INDEX `site_geometry_user_idx` ON `site_geometry` (`userId`);--> statement-breakpoint
CREATE INDEX `sgm_group_idx` ON `site_group_members` (`groupId`);--> statement-breakpoint
CREATE INDEX `sgm_site_idx` ON `site_group_members` (`siteId`);--> statement-breakpoint
CREATE INDEX `site_groups_user_idx` ON `site_groups` (`userId`);