ALTER TABLE "debts" ADD COLUMN "amount_steps" jsonb;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD COLUMN "amount_steps" jsonb;--> statement-breakpoint
ALTER TABLE "recurring_items" DROP COLUMN "escalation";