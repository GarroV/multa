CREATE TABLE "income_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"currency" char(3) NOT NULL,
	"schedule" jsonb NOT NULL,
	"amount" jsonb NOT NULL,
	"stability" text DEFAULT 'fixed' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_sources_stability_ck" CHECK ("income_sources"."stability" in ('fixed','variable'))
);
--> statement-breakpoint
ALTER TABLE "recurring_items" DROP CONSTRAINT "recurring_items_kind_ck";--> statement-breakpoint
ALTER TABLE "income_sources" ADD CONSTRAINT "income_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "income_sources_ws_idx" ON "income_sources" USING btree ("workspace_id","sort");--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "expected_income_minor";--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_kind_ck" CHECK ("recurring_items"."kind" in ('expense','envelope','goal','debt'));