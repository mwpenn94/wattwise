CREATE TABLE `billing_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`plan` varchar(32) NOT NULL DEFAULT 'free',
	`entitlementTier` enum('free','plus','pro') NOT NULL DEFAULT 'free',
	`status` varchar(32) NOT NULL DEFAULT 'active',
	`stripeCustomerId` varchar(128),
	`stripeSubscriptionId` varchar(128),
	`stripePriceId` varchar(128),
	`currentPeriodEnd` bigint,
	`cancelAtPeriodEnd` boolean NOT NULL DEFAULT false,
	`graceEndsAt` bigint,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `billing_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_accounts_userId_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `billing_audit` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`action` varchar(64) NOT NULL,
	`fromPlan` varchar(32),
	`toPlan` varchar(32),
	`source` varchar(32) NOT NULL DEFAULT 'system',
	`details` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `billing_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_webhook_events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventId` varchar(128) NOT NULL,
	`eventType` varchar(128) NOT NULL,
	`processedAt` bigint NOT NULL,
	`status` varchar(32) NOT NULL DEFAULT 'processed',
	`error` text,
	CONSTRAINT `billing_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `billing_webhook_events_eventId_unique` UNIQUE(`eventId`)
);
--> statement-breakpoint
CREATE INDEX `billing_accounts_status_idx` ON `billing_accounts` (`status`);--> statement-breakpoint
CREATE INDEX `billing_audit_user_idx` ON `billing_audit` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `billing_webhook_events_type_idx` ON `billing_webhook_events` (`eventType`,`processedAt`);
