CREATE TABLE "fx_manual_rates" (
	"workspace_id" uuid NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) NOT NULL,
	"on_date" date NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_manual_rates_workspace_id_base_quote_on_date_pk" PRIMARY KEY("workspace_id","base","quote","on_date")
);
--> statement-breakpoint
ALTER TABLE "fx_manual_rates" ADD CONSTRAINT "fx_manual_rates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;