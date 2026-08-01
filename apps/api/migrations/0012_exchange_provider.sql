ALTER TABLE "exchange_ops" ADD COLUMN "provider" text;
--> statement-breakpoint
-- Переносим уже накопленные метки: до этой миграции «где меняли» писали в note — так это поле и
-- было описано в схеме. Терять их нельзя, на них считается сравнение провайдеров. Именно перенос,
-- а не копия: оставленное в обеих колонках значение печаталось бы в истории дважды. Берём только
-- короткие строки — длинная заметка это комментарий к сделке, а не название обменника.
UPDATE "exchange_ops"
SET "provider" = "note", "note" = NULL
WHERE "provider" IS NULL AND "note" IS NOT NULL AND length("note") <= 40;
