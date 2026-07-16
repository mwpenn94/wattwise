ALTER TABLE `baselines` MODIFY COLUMN `method` enum('billing_hdd_cdd','daily_hdd_cdd','hourly_towt','archetype_synthetic','custom_water_seasonal','predictive_baseline') NOT NULL;--> statement-breakpoint
ALTER TABLE `bills` ADD `billRevision` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `bills` ADD `supersedesBillId` int;--> statement-breakpoint
ALTER TABLE `bills` ADD `demandBilledSource` enum('parsed_bill','ratchet_computed');--> statement-breakpoint
ALTER TABLE `meters` ADD `meterSerial` varchar(64);--> statement-breakpoint
ALTER TABLE `meters` ADD `activeFrom` bigint;--> statement-breakpoint
ALTER TABLE `meters` ADD `activeTo` bigint;