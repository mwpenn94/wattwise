CREATE TABLE `analyses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`status` enum('pending','running','complete','failed','timeout') NOT NULL DEFAULT 'pending',
	`stagesCompleted` json,
	`weatherBasis` varchar(32),
	`marginalCostUsd` double DEFAULT 0,
	`durationMs` int,
	`error` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `analyses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `archetype_profiles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`buildingType` varchar(64) NOT NULL,
	`sectorClass` enum('residential','commercial') NOT NULL,
	`climateZone` varchar(16) NOT NULL,
	`vintageBand` varchar(32) NOT NULL,
	`sizeBandSqft` varchar(32) NOT NULL,
	`commodity` enum('electric','gas','water') NOT NULL DEFAULT 'electric',
	`shape8760` json NOT NULL,
	`endUseFractions` json NOT NULL,
	`annualUsePerSqft` double NOT NULL,
	`peakWPerSqft` double,
	`source` varchar(64) NOT NULL,
	`sourceVersion` varchar(32),
	`confidenceLabel` varchar(64) NOT NULL,
	`calibMinSqft` double,
	`calibMaxSqft` double,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `archetype_profiles_id` PRIMARY KEY(`id`),
	CONSTRAINT `archetype_cell_uq` UNIQUE(`buildingType`,`climateZone`,`vintageBand`,`sizeBandSqft`,`commodity`)
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`userId` int,
	`action` varchar(128) NOT NULL,
	`entity` varchar(64),
	`entityId` varchar(64),
	`detail` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `baselines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`meterId` int,
	`siteId` int NOT NULL,
	`method` enum('billing_hdd_cdd','daily_hdd_cdd','hourly_towt','archetype_synthetic','custom_water_seasonal') NOT NULL,
	`commodity` enum('electric','gas','water') NOT NULL,
	`params` json NOT NULL,
	`rSquared` double,
	`cvrmse` double,
	`trainStart` bigint,
	`trainEnd` bigint,
	`weatherBasis` varchar(32) NOT NULL,
	`confidenceLabel` varchar(128) NOT NULL,
	`source` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `baselines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `benchmarks` (
	`id` int AUTO_INCREMENT NOT NULL,
	`buildingType` varchar(64) NOT NULL,
	`sectorClass` enum('residential','commercial') NOT NULL,
	`commodity` enum('electric','gas','water','site_total') NOT NULL,
	`medianEui` double NOT NULL,
	`p25Eui` double,
	`p75Eui` double,
	`unit` varchar(32) NOT NULL,
	`source` varchar(64) NOT NULL,
	`sourceVersion` varchar(32) NOT NULL,
	CONSTRAINT `benchmarks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bills` (
	`id` int AUTO_INCREMENT NOT NULL,
	`meterId` int NOT NULL,
	`periodStart` date NOT NULL,
	`periodEnd` date NOT NULL,
	`usage` double,
	`demandActual` double,
	`demandBilled` double,
	`totalCost` double,
	`energyCost` double,
	`demandCost` double,
	`fixedCost` double,
	`source` enum('parsed_pdf','parsed_image','manual','computed') NOT NULL,
	`parseConfidence` double,
	`uploadId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `convergence_log` (
	`id` int AUTO_INCREMENT NOT NULL,
	`cycle` varchar(32) NOT NULL,
	`phase` varchar(128) NOT NULL,
	`summary` text NOT NULL,
	`passes` int DEFAULT 0,
	`cleanStreak` int DEFAULT 0,
	`resets` int DEFAULT 0,
	`materialFindings` int DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `convergence_log_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `emissions_factors` (
	`id` int AUTO_INCREMENT NOT NULL,
	`subregion` varchar(8) NOT NULL,
	`subregionName` varchar(128),
	`co2eLbPerMwh` double NOT NULL,
	`year` int NOT NULL,
	`source` varchar(64) NOT NULL DEFAULT 'epa_egrid',
	`sourceVersion` varchar(32) NOT NULL,
	CONSTRAINT `emissions_factors_id` PRIMARY KEY(`id`),
	CONSTRAINT `egrid_sub_year_uq` UNIQUE(`subregion`,`year`)
);
--> statement-breakpoint
CREATE TABLE `insights` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`meterId` int,
	`analysisId` int,
	`kind` varchar(64) NOT NULL,
	`title` varchar(512) NOT NULL,
	`body` text NOT NULL,
	`severity` enum('info','opportunity','warning','anomaly') NOT NULL DEFAULT 'info',
	`disaggregationMethod` enum('archetype_prior_only','regression_split','nilmtk_1min_plus'),
	`confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
	`provenance` json,
	`metrics` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `insights_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `intervals` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`meterId` int NOT NULL,
	`ts` bigint NOT NULL,
	`durationMin` int NOT NULL,
	`usage` double NOT NULL,
	`demand` double,
	`uploadId` int NOT NULL,
	`precedence` int NOT NULL DEFAULT 0,
	`qcFlags` varchar(64),
	CONSTRAINT `intervals_id` PRIMARY KEY(`id`),
	CONSTRAINT `intervals_dedupe_uq` UNIQUE(`meterId`,`ts`,`durationMin`)
);
--> statement-breakpoint
CREATE TABLE `metering` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`analysisId` int,
	`kind` varchar(64) NOT NULL,
	`llmTokensIn` int DEFAULT 0,
	`llmTokensOut` int DEFAULT 0,
	`llmCostUsd` double DEFAULT 0,
	`computeMs` int DEFAULT 0,
	`computeCostUsd` double DEFAULT 0,
	`totalCostUsd` double DEFAULT 0,
	`tierAtTime` varchar(16) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `metering_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `meters` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`commodity` enum('electric','gas','water') NOT NULL,
	`label` varchar(255),
	`accountNumber` varchar(64),
	`servicePoint` varchar(64),
	`usageUnit` varchar(16) NOT NULL,
	`demandUnit` varchar(16),
	`timezone` varchar(64) NOT NULL DEFAULT 'America/Phoenix',
	`currentTariffId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `meters_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `opportunities` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`analysisId` int,
	`measure` varchar(128) NOT NULL,
	`title` varchar(512) NOT NULL,
	`description` text,
	`estEnergySavingsPerYr` double,
	`energyUnit` varchar(16),
	`estDemandSavingsKw` double,
	`estCostSavingsPerYr` double,
	`paybackBandYears` varchar(32),
	`confidence` enum('low','medium','high') NOT NULL DEFAULT 'medium',
	`disaggregationMethod` enum('archetype_prior_only','regression_split','nilmtk_1min_plus'),
	`ratchetAware` boolean NOT NULL DEFAULT false,
	`rank` int NOT NULL DEFAULT 0,
	`provenance` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `opportunities_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `scenarios` (
	`id` int AUTO_INCREMENT NOT NULL,
	`siteId` int NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`transform` enum('rate_switch','solar','battery_peak_shave','schedule_shift','led_equipment','electrification','ev_charging','occupancy_change','hypothetical_building') NOT NULL,
	`params` json NOT NULL,
	`loadBasis` varchar(32) NOT NULL,
	`results` json,
	`status` enum('pending','complete','failed') NOT NULL DEFAULT 'pending',
	`confidenceLabel` varchar(128),
	`extrapolated` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `scenarios_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `seeder_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`seeder` varchar(64) NOT NULL,
	`version` varchar(32) NOT NULL,
	`status` enum('running','complete','failed') NOT NULL,
	`rowsSeeded` int DEFAULT 0,
	`license` varchar(128) NOT NULL,
	`licenseUrl` text,
	`notes` text,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	CONSTRAINT `seeder_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `seeder_version_uq` UNIQUE(`seeder`,`version`)
);
--> statement-breakpoint
CREATE TABLE `sites` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`address` text,
	`city` varchar(128),
	`state` varchar(8),
	`zip` varchar(16),
	`buildingType` varchar(64),
	`sqft` double,
	`vintage` int,
	`climateZone` varchar(16),
	`occupancyHours` json,
	`utilityName` varchar(128),
	`egridSubregion` varchar(8),
	`isHypothetical` boolean NOT NULL DEFAULT false,
	`attrSource` varchar(32) DEFAULT 'user_entered',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sites_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `tariffs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`urdbId` varchar(64),
	`utilityName` varchar(255) NOT NULL,
	`name` varchar(512) NOT NULL,
	`sector` enum('residential','commercial','industrial','lighting') NOT NULL,
	`commodity` enum('electric','gas','water') NOT NULL DEFAULT 'electric',
	`state` varchar(8),
	`peakKwMin` double,
	`peakKwMax` double,
	`structure` json NOT NULL,
	`freshness` enum('urdb_refreshed_150','urdb_stale','manual','verified') NOT NULL DEFAULT 'urdb_stale',
	`effectiveDate` date,
	`source` varchar(64) NOT NULL DEFAULT 'urdb_snapshot',
	`sourceVersion` varchar(32),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tariffs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`siteId` int,
	`filename` varchar(512) NOT NULL,
	`fileKey` varchar(512),
	`fileUrl` text,
	`sha256` varchar(64) NOT NULL,
	`format` enum('xlsx','csv','espi_xml','bill_pdf','bill_image','manual') NOT NULL,
	`parser` varchar(64),
	`parserVersion` varchar(32),
	`parseConfidence` double,
	`rowsIngested` int DEFAULT 0,
	`rowsSkipped` int DEFAULT 0,
	`sheetsFound` int DEFAULT 0,
	`footerTotals` json,
	`validation` json,
	`status` enum('pending','parsed','failed','duplicate') NOT NULL DEFAULT 'pending',
	`error` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `uploads_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `weather_normals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`stationId` varchar(32) NOT NULL,
	`stationName` varchar(128),
	`climateZone` varchar(16) NOT NULL,
	`state` varchar(8),
	`monthlyNormals` json NOT NULL,
	`tmyHourlyTempF` json,
	`source` varchar(64) NOT NULL,
	`sourceVersion` varchar(32) NOT NULL,
	CONSTRAINT `weather_normals_id` PRIMARY KEY(`id`),
	CONSTRAINT `station_uq` UNIQUE(`stationId`)
);
--> statement-breakpoint
CREATE TABLE `zip_subregions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`zip3` varchar(3) NOT NULL,
	`state` varchar(8),
	`subregion` varchar(8) NOT NULL,
	`sourceVersion` varchar(32) NOT NULL,
	CONSTRAINT `zip_subregions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `tier` enum('free','plus','pro') DEFAULT 'free' NOT NULL;--> statement-breakpoint
CREATE INDEX `analyses_site_idx` ON `analyses` (`siteId`);--> statement-breakpoint
CREATE INDEX `audit_user_idx` ON `audit_log` (`userId`);--> statement-breakpoint
CREATE INDEX `baselines_site_idx` ON `baselines` (`siteId`);--> statement-breakpoint
CREATE INDEX `bench_type_idx` ON `benchmarks` (`buildingType`);--> statement-breakpoint
CREATE INDEX `bills_meter_idx` ON `bills` (`meterId`);--> statement-breakpoint
CREATE INDEX `insights_site_idx` ON `insights` (`siteId`);--> statement-breakpoint
CREATE INDEX `intervals_meter_ts_idx` ON `intervals` (`meterId`,`ts`);--> statement-breakpoint
CREATE INDEX `metering_user_idx` ON `metering` (`userId`);--> statement-breakpoint
CREATE INDEX `meters_site_idx` ON `meters` (`siteId`);--> statement-breakpoint
CREATE INDEX `meters_user_idx` ON `meters` (`userId`);--> statement-breakpoint
CREATE INDEX `opps_site_idx` ON `opportunities` (`siteId`);--> statement-breakpoint
CREATE INDEX `scenarios_site_idx` ON `scenarios` (`siteId`);--> statement-breakpoint
CREATE INDEX `sites_user_idx` ON `sites` (`userId`);--> statement-breakpoint
CREATE INDEX `tariffs_utility_idx` ON `tariffs` (`utilityName`);--> statement-breakpoint
CREATE INDEX `tariffs_state_sector_idx` ON `tariffs` (`state`,`sector`);--> statement-breakpoint
CREATE INDEX `uploads_user_idx` ON `uploads` (`userId`);--> statement-breakpoint
CREATE INDEX `uploads_sha_idx` ON `uploads` (`sha256`);--> statement-breakpoint
CREATE INDEX `zip3_idx` ON `zip_subregions` (`zip3`);