CREATE TABLE `geometry_resolve_cache` (
	`id` int AUTO_INCREMENT NOT NULL,
	`gridKey` varchar(32) NOT NULL,
	`provider` enum('osm','esri','none') NOT NULL,
	`candidates` json NOT NULL,
	`resolvedAt` bigint NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `geometry_resolve_cache_id` PRIMARY KEY(`id`),
	CONSTRAINT `geometry_resolve_cache_gridKey_unique` UNIQUE(`gridKey`)
);
