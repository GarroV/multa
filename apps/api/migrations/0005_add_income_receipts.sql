CREATE TABLE "income_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"occurred_on" date NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"base_amount_minor" bigint NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"rate_source" text NOT NULL,
	"rate_date" date NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_receipts_source_day_uq" UNIQUE("workspace_id","source_id","occurred_on")
);
--> statement-breakpoint
ALTER TABLE "income_receipts" ADD CONSTRAINT "income_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_receipts" ADD CONSTRAINT "income_receipts_source_id_income_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."income_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "income_receipts_ws_day_idx" ON "income_receipts" USING btree ("workspace_id","occurred_on");