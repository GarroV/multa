ALTER TABLE "transactions" DROP CONSTRAINT "transactions_planned_item_id_planned_items_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_planned_item_id_planned_items_id_fk" FOREIGN KEY ("planned_item_id") REFERENCES "public"."planned_items"("id") ON DELETE set null ON UPDATE no action;