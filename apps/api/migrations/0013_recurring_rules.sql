ALTER TABLE "recurring_items" ADD COLUMN "starts_on" date;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "ends_on" date;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "show_on_map" boolean DEFAULT true NOT NULL;