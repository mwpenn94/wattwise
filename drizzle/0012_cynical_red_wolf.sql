CREATE TABLE `service_territories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`zip3` varchar(3) NOT NULL,
	`state` varchar(8) NOT NULL,
	`commodity` enum('electric','gas','water') NOT NULL,
	`utilityName` varchar(255) NOT NULL,
	`sourceVersion` varchar(64) NOT NULL,
	CONSTRAINT `service_territories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `territory_zip3_idx` ON `service_territories` (`zip3`,`commodity`);