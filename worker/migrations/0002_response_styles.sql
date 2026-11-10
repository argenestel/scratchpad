-- Preserve existing settings while backfilling v4 response styles.
UPDATE user_settings
SET data = json_set(data,
  '$.askStyle', COALESCE(json_extract(data, '$.askStyle'), 'comment'),
  '$.readAlongStyle', COALESCE(json_extract(data, '$.readAlongStyle'), 'comment'))
WHERE json_type(data, '$.askStyle') IS NULL OR json_type(data, '$.readAlongStyle') IS NULL;
