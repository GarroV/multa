CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"kind" text NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "accounts_kind_ck" CHECK ("accounts"."kind" in ('cash','card','savings','other'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"icon" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"protected" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currency_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"from_currency" char(3) NOT NULL,
	"to_currency" char(3) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"principal_minor" bigint NOT NULL,
	"remaining_minor" bigint NOT NULL,
	"payment_minor" bigint NOT NULL,
	"due_date" date,
	"counterparty" text,
	"agreed_rate" numeric(20, 10),
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"rule_kind" text NOT NULL,
	"rule_value" numeric(12, 4) NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "envelopes_rule_kind_ck" CHECK ("envelopes"."rule_kind" in ('fixed','percent'))
);
--> statement-breakpoint
CREATE TABLE "exchange_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bucket_id" uuid,
	"from_account" uuid NOT NULL,
	"to_account" uuid NOT NULL,
	"from_minor" bigint NOT NULL,
	"to_minor" bigint NOT NULL,
	"actual_rate" numeric(20, 10) NOT NULL,
	"official_rate" numeric(20, 10) NOT NULL,
	"official_source" text NOT NULL,
	"spread_pct" numeric(8, 4) NOT NULL,
	"occurred_on" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"source" text NOT NULL,
	"base" char(3) NOT NULL,
	"quote" char(3) NOT NULL,
	"on_date" date NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	CONSTRAINT "fx_rates_source_base_quote_on_date_pk" PRIMARY KEY("source","base","quote","on_date")
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) NOT NULL,
	"target_minor" bigint NOT NULL,
	"saved_minor" bigint DEFAULT 0 NOT NULL,
	"planned_per_period_minor" bigint DEFAULT 0 NOT NULL,
	"achieved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pay_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"expected_income_minor" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	CONSTRAINT "pay_periods_ws_start_uq" UNIQUE("workspace_id","starts_on"),
	CONSTRAINT "pay_periods_status_ck" CHECK ("pay_periods"."status" in ('planned','active','closed'))
);
--> statement-breakpoint
CREATE TABLE "plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"moves" jsonb NOT NULL,
	"accepted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_revisions_reason_ck" CHECK ("plan_revisions"."reason" in ('overspend','manual','income_change','auto_suggest'))
);
--> statement-breakpoint
CREATE TABLE "planned_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"planned_minor" bigint NOT NULL,
	"execution_status" text DEFAULT 'pending' NOT NULL,
	"executed_minor" bigint DEFAULT 0 NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	CONSTRAINT "planned_items_uq" UNIQUE("period_id","target_kind","target_id"),
	CONSTRAINT "planned_items_target_ck" CHECK ("planned_items"."target_kind" in ('category','debt','envelope','goal','bucket')),
	CONSTRAINT "planned_items_status_ck" CHECK ("planned_items"."execution_status" in ('pending','confirmed','partial','skipped','n_a'))
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"method" text,
	"merchant" text,
	"total_minor" bigint,
	"currency" char(3),
	"purchased_at" timestamp with time zone,
	"items" jsonb,
	"image_path" text,
	"qr_payload" text,
	CONSTRAINT "receipts_status_ck" CHECK ("receipts"."status" in ('pending','parsed','fallback','failed')),
	CONSTRAINT "receipts_method_ck" CHECK ("receipts"."method" is null or "receipts"."method" in ('qr_fns','qr_rs','vision'))
);
--> statement-breakpoint
CREATE TABLE "recurring_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_id" uuid,
	"name" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"schedule" jsonb NOT NULL,
	"next_on" date,
	"escalation" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "recurring_items_kind_ck" CHECK ("recurring_items"."kind" in ('income','expense','envelope','goal','debt'))
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid,
	"period_id" uuid,
	"kind" text NOT NULL,
	"target_kind" text,
	"target_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"base_amount_minor" bigint NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"rate_source" text NOT NULL,
	"rate_date" date NOT NULL,
	"occurred_on" date NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"note" text,
	"raw_input" text,
	"receipt_id" uuid,
	"transfer_pair_id" uuid,
	"planned_item_id" uuid,
	CONSTRAINT "transactions_kind_ck" CHECK ("transactions"."kind" in ('expense','income','transfer_out','transfer_in','exchange')),
	CONSTRAINT "transactions_source_ck" CHECK ("transactions"."source" in ('manual','text','voice','receipt','recurring','import')),
	CONSTRAINT "transactions_target_ck" CHECK ("transactions"."target_kind" is null or "transactions"."target_kind" in ('category','debt','envelope','goal'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"base_currency" char(3) DEFAULT 'RUB' NOT NULL,
	"timezone" text DEFAULT 'Europe/Belgrade' NOT NULL,
	"locale" text DEFAULT 'ru' NOT NULL,
	"period_anchors" jsonb,
	"expected_income_minor" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "currency_buckets" ADD CONSTRAINT "currency_buckets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debts" ADD CONSTRAINT "debts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD CONSTRAINT "exchange_ops_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD CONSTRAINT "exchange_ops_bucket_id_currency_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."currency_buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD CONSTRAINT "exchange_ops_from_account_accounts_id_fk" FOREIGN KEY ("from_account") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_ops" ADD CONSTRAINT "exchange_ops_to_account_accounts_id_fk" FOREIGN KEY ("to_account") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_periods" ADD CONSTRAINT "pay_periods_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_revisions" ADD CONSTRAINT "plan_revisions_period_id_pay_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pay_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_items" ADD CONSTRAINT "planned_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_items" ADD CONSTRAINT "planned_items_period_id_pay_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pay_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_items" ADD CONSTRAINT "recurring_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_period_id_pay_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."pay_periods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_planned_item_id_planned_items_id_fk" FOREIGN KEY ("planned_item_id") REFERENCES "public"."planned_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");