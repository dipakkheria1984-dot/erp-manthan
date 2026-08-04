-- Admin-selectable colour scheme and theme for printed material (spec 9.1).
-- Existing installations keep the monochrome/classic look they print today.
ALTER TABLE "Institute" ADD COLUMN "printColorScheme" TEXT NOT NULL DEFAULT 'monochrome';
ALTER TABLE "Institute" ADD COLUMN "printTheme" TEXT NOT NULL DEFAULT 'classic';
ALTER TABLE "Institute" ADD COLUMN "printAccentHex" TEXT;
