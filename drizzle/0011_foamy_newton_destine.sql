ALTER TABLE `scenarios` MODIFY COLUMN `transform` enum('rate_switch','solar','battery_peak_shave','schedule_shift','led_equipment','electrification','ev_charging','occupancy_change','hypothetical_building','gas_efficiency','water_efficiency') NOT NULL;--> statement-breakpoint
ALTER TABLE `incentives` ADD `unitCommodity` varchar(16);--> statement-breakpoint
ALTER TABLE `incentives` ADD `unitLabel` varchar(16);--> statement-breakpoint
ALTER TABLE `sites` ADD `servicesProfile` json;