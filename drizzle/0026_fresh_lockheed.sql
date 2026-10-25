CREATE TABLE `site_property_facts` (
`id` int AUTO_INCREMENT NOT NULL,
`siteId` int NOT NULL,
`userId` int NOT NULL,
`locationRevision` int NOT NULL DEFAULT 0,
`status` varchar(32) NOT NULL,
`facts` json,
`estimateSqft` double,
`estimateBasis` varchar(48),
`appliedSqft` double,
`appliedBy` varchar(16),
`appliedAt` bigint,
`fetchedAt` bigint NOT NULL,
`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
`createdAt` timestamp NOT NULL DEFAULT (now()),
CONSTRAINT `site_property_facts_id` PRIMARY KEY(`id`),
CONSTRAINT `site_property_facts_site_uq` UNIQUE(`siteId`)
);
--> statement-breakpoint
CREATE INDEX `site_property_facts_user_idx` ON `site_property_facts` (`userId`);
