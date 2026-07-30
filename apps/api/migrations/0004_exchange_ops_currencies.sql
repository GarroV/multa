ALTER TABLE "exchange_ops" ALTER COLUMN "from_account" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_ops" ALTER COLUMN "to_account" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_ops" ALTER COLUMN "official_rate" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_ops" ALTER COLUMN "official_source" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_ops" ALTER COLUMN "spread_pct" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD COLUMN "from_currency" char(3) NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD COLUMN "to_currency" char(3) NOT NULL;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD COLUMN "spread_minor" bigint;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD COLUMN "note" text;