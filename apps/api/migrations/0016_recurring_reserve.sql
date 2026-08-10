ALTER TABLE "planned_items" DROP CONSTRAINT "planned_items_target_ck";--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "reserve" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "planned_items" ADD CONSTRAINT "planned_items_target_ck" CHECK ("planned_items"."target_kind" in ('category','debt','envelope','goal','bucket','recurring'));