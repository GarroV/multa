-- Предложения правок от участника совместного доступа (issue #83).
--
-- ВНИМАНИЕ: drizzle-kit сгенерировал сюда же повторные правки из миграций 0018-0021 (direction,
-- client_key, onboarding_completed_at, снятие plan_revisions_reason_ck) — их снапшот отстал,
-- потому что те миграции писались руками. Повторное применение упало бы на «колонка уже есть»,
-- поэтому лишнее вычищено вручную. Расхождение снапшота заведено отдельным issue.

CREATE TABLE "edit_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"planned_minor" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "edit_proposals_status_ck" CHECK ("edit_proposals"."status" in ('pending','accepted','rejected')),
	CONSTRAINT "edit_proposals_kind_ck" CHECK ("edit_proposals"."target_kind" in ('category','debt','envelope','goal'))
);
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_proposals" ADD CONSTRAINT "edit_proposals_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edit_proposals_ws_status_idx" ON "edit_proposals" USING btree ("workspace_id","status");--> statement-breakpoint
