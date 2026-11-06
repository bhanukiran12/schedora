-- URL parameters an author chose to record (docs/FORMS.md, "URL parameters"). Kept apart from answers:
-- these values come from a link and are unverified. Additive: older releases ignore the column.
ALTER TABLE responses ADD COLUMN attribution TEXT;
